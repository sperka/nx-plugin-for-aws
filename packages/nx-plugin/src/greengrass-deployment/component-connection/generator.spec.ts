/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import connectionGenerator from '../../connection/generator.js';
import { declareDependencies } from '../../utils/declared-dependencies.js';
import { expectHasMetricTags } from '../../utils/metrics.spec.js';
import {
  SHARED_CONSTRUCTS_DEPENDENCIES,
  sharedConstructsGenerator,
} from '../../utils/shared-constructs.js';
import { createTreeUsingTsSolutionSetup } from '../../utils/test.js';
import {
  GREENGRASS_DEPLOYMENT_COMPONENT_CONNECTION_GENERATOR_INFO,
  greengrassDeploymentComponentConnectionGenerator,
} from './generator';

const sharedConstructsSeedDeclaration = declareDependencies()({
  ts: [...SHARED_CONSTRUCTS_DEPENDENCIES],
});

// Mirrors the framework-owned parts of the `components.ts.template` this
// generator's GritQL patterns key off - see
// `greengrass-deployment/files/components/components.ts.template`.
const COMPONENTS_TS_TEMPLATE = `export interface DeploymentComponent {
  readonly componentVersion?: string;
  readonly configurationUpdate?: {
    readonly merge?: Record<string, unknown>;
    readonly reset?: readonly string[];
  };
}

export const components: Record<string, DeploymentComponent> = {
  // 'com.example.MyComponent': { componentVersion: '1.0.0' },
};
`;

describe('greengrass-deployment#component-connection generator', () => {
  let tree: Tree;

  const addDeploymentProject = (name = 'my-deployment') => {
    addProjectConfiguration(tree, `@proj/${name}`, {
      name: `@proj/${name}`,
      root: `packages/${name}`,
      projectType: 'library',
      sourceRoot: `packages/${name}/src`,
      targets: {},
      metadata: { generator: 'greengrass-deployment' } as any,
    });
    tree.write(`packages/${name}/src/components.ts`, COMPONENTS_TS_TEMPLATE);
    return name;
  };

  const addComponentHostProject = (name = 'ts-project') => {
    addProjectConfiguration(tree, name, {
      name,
      root: `packages/${name}`,
      projectType: 'library',
      sourceRoot: `packages/${name}/src`,
      targets: {},
      metadata: {} as any,
    });
    return name;
  };

  /**
   * The component's own `recipe.yaml`, which the connection reads in preference
   * to the frozen project metadata. Both component generators vend it at
   * `<projectRoot>/greengrass/<component>/recipe.yaml`.
   */
  const addRecipe = ({
    project = 'ts-project',
    component = 'my-component',
    componentName = 'com.example.MyComponent',
    componentVersion = '1.0.0',
  }: {
    project?: string;
    component?: string;
    componentName?: string;
    componentVersion?: string;
  } = {}) => {
    tree.write(
      `packages/${project}/greengrass/${component}/recipe.yaml`,
      `RecipeFormatVersion: '2020-01-25'
ComponentName: ${componentName}
ComponentVersion: '${componentVersion}'
ComponentDescription: A component
ComponentPublisher: Example
Manifests:
  - Platform:
      os: linux
      architecture: aarch64
    Lifecycle:
      Run: python3 main.py
`,
    );
  };

  // `iac: null` (rather than `undefined`) opts out of the default - a
  // destructured default only kicks in for a missing or `undefined` value, so
  // `{ iac: undefined }` would silently fall back to `'cdk'` here too.
  const greengrassComponent = ({
    generator = 'py#greengrass-component',
    name = 'my-component',
    componentName = 'com.example.MyComponent',
    componentVersion = '1.0.0',
    iac = 'cdk',
  }: {
    generator?: string;
    name?: string;
    componentName?: string;
    componentVersion?: string;
    iac?: string | null;
  } = {}) => ({
    generator,
    name,
    path: 'greengrass/my-component/main.py',
    componentName,
    componentVersion,
    platform: 'linux-arm64',
    ipc: true,
    ...(iac ? { iac } : {}),
  });

  const componentsPath = (deploymentName = 'my-deployment') =>
    `packages/${deploymentName}/src/components.ts`;

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  it('adds a py#greengrass-component to the deployment component map', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent() as any,
    });

    expect(tree.read(componentsPath(), 'utf-8')).toContain(
      `'com.example.MyComponent': { componentVersion: '1.0.0' }`,
    );
  });

  it('adds a ts#greengrass-component to the deployment component map', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent({
        generator: 'ts#greengrass-component',
        componentName: 'com.example.TsComponent',
      }) as any,
    });

    expect(tree.read(componentsPath(), 'utf-8')).toContain(
      `'com.example.TsComponent': { componentVersion: '1.0.0' }`,
    );
  });

  it('matches the snapshot of the modified components.ts', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent() as any,
    });

    expect(tree.read(componentsPath(), 'utf-8')).toMatchSnapshot();
  });

  it('records the component in the deployment project metadata', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent() as any,
    });

    const config = readProjectConfiguration(tree, `@proj/${deployment}`);
    expect((config.metadata as any).components).toContainEqual(
      expect.objectContaining({
        generator: GREENGRASS_DEPLOYMENT_COMPONENT_CONNECTION_GENERATOR_INFO.id,
        name: 'com.example.MyComponent',
        path: `packages/${project}`,
      }),
    );
  });

  it('is idempotent when re-run with the same inputs', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();

    const run = () =>
      greengrassDeploymentComponentConnectionGenerator(tree, {
        sourceProject: `@proj/${deployment}`,
        targetProject: project,
        targetComponent: greengrassComponent() as any,
      });

    await run();
    const afterFirst = tree.read(componentsPath(), 'utf-8');
    const configAfterFirst = readProjectConfiguration(
      tree,
      `@proj/${deployment}`,
    );

    await run();

    expect(tree.read(componentsPath(), 'utf-8')).toEqual(afterFirst);
    expect(readProjectConfiguration(tree, `@proj/${deployment}`)).toEqual(
      configAfterFirst,
    );
  });

  it('is additive when a second, differently-named component is connected', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent() as any,
    });
    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent({
        name: 'other-component',
        componentName: 'com.example.OtherComponent',
        componentVersion: '2.0.0',
      }) as any,
    });

    const content = tree.read(componentsPath(), 'utf-8');
    expect(content).toContain(
      `'com.example.MyComponent': { componentVersion: '1.0.0' }`,
    );
    expect(content).toContain(
      `'com.example.OtherComponent': { componentVersion: '2.0.0' }`,
    );

    const config = readProjectConfiguration(tree, `@proj/${deployment}`);
    expect((config.metadata as any).components).toHaveLength(2);
  });

  it("writes the version the component's recipe.yaml currently declares", async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();
    // The recipe has been bumped since the component was generated, which is
    // the documented way to publish a new version.
    addRecipe({ componentVersion: '1.0.1' });

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent({
        componentVersion: '1.0.0',
      }) as any,
    });

    expect(tree.read(componentsPath(), 'utf-8')).toContain(
      `'com.example.MyComponent': { componentVersion: '1.0.1' }`,
    );
  });

  it('warns and leaves the entry alone when the recipe has moved past it', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();
    addRecipe({ componentVersion: '1.0.0' });

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent() as any,
    });

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    addRecipe({ componentVersion: '2.0.0' });

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent() as any,
    });

    expect(tree.read(componentsPath(), 'utf-8')).toContain(
      `'com.example.MyComponent': { componentVersion: '1.0.0' }`,
    );
    expect(tree.read(componentsPath(), 'utf-8')).not.toContain('2.0.0');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `'1.0.0', but its recipe.yaml now declares '2.0.0'`,
      ),
    );
    warn.mockRestore();
  });

  it("keeps the map's comments when adding the first component", async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();
    tree.write(
      componentsPath(),
      COMPONENTS_TS_TEMPLATE.replace(
        `  // 'com.example.MyComponent': { componentVersion: '1.0.0' },`,
        '  // TODO add the sensor component once its recipe lands',
      ),
    );

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent() as any,
    });

    const content = tree.read(componentsPath(), 'utf-8');
    expect(content).toContain(
      '// TODO add the sensor component once its recipe lands',
    );
    expect(content).toContain(
      `'com.example.MyComponent': { componentVersion: '1.0.0' }`,
    );
  });

  it("adds a component whose name appears inside another component's configuration", async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();
    tree.write(
      componentsPath(),
      COMPONENTS_TS_TEMPLATE.replace(
        `  // 'com.example.MyComponent': { componentVersion: '1.0.0' },`,
        `  'com.example.Other': {
    componentVersion: '1.0.0',
    configurationUpdate: { merge: { peer: 'com.example.MyComponent' } },
  },`,
      ),
    );

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent() as any,
    });

    expect(tree.read(componentsPath(), 'utf-8')).toContain(
      `'com.example.MyComponent': { componentVersion: '1.0.0' }`,
    );
  });

  it('throws when the components declaration is no longer recognised', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();
    tree.write(
      componentsPath(),
      `export const components = {} satisfies Record<string, unknown>;\n`,
    );

    await expect(
      greengrassDeploymentComponentConnectionGenerator(tree, {
        sourceProject: `@proj/${deployment}`,
        targetProject: project,
        targetComponent: greengrassComponent() as any,
      }),
    ).rejects.toThrow(/Add the entry by hand/);

    // No metadata is recorded for a connection that was not written.
    const config = readProjectConfiguration(tree, `@proj/${deployment}`);
    expect((config.metadata as any)?.components ?? []).toEqual([]);
  });

  it('throws when the component was generated with --infra none', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();

    await expect(
      greengrassDeploymentComponentConnectionGenerator(tree, {
        sourceProject: `@proj/${deployment}`,
        targetProject: project,
        targetComponent: greengrassComponent({ iac: null }) as any,
      }),
    ).rejects.toThrow(/--infra component-version/);
  });

  it('throws when the target has no Greengrass component metadata', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();

    await expect(
      greengrassDeploymentComponentConnectionGenerator(tree, {
        sourceProject: `@proj/${deployment}`,
        targetProject: project,
      }),
    ).rejects.toThrow(/no Greengrass component metadata/);
  });

  it('throws when the source project was not generated by greengrass-deployment', async () => {
    const project = addComponentHostProject('not-a-deployment');
    addProjectConfiguration(tree, '@proj/not-a-deployment-either', {
      name: '@proj/not-a-deployment-either',
      root: 'packages/not-a-deployment-either',
      projectType: 'library',
      sourceRoot: 'packages/not-a-deployment-either/src',
      targets: {},
      metadata: {} as any,
    });

    await expect(
      greengrassDeploymentComponentConnectionGenerator(tree, {
        sourceProject: '@proj/not-a-deployment-either',
        targetProject: project,
        targetComponent: greengrassComponent() as any,
      }),
    ).rejects.toThrow(/was not generated by the 'greengrass-deployment'/);
  });

  it('should add generator metric to app.ts', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();
    await sharedConstructsGenerator(
      tree,
      { iac: 'cdk' },
      sharedConstructsSeedDeclaration,
    );

    await greengrassDeploymentComponentConnectionGenerator(tree, {
      sourceProject: `@proj/${deployment}`,
      targetProject: project,
      targetComponent: greengrassComponent() as any,
    });

    expectHasMetricTags(
      tree,
      GREENGRASS_DEPLOYMENT_COMPONENT_CONNECTION_GENERATOR_INFO.metric,
    );
  });

  it('throws an ambiguous-connection error when the target has multiple Greengrass components', async () => {
    const deployment = addDeploymentProject();
    const project = addComponentHostProject();
    updateProjectConfiguration(tree, project, {
      ...readProjectConfiguration(tree, project),
      metadata: {
        components: [
          greengrassComponent({ name: 'component-a' }),
          greengrassComponent({
            name: 'component-b',
            componentName: 'com.example.ComponentB',
          }),
        ],
      } as any,
    });

    await expect(
      connectionGenerator(tree, {
        sourceProject: `@proj/${deployment}`,
        targetProject: project,
      }),
    ).rejects.toThrow(/Ambiguous connection/);
  });
});
