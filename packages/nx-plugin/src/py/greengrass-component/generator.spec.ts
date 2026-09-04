/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { parse } from '@iarna/toml';
import { type Tree, updateJson } from '@nx/devkit';
import { declareDependencies } from '../../utils/declared-dependencies.js';
import { expectHasMetricTags } from '../../utils/metrics.spec.js';
import type { UVPyprojectToml } from '../../utils/nxlv-python.js';
import { sortObjectKeys } from '../../utils/object.js';
import {
  SHARED_CONSTRUCTS_DEPENDENCIES,
  sharedConstructsGenerator,
} from '../../utils/shared-constructs.js';
import { createTreeUsingTsSolutionSetup } from '../../utils/test.js';
import {
  PY_GREENGRASS_COMPONENT_GENERATOR_INFO,
  pyGreengrassComponentGenerator,
} from './generator.js';

const sharedConstructsSeedDeclaration = declareDependencies()({
  ts: [...SHARED_CONSTRUCTS_DEPENDENCIES],
});

const seedPythonProject = (
  tree: Tree,
  overrides: { requiresPython?: string } = {},
) => {
  tree.write(
    'apps/test_project/project.json',
    JSON.stringify({
      name: 'test-project',
      root: 'apps/test_project',
      sourceRoot: 'apps/test_project/test_project',
      targets: {},
    }),
  );
  tree.write(
    'apps/test_project/pyproject.toml',
    `[project]
name = "test_project"
version = "0.1.0"
dependencies = []
${overrides.requiresPython ? `requires-python = "${overrides.requiresPython}"\n` : ''}`,
  );
};

describe('py#greengrass-component generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  it('should generate a greengrass component with the correct structure', async () => {
    seedPythonProject(tree, { requiresPython: '>=3.14' });

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
    });

    expect(
      tree.exists('apps/test_project/greengrass/my-component/recipe.yaml'),
    ).toBeTruthy();
    expect(
      tree.exists('apps/test_project/greengrass/my-component/gdk-config.json'),
    ).toBeTruthy();
    expect(
      tree.exists('apps/test_project/greengrass/my-component/main.py'),
    ).toBeTruthy();
    expect(
      tree.exists('apps/test_project/tests/greengrass/test_my_component.py'),
    ).toBeTruthy();

    const recipe = tree.read(
      'apps/test_project/greengrass/my-component/recipe.yaml',
      'utf-8',
    );
    expect(recipe).toContain("RecipeFormatVersion: '2020-01-25'");
    expect(recipe).toContain('ComponentName: com.proj.MyComponent');
    expect(recipe).toContain('ComponentVersion: 1.0.0');
    expect(recipe).toContain(
      'Run: python3 {artifacts:decompressedPath}/my-component/main.py',
    );
    // The load-bearing invariant: the artifact Greengrass unarchives is named
    // after the zip `<c>-artifact` writes, which is what makes the
    // `{artifacts:decompressedPath}/<c>/` path in the Run script resolve.
    expect(recipe).toContain(
      'Uri: s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component.zip',
    );
    expect(recipe).toContain('Unarchive: ZIP');
    // Default ipc=true wires the least-privilege accessControl block.
    expect(recipe).toContain('aws.greengrass.ipc.pubsub');
    expect(recipe).toContain('aws.greengrass#PublishToTopic');

    const mainPy = tree.read(
      'apps/test_project/greengrass/my-component/main.py',
      'utf-8',
    );
    expect(mainPy).toContain('GreengrassCoreIPCClientV2');

    const pyprojectToml = parse(
      tree.read('apps/test_project/pyproject.toml', 'utf-8'),
    ) as UVPyprojectToml;
    expect(
      pyprojectToml.project.dependencies.some((dep) =>
        dep.startsWith('awsiotsdk=='),
      ),
    ).toBe(true);
  });

  it('should vendor python dependencies using the requires-python floor and selected platform', async () => {
    seedPythonProject(tree, { requiresPython: '>=3.11' });

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      platform: 'linux-amd64',
    });

    const projectConfig = JSON.parse(
      tree.read('apps/test_project/project.json', 'utf-8'),
    );
    const commands =
      projectConfig.targets['my-component-vendor'].options.commands;
    expect(commands[0]).toContain('--package test-project');
    expect(commands[0]).toContain('--no-emit-project');
    expect(commands[1]).toContain('--python-version 3.11');
    expect(commands[1]).toContain('--python-platform x86_64-manylinux_2_28');
    expect(commands[1]).toContain('--only-binary :all:');

    const recipe = tree.read(
      'apps/test_project/greengrass/my-component/recipe.yaml',
      'utf-8',
    );
    expect(recipe).toContain('architecture: amd64');
  });

  it('should wire the four component targets with the correct dependencies', async () => {
    seedPythonProject(tree);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
    });

    const projectConfig = JSON.parse(
      tree.read('apps/test_project/project.json', 'utf-8'),
    );
    const targets = projectConfig.targets;

    expect(targets['my-component-vendor']).toBeDefined();
    expect(targets['my-component-vendor'].dependsOn).toEqual(['compile']);
    expect(targets['my-component-vendor'].outputs).toEqual([
      '{workspaceRoot}/dist/{projectRoot}/greengrass/my-component/vendor',
    ]);

    expect(targets['my-component-artifact']).toBeDefined();
    expect(targets['my-component-artifact'].dependsOn).toEqual([
      'my-component-vendor',
    ]);
    expect(targets['my-component-artifact'].options.command).toContain(
      'build-artifact.ts',
    );

    expect(targets['my-component-deploy-local']).toBeDefined();
    expect(targets['my-component-deploy-local'].dependsOn).toEqual([
      'my-component-artifact',
    ]);
    expect(targets['my-component-deploy-local'].options.command).toContain(
      'deploy-local.ts',
    );

    expect(targets['my-component-logs']).toBeDefined();
    expect(targets['my-component-logs'].continuous).toBe(true);
    expect(targets['my-component-logs'].options.command).toContain(
      'component-logs.ts',
    );

    // The artifact is wired onto both build and assemble.
    expect(targets.build.dependsOn).toContain('my-component-artifact');
    expect(targets.assemble.dependsOn).toContain('my-component-artifact');

    // Never wired into the project dev target — deploy-local mutates a real device.
    expect(targets.dev).toBeUndefined();
  });

  it('should not wire the IPC client or accessControl block when ipc is false', async () => {
    seedPythonProject(tree);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      ipc: false,
    });

    const recipe = tree.read(
      'apps/test_project/greengrass/my-component/recipe.yaml',
      'utf-8',
    );
    expect(recipe).not.toContain('accessControl');

    const mainPy = tree.read(
      'apps/test_project/greengrass/my-component/main.py',
      'utf-8',
    );
    expect(mainPy).not.toContain('GreengrassCoreIPCClientV2');

    const pyprojectToml = parse(
      tree.read('apps/test_project/pyproject.toml', 'utf-8'),
    ) as UVPyprojectToml;
    expect(
      (pyprojectToml.project.dependencies ?? []).some((dep) =>
        dep.startsWith('awsiotsdk'),
      ),
    ).toBe(false);
  });

  it('should be a clean no-op when re-run with the same options', async () => {
    seedPythonProject(tree);

    const options = { project: 'test-project', name: 'my-component' };
    await pyGreengrassComponentGenerator(tree, options);

    const recipePath = 'apps/test_project/greengrass/my-component/recipe.yaml';
    const mainPath = 'apps/test_project/greengrass/my-component/main.py';

    // Simulate user edits to the user-owned recipe and handler.
    const customRecipe = '# hand-edited recipe\n';
    const customMain = '# hand-edited handler\n';
    tree.write(recipePath, customRecipe);
    tree.write(mainPath, customMain);

    await pyGreengrassComponentGenerator(tree, options);

    expect(tree.read(recipePath, 'utf-8')).toBe(customRecipe);
    expect(tree.read(mainPath, 'utf-8')).toBe(customMain);

    const projectConfig = JSON.parse(
      tree.read('apps/test_project/project.json', 'utf-8'),
    );
    expect(projectConfig.metadata.components).toHaveLength(1);
    expect(
      Object.keys(projectConfig.targets).filter((t) =>
        t.startsWith('my-component-'),
      ),
    ).toHaveLength(4);
  });

  it('should leave an existing component untouched when a second, differently-named component is added', async () => {
    seedPythonProject(tree);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'first-component',
    });

    const firstRecipePath =
      'apps/test_project/greengrass/first-component/recipe.yaml';
    const firstRecipeBefore = tree.read(firstRecipePath, 'utf-8');

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'second-component',
    });

    expect(tree.read(firstRecipePath, 'utf-8')).toBe(firstRecipeBefore);
    expect(
      tree.exists('apps/test_project/greengrass/second-component/recipe.yaml'),
    ).toBeTruthy();

    // Distinct test module basenames: pytest imports a test module by basename,
    // so two components sharing `test_main.py` would collide on collection.
    expect(
      tree.exists('apps/test_project/tests/greengrass/test_first_component.py'),
    ).toBeTruthy();
    expect(
      tree.exists(
        'apps/test_project/tests/greengrass/test_second_component.py',
      ),
    ).toBeTruthy();

    const projectConfig = JSON.parse(
      tree.read('apps/test_project/project.json', 'utf-8'),
    );
    expect(projectConfig.metadata.components).toHaveLength(2);
    expect(projectConfig.targets['first-component-vendor']).toBeDefined();
    expect(projectConfig.targets['second-component-vendor']).toBeDefined();
  });

  it('should converge the framework-owned gdk-config.json while preserving the user-owned recipe', async () => {
    seedPythonProject(tree);

    const options = { project: 'test-project', name: 'my-component' };
    await pyGreengrassComponentGenerator(tree, options);

    const gdkPath = 'apps/test_project/greengrass/my-component/gdk-config.json';
    tree.write(gdkPath, '{ "hand-edited": true }');

    await pyGreengrassComponentGenerator(tree, options);

    // gdk-config.json is fully derived from the options, so it is regenerated.
    const gdkConfig = JSON.parse(tree.read(gdkPath, 'utf-8'));
    expect(gdkConfig.component['com.proj.MyComponent'].build.build_system).toBe(
      'custom',
    );
    expect(
      gdkConfig.component['com.proj.MyComponent'].build.custom_build_command,
    ).toEqual(['nx', 'run', 'test-project:my-component-artifact']);
  });

  it('should record exact component metadata on project.json', async () => {
    seedPythonProject(tree);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      componentVersion: '2.3.4',
      platform: 'linux-amd64',
      ipc: false,
    });

    const projectConfig = JSON.parse(
      tree.read('apps/test_project/project.json', 'utf-8'),
    );
    expect(projectConfig.metadata.components).toHaveLength(1);
    expect(projectConfig.metadata.components[0]).toEqual({
      generator: PY_GREENGRASS_COMPONENT_GENERATOR_INFO.id,
      path: 'greengrass/my-component/main.py',
      name: 'my-component',
      componentName: 'com.proj.MyComponent',
      componentVersion: '2.3.4',
      platform: 'linux-amd64',
      ipc: false,
    });
  });

  it('should reject a componentName using the reserved aws.greengrass. prefix', async () => {
    seedPythonProject(tree);

    await expect(
      pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        componentName: 'aws.greengrass.MyComponent',
      }),
    ).rejects.toThrow(/reserves/i);
  });

  it('should reject a componentName with invalid characters', async () => {
    seedPythonProject(tree);

    await expect(
      pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        componentName: 'com/invalid name!',
      }),
    ).rejects.toThrow(/must match/i);
  });

  it('should reject a non-semver componentVersion', async () => {
    seedPythonProject(tree);

    await expect(
      pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        componentVersion: 'not-a-version',
      }),
    ).rejects.toThrow(/semantic version/i);
  });

  it('should use greengrass.publisher from aws-nx-plugin.config.mts when set', async () => {
    seedPythonProject(tree);
    tree.write(
      'aws-nx-plugin.config.mts',
      `export default { greengrass: { publisher: 'Acme Corp' } } satisfies import('@aws/nx-plugin').AwsNxPluginConfig;\n`,
    );

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
    });

    const recipe = tree.read(
      'apps/test_project/greengrass/my-component/recipe.yaml',
      'utf-8',
    );
    expect(recipe).toContain('ComponentPublisher: Acme Corp');
  });

  it('should fall back to the workspace npm scope for the publisher', async () => {
    updateJson(tree, 'package.json', (packageJson) => ({
      ...packageJson,
      name: '@my-scope/source',
    }));
    seedPythonProject(tree);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
    });

    const recipe = tree.read(
      'apps/test_project/greengrass/my-component/recipe.yaml',
      'utf-8',
    );
    expect(recipe).toContain('ComponentPublisher: my-scope');
    expect(recipe).toContain('ComponentName: com.my-scope.MyComponent');
  });

  it('should throw an actionable error for a non-python project', async () => {
    tree.write(
      'apps/ts_project/project.json',
      JSON.stringify({
        name: 'ts-project',
        root: 'apps/ts_project',
        sourceRoot: 'apps/ts_project/src',
        targets: {},
      }),
    );

    await expect(
      pyGreengrassComponentGenerator(tree, {
        project: 'ts-project',
        name: 'my-component',
      }),
    ).rejects.toThrow(/python project/i);
  });

  it('should add the generator metric', async () => {
    await sharedConstructsGenerator(
      tree,
      { iac: 'cdk' },
      sharedConstructsSeedDeclaration,
    );
    seedPythonProject(tree);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
    });

    expectHasMetricTags(tree, PY_GREENGRASS_COMPONENT_GENERATOR_INFO.metric);
  });

  it('should match snapshot', async () => {
    seedPythonProject(tree, { requiresPython: '>=3.14' });

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
    });

    const changes = sortObjectKeys(
      tree
        .listChanges()
        .filter(
          (f) =>
            f.path.endsWith('.py') ||
            f.path.endsWith('.yaml') ||
            f.path.endsWith('gdk-config.json') ||
            f.path.endsWith('project.json'),
        )
        .reduce((acc, curr) => {
          acc[curr.path] = tree.read(curr.path, 'utf-8');
          return acc;
        }, {}),
    );
    expect(changes).toMatchSnapshot('main-snapshot');
  });
});
