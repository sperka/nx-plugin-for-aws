/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { addProjectConfiguration, type Tree, updateJson } from '@nx/devkit';
import { declareDependencies } from '../../utils/declared-dependencies.js';
import { expectHasMetricTags } from '../../utils/metrics.spec.js';
import { sortObjectKeys } from '../../utils/object.js';
import {
  SHARED_CONSTRUCTS_DEPENDENCIES,
  sharedConstructsGenerator,
} from '../../utils/shared-constructs.js';
import {
  expectTypeScriptToParse,
  TypeScriptVerifier,
} from '../../utils/test/ts.spec.js';
import { createTreeUsingTsSolutionSetup } from '../../utils/test.js';
import {
  TS_GREENGRASS_COMPONENT_GENERATOR_INFO,
  tsGreengrassComponentGenerator,
} from './generator.js';

const sharedConstructsSeedDeclaration = declareDependencies()({
  ts: [...SHARED_CONSTRUCTS_DEPENDENCIES],
});

const seedTypeScriptProject = (tree: Tree) => {
  addProjectConfiguration(tree, 'test-project', {
    name: 'test-project',
    root: 'packages/test-project',
    sourceRoot: 'packages/test-project/src',
    targets: {
      compile: {
        executor: '@nx/js:tsc',
      },
    },
  });
  tree.write('packages/test-project/tsconfig.json', '{}');
  tree.write(
    'packages/test-project/package.json',
    JSON.stringify({ name: '@proj/test-project', type: 'module' }),
  );
  tree.write('packages/test-project/src/index.ts', 'export {};');
};

describe('ts#greengrass-component generator', () => {
  let tree: Tree;
  // Only exercised against ipc=false: main.ts's ipc=true branch imports
  // aws-iot-device-sdk-v2, which is not installed in this workspace (it is
  // only ever vended into a generated user workspace, not consumed by the
  // plugin's own tests), so it cannot be loaded into the verifier's project.
  // That branch gets `expectTypeScriptToParse` instead.
  const verifier = new TypeScriptVerifier();

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  it('should generate a greengrass component with the correct structure', async () => {
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
    });

    expect(
      tree.exists('packages/test-project/greengrass/my-component/recipe.yaml'),
    ).toBeTruthy();
    expect(
      tree.exists(
        'packages/test-project/greengrass/my-component/gdk-config.json',
      ),
    ).toBeTruthy();
    expect(
      tree.exists('packages/test-project/src/greengrass/my-component/main.ts'),
    ).toBeTruthy();
    // ipc defaults to false, so no Install lifecycle manifest is vended.
    expect(
      tree.exists('packages/test-project/greengrass/my-component/package.json'),
    ).toBeFalsy();

    const recipe = tree.read(
      'packages/test-project/greengrass/my-component/recipe.yaml',
      'utf-8',
    );
    expect(recipe).toContain("RecipeFormatVersion: '2020-01-25'");
    expect(recipe).toContain('ComponentName: com.proj.MyComponent');
    expect(recipe).toContain('ComponentVersion: 1.0.0');
    // The load-bearing invariant: the artifact Greengrass unarchives is named
    // after the zip `<c>-artifact` writes, which is what makes the
    // `{artifacts:decompressedPath}/<c>/` path in the Run script resolve.
    expect(recipe).toContain(
      'Run: node {artifacts:decompressedPath}/my-component/index.js',
    );
    expect(recipe).toContain(
      'Uri: s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component.zip',
    );
    expect(recipe).toContain('Unarchive: ZIP');
    expect(recipe).not.toContain('accessControl');
    expect(recipe).not.toContain('Install:');

    const mainTs = tree.read(
      'packages/test-project/src/greengrass/my-component/main.ts',
      'utf-8',
    );
    expect(mainTs).not.toContain('aws-iot-device-sdk-v2');
    verifier.expectTypeScriptToCompile(tree, [
      'packages/test-project/src/greengrass/my-component/main.ts',
    ]);
  });

  it('should wire the IPC client, accessControl block and Install lifecycle when ipc is true', async () => {
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      ipc: true,
      infra: 'none',
    });

    const recipe = tree.read(
      'packages/test-project/greengrass/my-component/recipe.yaml',
      'utf-8',
    );
    expect(recipe).toContain('aws.greengrass.ipc.pubsub');
    expect(recipe).toContain('aws.greengrass#PublishToTopic');
    // npm ci requires a package-lock.json this generator does not vend, so
    // the Install step must use npm install, not npm ci.
    expect(recipe).toContain(
      'Install: cd {artifacts:decompressedPath}/my-component && npm install --omit=dev',
    );

    const mainTs = tree.read(
      'packages/test-project/src/greengrass/my-component/main.ts',
      'utf-8',
    );
    expect(mainTs).toContain(
      "import { greengrasscoreipc } from 'aws-iot-device-sdk-v2';",
    );
    expect(mainTs).toContain('greengrasscoreipc.createClient()');
    // Syntax only - aws-iot-device-sdk-v2 is never installed here, so the
    // verifier cannot type check this branch.
    expectTypeScriptToParse(tree, [
      'packages/test-project/src/greengrass/my-component/main.ts',
    ]);

    const packageJson = JSON.parse(
      tree.read(
        'packages/test-project/greengrass/my-component/package.json',
        'utf-8',
      ),
    );
    expect(packageJson.dependencies['aws-iot-device-sdk-v2']).toBeDefined();

    const projectPackageJson = JSON.parse(
      tree.read('packages/test-project/package.json', 'utf-8'),
    );
    expect(
      projectPackageJson.dependencies['aws-iot-device-sdk-v2'],
    ).toBeDefined();
  });

  it('should not add aws-iot-device-sdk-v2 to the project package.json when ipc is false', async () => {
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
    });

    const projectPackageJson = JSON.parse(
      tree.read('packages/test-project/package.json', 'utf-8'),
    );
    expect(
      projectPackageJson.dependencies?.['aws-iot-device-sdk-v2'],
    ).toBeUndefined();
  });

  it('should wire the bundle target with rolldown, marking aws-iot-device-sdk-v2 external when ipc is true', async () => {
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      ipc: true,
      infra: 'none',
    });

    const projectConfig = JSON.parse(
      tree.read('packages/test-project/project.json', 'utf-8'),
    );
    expect(projectConfig.targets.bundle).toBeDefined();
    expect(projectConfig.targets.bundle.executor).toBe('nx:run-commands');
    expect(projectConfig.targets.bundle.options.command).toBe(
      'rolldown -c rolldown.config.ts',
    );

    const rolldownConfig = tree.read(
      'packages/test-project/rolldown.config.ts',
      'utf-8',
    );
    expect(rolldownConfig).toContain('src/greengrass/my-component/main.ts');
    expect(rolldownConfig).toContain(
      '../../dist/packages/test-project/bundle/greengrass/my-component/index.js',
    );
    expect(rolldownConfig).toContain("external: ['aws-iot-device-sdk-v2']");
    expect(rolldownConfig).toContain("platform: 'node'");
  });

  it('should not mark anything external when ipc is false', async () => {
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
    });

    const rolldownConfig = tree.read(
      'packages/test-project/rolldown.config.ts',
      'utf-8',
    );
    expect(rolldownConfig).not.toContain('external:');
  });

  it('should wire the artifact, deploy-local and logs targets with the correct dependencies', async () => {
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
    });

    const projectConfig = JSON.parse(
      tree.read('packages/test-project/project.json', 'utf-8'),
    );
    const targets = projectConfig.targets;

    expect(targets['my-component-artifact']).toBeDefined();
    expect(targets['my-component-artifact'].dependsOn).toEqual(['bundle']);
    expect(targets['my-component-artifact'].options.command).toContain(
      'build-artifact.ts',
    );
    expect(targets['my-component-artifact'].options.command).toContain(
      'dist/{projectRoot}/bundle/greengrass/my-component',
    );
    // The vended scripts sit outside the project, so the cache key must
    // name them or a refreshed script would serve a stale cached artifact.
    expect(targets['my-component-artifact'].inputs).toContain(
      '{workspaceRoot}/packages/common/scripts/src/greengrass/**/*',
    );
    expect(targets['my-component-artifact'].outputs).toEqual([
      '{workspaceRoot}/dist/{projectRoot}/greengrass/my-component/greengrass-build',
    ]);

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

    // No <c>-vendor target — TypeScript has no analogue to py's Python
    // dependency vendoring step, since rolldown bundles dependencies directly.
    expect(targets['my-component-vendor']).toBeUndefined();
  });

  it('should not duplicate component targets when re-run with the same options', async () => {
    seedTypeScriptProject(tree);

    const options = {
      project: 'test-project',
      name: 'my-component',
      infra: 'none' as const,
    };
    await tsGreengrassComponentGenerator(tree, options);

    const recipePath =
      'packages/test-project/greengrass/my-component/recipe.yaml';
    const mainPath =
      'packages/test-project/src/greengrass/my-component/main.ts';

    // Simulate user edits to the user-owned recipe and entrypoint.
    const customRecipe = '# hand-edited recipe\n';
    const customMain = '// hand-edited handler\n';
    tree.write(recipePath, customRecipe);
    tree.write(mainPath, customMain);

    await tsGreengrassComponentGenerator(tree, options);

    expect(tree.read(recipePath, 'utf-8')).toBe(customRecipe);
    expect(tree.read(mainPath, 'utf-8')).toBe(customMain);

    const projectConfig = JSON.parse(
      tree.read('packages/test-project/project.json', 'utf-8'),
    );
    expect(projectConfig.metadata.components).toHaveLength(1);
    expect(
      Object.keys(projectConfig.targets).filter((t) =>
        t.startsWith('my-component-'),
      ),
    ).toHaveLength(3);
    // The targets are re-assigned on every run, so the dedupe helper is the only
    // thing keeping build/assemble from growing a second artifact dependency.
    expect(
      projectConfig.targets.build.dependsOn.filter(
        (d: string) => d === 'my-component-artifact',
      ),
    ).toHaveLength(1);
    expect(
      projectConfig.targets.assemble.dependsOn.filter(
        (d: string) => d === 'my-component-artifact',
      ),
    ).toHaveLength(1);
    // Re-running must not append a second rolldown entry for the same file.
    const rolldownConfig = tree.read(
      'packages/test-project/rolldown.config.ts',
      'utf-8',
    );
    expect(
      rolldownConfig.match(/src\/greengrass\/my-component\/main\.ts/g),
    ).toHaveLength(1);
  });

  it('should converge component targets while preserving user-owned files', async () => {
    seedTypeScriptProject(tree);

    const options = {
      project: 'test-project',
      name: 'my-component',
      infra: 'none' as const,
    };
    await tsGreengrassComponentGenerator(tree, options);

    // A target left behind by an older version of this generator.
    updateJson(tree, 'packages/test-project/project.json', (projectConfig) => ({
      ...projectConfig,
      targets: {
        ...projectConfig.targets,
        'my-component-artifact': {
          ...projectConfig.targets['my-component-artifact'],
          options: { command: 'echo stale artifact command' },
        },
      },
    }));

    const recipePath =
      'packages/test-project/greengrass/my-component/recipe.yaml';
    const mainPath =
      'packages/test-project/src/greengrass/my-component/main.ts';
    const customRecipe = '# hand-edited recipe\n';
    const customMain = '// hand-edited handler\n';
    tree.write(recipePath, customRecipe);
    tree.write(mainPath, customMain);

    await tsGreengrassComponentGenerator(tree, options);

    const projectConfig = JSON.parse(
      tree.read('packages/test-project/project.json', 'utf-8'),
    );
    const artifactCommand =
      projectConfig.targets['my-component-artifact'].options.command;
    expect(artifactCommand).toContain('build-artifact.ts');
    expect(artifactCommand).not.toContain('stale artifact command');
    expect(tree.read(recipePath, 'utf-8')).toBe(customRecipe);
    expect(tree.read(mainPath, 'utf-8')).toBe(customMain);
  });

  it('should converge the framework-owned gdk-config.json while preserving the user-owned recipe', async () => {
    seedTypeScriptProject(tree);

    const options = {
      project: 'test-project',
      name: 'my-component',
      infra: 'none' as const,
    };
    await tsGreengrassComponentGenerator(tree, options);

    const gdkPath =
      'packages/test-project/greengrass/my-component/gdk-config.json';
    tree.write(gdkPath, '{ "hand-edited": true }');

    await tsGreengrassComponentGenerator(tree, options);

    const gdkConfig = JSON.parse(tree.read(gdkPath, 'utf-8'));
    expect(gdkConfig.component['com.proj.MyComponent'].build.build_system).toBe(
      'custom',
    );
    expect(
      gdkConfig.component['com.proj.MyComponent'].build.custom_build_command,
    ).toEqual(['nx', 'run', 'test-project:my-component-artifact']);
  });

  it('should leave an existing component untouched when a second, differently-named component is added', async () => {
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'first-component',
      infra: 'none',
    });

    const firstRecipePath =
      'packages/test-project/greengrass/first-component/recipe.yaml';
    const firstRecipeBefore = tree.read(firstRecipePath, 'utf-8');

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'second-component',
      infra: 'none',
    });

    expect(tree.read(firstRecipePath, 'utf-8')).toBe(firstRecipeBefore);
    expect(
      tree.exists(
        'packages/test-project/greengrass/second-component/recipe.yaml',
      ),
    ).toBeTruthy();
    expect(
      tree.exists(
        'packages/test-project/src/greengrass/second-component/main.ts',
      ),
    ).toBeTruthy();

    const projectConfig = JSON.parse(
      tree.read('packages/test-project/project.json', 'utf-8'),
    );
    expect(projectConfig.metadata.components).toHaveLength(2);
    expect(projectConfig.targets['first-component-artifact']).toBeDefined();
    expect(projectConfig.targets['second-component-artifact']).toBeDefined();

    const rolldownConfig = tree.read(
      'packages/test-project/rolldown.config.ts',
      'utf-8',
    );
    expect(rolldownConfig).toContain('src/greengrass/first-component/main.ts');
    expect(rolldownConfig).toContain('src/greengrass/second-component/main.ts');
  });

  it('should record exact component metadata on project.json', async () => {
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      componentVersion: '2.3.4',
      platform: 'linux-amd64',
      ipc: true,
      infra: 'none',
    });

    const projectConfig = JSON.parse(
      tree.read('packages/test-project/project.json', 'utf-8'),
    );
    expect(projectConfig.metadata.components).toHaveLength(1);
    expect(projectConfig.metadata.components[0]).toEqual({
      generator: TS_GREENGRASS_COMPONENT_GENERATOR_INFO.id,
      path: 'src/greengrass/my-component/main.ts',
      name: 'my-component',
      componentName: 'com.proj.MyComponent',
      componentVersion: '2.3.4',
      platform: 'linux-amd64',
      ipc: true,
    });
  });

  it('should reject a componentName using the reserved aws.greengrass. prefix', async () => {
    seedTypeScriptProject(tree);

    await expect(
      tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        componentName: 'aws.greengrass.MyComponent',
      }),
    ).rejects.toThrow(/reserves/i);
  });

  it('should reject a componentName with invalid characters', async () => {
    seedTypeScriptProject(tree);

    await expect(
      tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        componentName: 'com/invalid name!',
      }),
    ).rejects.toThrow(/must match/i);
  });

  it('should reject a non-semver componentVersion', async () => {
    seedTypeScriptProject(tree);

    await expect(
      tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        componentVersion: 'not-a-version',
      }),
    ).rejects.toThrow(/semantic version/i);
  });

  it('should use greengrass.publisher from aws-nx-plugin.config.mts when set', async () => {
    seedTypeScriptProject(tree);
    tree.write(
      'aws-nx-plugin.config.mts',
      `export default { greengrass: { publisher: 'Acme Corp' } } satisfies import('@aws/nx-plugin').AwsNxPluginConfig;\n`,
    );

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
    });

    const recipe = tree.read(
      'packages/test-project/greengrass/my-component/recipe.yaml',
      'utf-8',
    );
    expect(recipe).toContain('ComponentPublisher: Acme Corp');
  });

  it('should fall back to the workspace npm scope for the publisher', async () => {
    updateJson(tree, 'package.json', (packageJson) => ({
      ...packageJson,
      name: '@my-scope/source',
    }));
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
    });

    const recipe = tree.read(
      'packages/test-project/greengrass/my-component/recipe.yaml',
      'utf-8',
    );
    expect(recipe).toContain('ComponentPublisher: my-scope');
    expect(recipe).toContain('ComponentName: com.my-scope.MyComponent');
  });

  it('should throw an actionable error for a non-typescript project', async () => {
    tree.write(
      'apps/py_project/project.json',
      JSON.stringify({
        name: 'py-project',
        root: 'apps/py_project',
        sourceRoot: 'apps/py_project/py_project',
        targets: {},
      }),
    );

    await expect(
      tsGreengrassComponentGenerator(tree, {
        project: 'py-project',
        name: 'my-component',
      }),
    ).rejects.toThrow(/typescript project/i);
  });

  it('should add the generator metric', async () => {
    await sharedConstructsGenerator(
      tree,
      { iac: 'cdk' },
      sharedConstructsSeedDeclaration,
    );
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
    });

    expectHasMetricTags(tree, TS_GREENGRASS_COMPONENT_GENERATOR_INFO.metric);
  });

  it('should match snapshot', async () => {
    seedTypeScriptProject(tree);

    await tsGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
    });

    const changes = sortObjectKeys(
      tree
        .listChanges()
        .filter(
          (f) =>
            f.path.endsWith('.ts') ||
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

  describe('infra escalation (--infra component-version)', () => {
    it('vends the per-component construct and registers the artifact dependency', async () => {
      seedTypeScriptProject(tree);

      await tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        iac: 'cdk',
      });

      const constructPath =
        'packages/common/constructs/src/app/greengrass/my-component.ts';
      expect(tree.exists(constructPath)).toBe(true);
      const construct = tree.read(constructPath, 'utf-8');
      expect(construct).toContain('extends GreengrassComponentVersion');
      expect(construct).toContain(
        'packages/test-project/greengrass/my-component/greengrass-build/recipes',
      );
      expect(construct).toContain(
        'packages/test-project/greengrass/my-component/greengrass-build/artifacts',
      );

      for (const file of [
        'artifact-bucket.ts',
        'component-version.ts',
        'deployment.ts',
        'recipe.ts',
      ]) {
        expect(
          tree.exists(`packages/common/constructs/src/core/greengrass/${file}`),
        ).toBe(true);
      }

      const sharedConstructsConfig = JSON.parse(
        tree.read('packages/common/constructs/project.json', 'utf-8') ?? '{}',
      );
      expect(sharedConstructsConfig.targets.build.dependsOn).toContain(
        'test-project:build',
      );
      expect(sharedConstructsConfig.targets.assemble.dependsOn).toContain(
        'test-project:assemble',
      );
    });

    it('escalates cleanly from --infra none to --infra component-version, adding the construct exactly once', async () => {
      seedTypeScriptProject(tree);

      await tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'none',
      });
      expect(tree.exists('packages/common/constructs')).toBe(false);

      const recipePath =
        'packages/test-project/greengrass/my-component/recipe.yaml';
      const recipeBefore = tree.read(recipePath, 'utf-8');

      await tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'component-version',
        iac: 'cdk',
      });

      const constructPath =
        'packages/common/constructs/src/app/greengrass/my-component.ts';
      expect(tree.exists(constructPath)).toBe(true);
      expect(tree.read(recipePath, 'utf-8')).toBe(recipeBefore);

      // Re-running again must not duplicate the star export or the artifact
      // dependency.
      await tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'component-version',
        iac: 'cdk',
      });

      const appIndex = tree.read(
        'packages/common/constructs/src/app/greengrass/index.ts',
        'utf-8',
      );
      expect(appIndex?.match(/my-component\.js/g)).toHaveLength(1);

      const sharedConstructsConfig = JSON.parse(
        tree.read('packages/common/constructs/project.json', 'utf-8') ?? '{}',
      );
      expect(
        sharedConstructsConfig.targets.build.dependsOn.filter(
          (d: string) => d === 'test-project:build',
        ),
      ).toHaveLength(1);

      // The escalation has to record the iac on the entry its first run wrote,
      // which is the only thing the orphan guard reads.
      const projectConfig = JSON.parse(
        tree.read('packages/test-project/project.json', 'utf-8'),
      );
      expect(projectConfig.metadata.components[0].iac).toBe('cdk');
    });

    it('throws on --infra none after an escalation from --infra none provisioned infrastructure', async () => {
      seedTypeScriptProject(tree);

      await tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'none',
      });
      await tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'component-version',
        iac: 'cdk',
      });

      await expect(
        tsGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          infra: 'none',
        }),
      ).rejects.toThrow(/would leave that infrastructure orphaned/);
    });

    it('is a stable no-op when re-run with --infra none both times', async () => {
      seedTypeScriptProject(tree);

      await tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'none',
      });

      // Re-running with the same `--infra none` it already had must not throw
      // - this is the ordinary idempotency contract, not a downgrade attempt.
      await expect(
        tsGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          infra: 'none',
        }),
      ).resolves.toBeDefined();
    });

    it('throws when re-run with --infra none after infrastructure was already provisioned', async () => {
      seedTypeScriptProject(tree);

      await tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        iac: 'cdk',
      });

      await expect(
        tsGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          infra: 'none',
        }),
      ).rejects.toThrow(/would leave that infrastructure orphaned/);
    });

    it('throws an actionable error for --iac terraform', async () => {
      seedTypeScriptProject(tree);

      await expect(
        tsGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          iac: 'terraform',
        }),
      ).rejects.toThrow(/hashicorp\/awscc/);
    });

    it('throws an actionable error when the workspace carries pre-bundle-support vended scripts', async () => {
      seedTypeScriptProject(tree);
      // A build-artifact.ts vended by a plugin version that predates the
      // bundle-dir argument — KeepExisting means it never refreshes on its own.
      tree.write(
        'packages/common/scripts/src/greengrass/build-artifact.ts',
        '// Usage: build-artifact.ts <project-root> <component-dir> <dist>\n',
      );

      await expect(
        tsGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          iac: 'cdk',
        }),
      ).rejects.toThrow(/older plugin version.*Delete the files/s);
    });

    it('records iac in component metadata', async () => {
      seedTypeScriptProject(tree);

      await tsGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        iac: 'cdk',
      });

      const projectConfig = JSON.parse(
        tree.read('packages/test-project/project.json', 'utf-8'),
      );
      expect(projectConfig.metadata.components[0].iac).toBe('cdk');
    });
  });
});
