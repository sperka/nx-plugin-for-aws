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
      infra: 'none',
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
      'Run: python3.14 {artifacts:decompressedPath}/my-component/main.py',
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
      infra: 'none',
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
      infra: 'none',
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
    // The vended scripts sit outside the project, so the cache key must
    // name them or a refreshed script would serve a stale cached artifact.
    expect(targets['my-component-artifact'].inputs).toContain(
      '{workspaceRoot}/packages/common/scripts/src/greengrass/**/*',
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
      infra: 'none',
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

  it('should not duplicate component targets when re-run with the same options', async () => {
    seedPythonProject(tree);

    const options = {
      project: 'test-project',
      name: 'my-component',
      infra: 'none' as const,
    };
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
    // The targets are re-assigned on every run, so the dedupe helper is the only
    // thing keeping build/assemble from growing a second artifact dependency.
    expect(
      projectConfig.targets.build.dependsOn.filter(
        (d) => d === 'my-component-artifact',
      ),
    ).toHaveLength(1);
    expect(
      projectConfig.targets.assemble.dependsOn.filter(
        (d) => d === 'my-component-artifact',
      ),
    ).toHaveLength(1);
  });

  it('should converge component targets while preserving user-owned files', async () => {
    seedPythonProject(tree);

    const options = {
      project: 'test-project',
      name: 'my-component',
      infra: 'none' as const,
    };
    await pyGreengrassComponentGenerator(tree, options);

    // A target left behind by an older version of this generator.
    updateJson(tree, 'apps/test_project/project.json', (projectConfig) => ({
      ...projectConfig,
      targets: {
        ...projectConfig.targets,
        'my-component-vendor': {
          ...projectConfig.targets['my-component-vendor'],
          options: {
            ...projectConfig.targets['my-component-vendor'].options,
            commands: ['echo stale vendor command'],
          },
        },
      },
    }));

    const recipePath = 'apps/test_project/greengrass/my-component/recipe.yaml';
    const mainPath = 'apps/test_project/greengrass/my-component/main.py';
    const customRecipe = '# hand-edited recipe\n';
    const customMain = '# hand-edited handler\n';
    tree.write(recipePath, customRecipe);
    tree.write(mainPath, customMain);

    await pyGreengrassComponentGenerator(tree, options);

    const projectConfig = JSON.parse(
      tree.read('apps/test_project/project.json', 'utf-8'),
    );
    // The stale target is replaced by the current definition.
    const vendorCommand =
      projectConfig.targets['my-component-vendor'].options.commands[0];
    expect(vendorCommand).toContain('uv export');
    expect(vendorCommand).toContain('--no-emit-project');
    expect(vendorCommand).not.toContain('stale vendor command');
    expect(tree.read(recipePath, 'utf-8')).toBe(customRecipe);
    expect(tree.read(mainPath, 'utf-8')).toBe(customMain);
  });

  it('should leave an existing component untouched when a second, differently-named component is added', async () => {
    seedPythonProject(tree);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'first-component',
      infra: 'none',
    });

    const firstRecipePath =
      'apps/test_project/greengrass/first-component/recipe.yaml';
    const firstRecipeBefore = tree.read(firstRecipePath, 'utf-8');

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'second-component',
      infra: 'none',
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

    const options = {
      project: 'test-project',
      name: 'my-component',
      infra: 'none' as const,
    };
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
      infra: 'none',
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
      infra: 'none',
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
      infra: 'none',
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
      infra: 'none',
    });

    expectHasMetricTags(tree, PY_GREENGRASS_COMPONENT_GENERATOR_INFO.metric);
  });

  it('should match snapshot', async () => {
    seedPythonProject(tree, { requiresPython: '>=3.14' });

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
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

  describe('infra escalation (--infra component-version)', () => {
    it('vends the per-component construct and registers the artifact dependency', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
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
        'apps/test_project/greengrass/my-component/greengrass-build/recipes',
      );
      expect(construct).toContain(
        'apps/test_project/greengrass/my-component/greengrass-build/artifacts',
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
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'none',
      });
      expect(tree.exists('packages/common/constructs')).toBe(false);

      const recipePath =
        'apps/test_project/greengrass/my-component/recipe.yaml';
      const recipeBefore = tree.read(recipePath, 'utf-8');

      await pyGreengrassComponentGenerator(tree, {
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
      await pyGreengrassComponentGenerator(tree, {
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
        tree.read('apps/test_project/project.json', 'utf-8'),
      );
      expect(projectConfig.metadata.components[0].iac).toBe('cdk');
    });

    it('throws on --infra none after an escalation from --infra none provisioned infrastructure', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'none',
      });
      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'component-version',
        iac: 'cdk',
      });

      await expect(
        pyGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          infra: 'none',
        }),
      ).rejects.toThrow(/would leave that infrastructure orphaned/);
    });

    it('is a stable no-op when re-run with --infra none both times', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'none',
      });

      // Re-running with the same `--infra none` it already had must not throw
      // - this is the ordinary idempotency contract, not a downgrade attempt.
      await expect(
        pyGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          infra: 'none',
        }),
      ).resolves.toBeDefined();
    });

    it('throws when re-run with --infra none after infrastructure was already provisioned', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        iac: 'cdk',
      });

      await expect(
        pyGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          infra: 'none',
        }),
      ).rejects.toThrow(/would leave that infrastructure orphaned/);
    });

    it('vends the per-component terraform module for --iac terraform', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        iac: 'terraform',
      });

      const modulePath =
        'packages/common/terraform/src/app/greengrass-component/my-component/my-component.tf';
      expect(tree.exists(modulePath)).toBe(true);
      const module = tree.read(modulePath, 'utf-8');
      expect(module).toContain('source = "../../../core/greengrass/component-version"');
      expect(module).toContain(
        'apps/test_project/greengrass/my-component/greengrass-build/recipes',
      );
      expect(module).toContain(
        'apps/test_project/greengrass/my-component/greengrass-build/artifacts',
      );

      for (const dir of ['artifact-bucket', 'component-version', 'deployment']) {
        expect(
          tree.exists(
            `packages/common/terraform/src/core/greengrass/${dir}/main.tf`,
          ),
        ).toBe(true);
      }

      const sharedTerraformConfig = JSON.parse(
        tree.read('packages/common/terraform/project.json', 'utf-8') ?? '{}',
      );
      expect(sharedTerraformConfig.targets.build.dependsOn).toContain(
        'test-project:build',
      );
      expect(sharedTerraformConfig.targets.assemble.dependsOn).toContain(
        'test-project:assemble',
      );
    });

    it('escalates cleanly from --infra none to --infra component-version --iac terraform, adding the module exactly once', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'none',
      });
      expect(tree.exists('packages/common/terraform')).toBe(false);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'component-version',
        iac: 'terraform',
      });

      const modulePath =
        'packages/common/terraform/src/app/greengrass-component/my-component/my-component.tf';
      expect(tree.exists(modulePath)).toBe(true);

      // Re-running again must not duplicate the artifact dependency.
      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'component-version',
        iac: 'terraform',
      });

      const moduleAfterSecondRun = tree.read(modulePath, 'utf-8');
      const sharedTerraformConfig = JSON.parse(
        tree.read('packages/common/terraform/project.json', 'utf-8') ?? '{}',
      );
      expect(
        sharedTerraformConfig.targets.build.dependsOn.filter(
          (d: string) => d === 'test-project:build',
        ),
      ).toHaveLength(1);
      expect(moduleAfterSecondRun).toBe(tree.read(modulePath, 'utf-8'));

      const projectConfig = JSON.parse(
        tree.read('apps/test_project/project.json', 'utf-8'),
      );
      expect(projectConfig.metadata.components[0].iac).toBe('terraform');
    });

    it('records iac in component metadata', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        iac: 'cdk',
      });

      const projectConfig = JSON.parse(
        tree.read('apps/test_project/project.json', 'utf-8'),
      );
      expect(projectConfig.metadata.components[0].iac).toBe('cdk');
    });
  });
});
