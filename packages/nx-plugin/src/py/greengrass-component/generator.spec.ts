/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@iarna/toml';
import { logger, type Tree, updateJson } from '@nx/devkit';
import { FsTree, flushChanges } from 'nx/src/generators/tree';
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
    ).toBeFalsy();
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
    // `uv pip install --target` never prunes, so the vendor dir is emptied
    // first: artifact bytes must not depend on a previous build.
    expect(commands[0]).toBe(
      'shx rm -rf dist/{projectRoot}/greengrass/my-component/vendor',
    );
    expect(commands[1]).toBe(
      'shx mkdir -p dist/{projectRoot}/greengrass/my-component/vendor',
    );
    expect(commands[2]).toContain('--package test-project');
    expect(commands[2]).toContain('--no-emit-project');
    expect(commands[3]).toContain('--python-version 3.11');
    expect(commands[3]).toContain('--python-platform x86_64-manylinux_2_28');
    expect(commands[3]).toContain('--only-binary :all:');

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

  it('should land on the same bytes when it re-runs after py#project re-wrote project.json', async () => {
    // py#project sorts the targets and calls updateProjectConfiguration on
    // every run, without formatting. In a workspace, a same-options re-run of
    // this generator then changes no configuration, so nothing would format
    // the file. The e2e idempotency lane fails on exactly this.
    seedPythonProject(tree);
    const options = {
      project: 'test-project',
      name: 'my-component',
      infra: 'none' as const,
    };
    await pyGreengrassComponentGenerator(tree, options);
    const projectJsonPath = 'apps/test_project/project.json';
    const firstRun = tree.read(projectJsonPath, 'utf-8');

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gg-idempotency-'));
    try {
      flushChanges(tmpDir, tree.listChanges());
      const rewritten = JSON.parse(firstRun);
      rewritten.targets = sortObjectKeys(rewritten.targets);
      writeFileSync(
        path.join(tmpDir, projectJsonPath),
        `${JSON.stringify(rewritten, null, 2)}\n`,
      );
      expect(
        readFileSync(path.join(tmpDir, projectJsonPath), 'utf-8'),
      ).not.toBe(firstRun);

      const fsTree = new FsTree(tmpDir, false);
      await pyGreengrassComponentGenerator(fsTree, options);
      flushChanges(tmpDir, fsTree.listChanges());

      expect(readFileSync(path.join(tmpDir, projectJsonPath), 'utf-8')).toBe(
        firstRun,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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
      projectConfig.targets['my-component-vendor'].options.commands[2];
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

  it('should remove gdk-config.json and log when re-run without --gdkConfig', async () => {
    seedPythonProject(tree);

    const options = {
      project: 'test-project',
      name: 'my-component',
      infra: 'none' as const,
      gdkConfig: true,
    };
    await pyGreengrassComponentGenerator(tree, options);

    const gdkPath = 'apps/test_project/greengrass/my-component/gdk-config.json';
    tree.write(gdkPath, '{ "hand-edited": true }');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      infra: 'none',
    });

    expect(tree.exists(gdkPath)).toBeFalsy();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      'Removed apps/test_project/greengrass/my-component/gdk-config.json; pass --gdkConfig to keep it.',
    );
  });

  it('should record exact component metadata on project.json', async () => {
    seedPythonProject(tree);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      componentVersion: '2.3.4',
      platform: 'linux-amd64',
      ipc: false,
      gdkConfig: true,
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
      gdkConfig: true,
    });
  });

  it('should vend gdk-config.json with NEXT_PATCH when --gdkConfig is set', async () => {
    seedPythonProject(tree);

    await pyGreengrassComponentGenerator(tree, {
      project: 'test-project',
      name: 'my-component',
      componentVersion: 'NEXT_PATCH',
      gdkConfig: true,
      infra: 'none',
    });

    expect(
      tree.read(
        'apps/test_project/greengrass/my-component/recipe.yaml',
        'utf-8',
      ),
    ).toContain('ComponentVersion: NEXT_PATCH');
    expect(
      JSON.parse(
        tree.read(
          'apps/test_project/greengrass/my-component/gdk-config.json',
          'utf-8',
        ),
      ).component['com.proj.MyComponent'].version,
    ).toBe('NEXT_PATCH');
    expect(
      JSON.parse(tree.read('apps/test_project/project.json', 'utf-8')).metadata
        .components[0].componentVersion,
    ).toBe('NEXT_PATCH');
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
    ).rejects.toThrow(
      'ComponentVersion "not-a-version" must be a valid semantic version (eg. "1.0.0") or one of NEXT_PATCH, NEXT_MINOR, NEXT_MAJOR.',
    );
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
            f.path.endsWith('project.json'),
        )
        .reduce((acc, curr) => {
          acc[curr.path] = tree.read(curr.path, 'utf-8');
          return acc;
        }, {}),
    );
    expect(changes).toMatchSnapshot('main-snapshot');
  });

  describe('multi-architecture (platform: linux-amd64-arm64)', () => {
    it('should vendor each architecture into its own directory for linux-amd64-arm64', async () => {
      seedPythonProject(tree, { requiresPython: '>=3.11' });

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-amd64-arm64',
        infra: 'none',
      });

      const projectConfig = JSON.parse(
        tree.read('apps/test_project/project.json', 'utf-8'),
      );
      const commands =
        projectConfig.targets['my-component-vendor'].options.commands;
      expect(commands).toHaveLength(5);
      // One `rm` of the shared vendor root covers both architectures, so a
      // switch back to a single platform cannot leave the other
      // architecture's directory behind to be packaged.
      expect(commands[0]).toBe(
        'shx rm -rf dist/{projectRoot}/greengrass/my-component/vendor',
      );
      expect(commands[1]).toBe(
        'shx mkdir -p dist/{projectRoot}/greengrass/my-component/vendor',
      );
      expect(commands[2]).toContain(
        '-o dist/{projectRoot}/greengrass/my-component/vendor/requirements.txt',
      );
      expect(commands[3]).toContain('--python-platform x86_64-manylinux_2_28');
      expect(commands[3]).toContain(
        '--target dist/{projectRoot}/greengrass/my-component/vendor/amd64',
      );
      expect(commands[3]).toContain('--python-version 3.11');
      expect(commands[3]).toContain(
        '-r dist/{projectRoot}/greengrass/my-component/vendor/requirements.txt',
      );
      expect(commands[4]).toContain('--python-platform aarch64-manylinux_2_28');
      expect(commands[4]).toContain(
        '--target dist/{projectRoot}/greengrass/my-component/vendor/aarch64',
      );
      expect(commands[4]).toContain(
        '-r dist/{projectRoot}/greengrass/my-component/vendor/requirements.txt',
      );
    });

    it('should pass --platforms=amd64,aarch64 to build-artifact for linux-amd64-arm64', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-amd64-arm64',
        infra: 'none',
      });

      const projectConfig = JSON.parse(
        tree.read('apps/test_project/project.json', 'utf-8'),
      );
      expect(
        projectConfig.targets['my-component-artifact'].options.command,
      ).toContain('--platforms=amd64,aarch64');
    });

    it('should leave the single-platform vendor and artifact commands unchanged', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        infra: 'none',
      });

      const projectConfig = JSON.parse(
        tree.read('apps/test_project/project.json', 'utf-8'),
      );
      expect(
        projectConfig.targets['my-component-artifact'].options.command,
      ).not.toContain('--platforms');
      expect(
        projectConfig.targets['my-component-vendor'].options.commands,
      ).toHaveLength(4);
    });

    it('should write one manifest per architecture with per-architecture zip names and Run paths', async () => {
      seedPythonProject(tree, { requiresPython: '>=3.14' });

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-amd64-arm64',
        infra: 'none',
      });

      const recipe = tree.read(
        'apps/test_project/greengrass/my-component/recipe.yaml',
        'utf-8',
      );
      expect(recipe).toContain('architecture: amd64');
      expect(recipe).toContain('architecture: aarch64');
      expect(recipe).toContain(
        'Uri: s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component-amd64.zip',
      );
      expect(recipe).toContain(
        'Uri: s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component-aarch64.zip',
      );
      expect(recipe).toContain(
        'Run: python3.14 {artifacts:decompressedPath}/my-component-amd64/main.py',
      );
      expect(recipe).toContain(
        'Run: python3.14 {artifacts:decompressedPath}/my-component-aarch64/main.py',
      );
    });

    it('should not duplicate component targets, metadata entries or exports when re-run with the same multi-architecture options', async () => {
      seedPythonProject(tree);

      const options = {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-amd64-arm64' as const,
        iac: 'cdk' as const,
      };
      await pyGreengrassComponentGenerator(tree, options);
      await pyGreengrassComponentGenerator(tree, options);

      const projectConfig = JSON.parse(
        tree.read('apps/test_project/project.json', 'utf-8'),
      );
      expect(projectConfig.metadata.components).toHaveLength(1);
      expect(
        Object.keys(projectConfig.targets).filter((t) =>
          t.startsWith('my-component-'),
        ),
      ).toHaveLength(4);

      const appIndex = tree.read(
        'packages/common/constructs/src/app/greengrass/index.ts',
        'utf-8',
      );
      expect(appIndex?.match(/my-component\.js/g)).toHaveLength(1);
    });

    it.each([
      { from: 'linux-arm64' as const, to: 'linux-amd64-arm64' as const },
      { from: 'linux-amd64-arm64' as const, to: 'linux-arm64' as const },
      { from: 'linux-arm64' as const, to: 'linux-amd64' as const },
    ])(
      'should throw when re-run with platform $to after having recorded $from',
      async ({ from, to }) => {
        seedPythonProject(tree);

        await pyGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          platform: from,
          infra: 'none',
        });

        await expect(
          pyGreengrassComponentGenerator(tree, {
            project: 'test-project',
            name: 'my-component',
            platform: to,
            infra: 'none',
          }),
        ).rejects.toThrow(/cannot change it to/);
      },
    );

    it('should name the recorded platform to re-run with, since omitting the option is not neutral', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-amd64-arm64',
        infra: 'none',
      });

      // No `platform` at all: the option defaults to linux-arm64, so a re-run
      // that meant to change nothing asks to change the platform.
      await expect(
        pyGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          infra: 'none',
        }),
      ).rejects.toThrow(/re-run with --platform=linux-amd64-arm64/);
    });

    it('should leave recipe.yaml byte-identical when the platform-change guard fires', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-arm64',
        infra: 'none',
      });

      const recipePath =
        'apps/test_project/greengrass/my-component/recipe.yaml';
      const recipeBefore = tree.read(recipePath, 'utf-8');

      await expect(
        pyGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          platform: 'linux-amd64-arm64',
          infra: 'none',
        }),
      ).rejects.toThrow();

      expect(tree.read(recipePath, 'utf-8')).toBe(recipeBefore);
    });

    it('should refuse a multi-architecture component when the vended build-artifact.ts predates --platforms', async () => {
      seedPythonProject(tree);
      // A build-artifact.ts vended by a plugin version that predates
      // multi-architecture support - KeepExisting means it never refreshes on
      // its own.
      tree.write(
        'packages/common/scripts/src/greengrass/build-artifact.ts',
        '// Usage: build-artifact.ts <project-root> <component-dir> <dist> [bundle-dir]\n',
      );

      await expect(
        pyGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          platform: 'linux-amd64-arm64',
          infra: 'none',
        }),
      ).rejects.toThrow(
        /multi-architecture components.*Delete the files.*re-apply any patches/s,
      );
    });

    it('should still generate a single-platform component against a build-artifact.ts that predates --platforms', async () => {
      seedPythonProject(tree);
      tree.write(
        'packages/common/scripts/src/greengrass/build-artifact.ts',
        '// Usage: build-artifact.ts <project-root> <component-dir> <dist> [bundle-dir]\n',
      );

      await expect(
        pyGreengrassComponentGenerator(tree, {
          project: 'test-project',
          name: 'my-component',
          platform: 'linux-arm64',
          infra: 'none',
        }),
      ).resolves.toBeDefined();
    });

    it('should record linux-amd64-arm64 as the platform in component metadata', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        componentVersion: '2.3.4',
        platform: 'linux-amd64-arm64',
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
        platform: 'linux-amd64-arm64',
        ipc: false,
        gdkConfig: false,
      });
    });

    it('should escalate a multi-architecture component from --infra none to --infra component-version exactly once', async () => {
      seedPythonProject(tree);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-amd64-arm64',
        infra: 'none',
      });
      expect(tree.exists('packages/common/constructs')).toBe(false);

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-amd64-arm64',
        infra: 'component-version',
        iac: 'cdk',
      });
      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-amd64-arm64',
        infra: 'component-version',
        iac: 'cdk',
      });

      const appIndex = tree.read(
        'packages/common/constructs/src/app/greengrass/index.ts',
        'utf-8',
      );
      expect(appIndex?.match(/my-component\.js/g)).toHaveLength(1);
    });

    it('should match snapshot for a multi-architecture component', async () => {
      seedPythonProject(tree, { requiresPython: '>=3.14' });

      await pyGreengrassComponentGenerator(tree, {
        project: 'test-project',
        name: 'my-component',
        platform: 'linux-amd64-arm64',
        infra: 'none',
      });

      const changes = sortObjectKeys(
        tree
          .listChanges()
          .filter(
            (f) =>
              f.path.endsWith('.py') ||
              f.path.endsWith('.yaml') ||
              f.path.endsWith('project.json'),
          )
          .reduce((acc, curr) => {
            acc[curr.path] = tree.read(curr.path, 'utf-8');
            return acc;
          }, {}),
      );
      expect(changes).toMatchSnapshot('multi-arch-snapshot');
    });
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
      expect(module).toContain(
        'source = "../../../core/greengrass/component-version"',
      );
      expect(module).toContain(
        'apps/test_project/greengrass/my-component/greengrass-build/recipes',
      );
      expect(module).toContain(
        'apps/test_project/greengrass/my-component/greengrass-build/artifacts',
      );

      for (const dir of [
        'artifact-bucket',
        'component-version',
        'deployment',
      ]) {
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
