/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { logger, readJson, type Tree } from '@nx/devkit';
import { declareDependencies } from './declared-dependencies.js';
import {
  SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES,
  sharedGreengrassScriptsGenerator,
} from './shared-greengrass-scripts.js';
import { createTreeUsingTsSolutionSetup, snapshotTreeDir } from './test.js';

const declaration = declareDependencies()({
  ts: [...SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES],
});

describe('sharedGreengrassScriptsGenerator', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  it('should vend the greengrass scripts into packages/common/scripts', async () => {
    await sharedGreengrassScriptsGenerator(tree, declaration);

    snapshotTreeDir(tree, 'packages/common/scripts/src/greengrass');

    expect(
      tree.exists('packages/common/scripts/src/greengrass/build-artifact.ts'),
    ).toBe(true);
    expect(
      tree.exists('packages/common/scripts/src/greengrass/deploy-local.ts'),
    ).toBe(true);
    expect(
      tree.exists('packages/common/scripts/src/greengrass/component-logs.ts'),
    ).toBe(true);
    expect(
      tree.exists('packages/common/scripts/src/greengrass/recipe-utils.ts'),
    ).toBe(true);
    expect(
      tree.exists('packages/common/scripts/src/greengrass/zip-writer.ts'),
    ).toBe(true);
  });

  it('should declare js-yaml as a runtime dependency of the shared scripts project', async () => {
    await sharedGreengrassScriptsGenerator(tree, declaration);

    const scriptsPackageJson = readJson(
      tree,
      'packages/common/scripts/package.json',
    );
    expect(scriptsPackageJson.dependencies['js-yaml']).toBeDefined();
    expect(scriptsPackageJson.devDependencies['@types/js-yaml']).toBeDefined();
  });

  it('should declare tsx as a workspace root dev dependency', async () => {
    await sharedGreengrassScriptsGenerator(tree, declaration);

    const rootPackageJson = readJson(tree, 'package.json');
    expect(rootPackageJson.devDependencies.tsx).toBeDefined();
  });

  it('should create the shared scripts project only once', async () => {
    await sharedGreengrassScriptsGenerator(tree, declaration);
    const projectJsonBefore = tree.read(
      'packages/common/scripts/project.json',
      'utf-8',
    );

    // A pre-existing common/scripts project (e.g. created by another shared
    // scripts generator first) must not be re-scaffolded.
    await sharedGreengrassScriptsGenerator(tree, declaration);
    expect(tree.read('packages/common/scripts/project.json', 'utf-8')).toEqual(
      projectJsonBefore,
    );
  });

  it('should be idempotent when re-run with the same declaration', async () => {
    await sharedGreengrassScriptsGenerator(tree, declaration);

    const beforeSnapshot = tree
      .children('packages/common/scripts/src/greengrass')
      .sort();
    const buildArtifactBefore = tree.read(
      'packages/common/scripts/src/greengrass/build-artifact.ts',
      'utf-8',
    );

    await sharedGreengrassScriptsGenerator(tree, declaration);

    expect(
      tree.children('packages/common/scripts/src/greengrass').sort(),
    ).toEqual(beforeSnapshot);
    expect(
      tree.read(
        'packages/common/scripts/src/greengrass/build-artifact.ts',
        'utf-8',
      ),
    ).toEqual(buildArtifactBefore);

    const scriptsPackageJson = readJson(
      tree,
      'packages/common/scripts/package.json',
    );
    expect(Object.keys(scriptsPackageJson.dependencies)).toEqual(
      Array.from(new Set(Object.keys(scriptsPackageJson.dependencies))),
    );
  });

  it('should preserve user edits to a vended script on re-run', async () => {
    await sharedGreengrassScriptsGenerator(tree, declaration);

    const customized = '// user customisation\nexport const marker = true;\n';
    tree.write(
      'packages/common/scripts/src/greengrass/build-artifact.ts',
      customized,
    );

    await sharedGreengrassScriptsGenerator(tree, declaration);

    expect(
      tree.read(
        'packages/common/scripts/src/greengrass/build-artifact.ts',
        'utf-8',
      ),
    ).toEqual(customized);
  });

  // KeepExisting means a workspace vended before the post-deployment state
  // check keeps a deploy-local.ts that reports greengrass-cli's exit status and
  // nothing about the component. Reported rather than refused: unlike a stale
  // build-artifact.ts, it still deploys correctly.
  const DEPLOY_LOCAL_PATH =
    'packages/common/scripts/src/greengrass/deploy-local.ts';

  it('should warn when the workspace keeps a deploy-local.ts that does not verify the component', async () => {
    await sharedGreengrassScriptsGenerator(tree, declaration);
    tree.write(
      DEPLOY_LOCAL_PATH,
      [
        "import { spawnSync } from 'node:child_process';",
        '// submits the deployment and exits, as vended before the check',
        'process.exit(0);',
        '',
      ].join('\n'),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await sharedGreengrassScriptsGenerator(tree, declaration);

    const message = warn.mock.calls.map(([first]) => String(first)).join('\n');
    warn.mockRestore();
    expect(message).toContain(DEPLOY_LOCAL_PATH);
    expect(message).toContain('BROKEN');
    expect(message).toContain('packages/common/scripts/src/greengrass');
  });

  it('should not warn about deploy-local.ts on a fresh workspace, or one already carrying the check', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    // Nothing vended yet: there is no stale copy to complain about.
    await sharedGreengrassScriptsGenerator(tree, declaration);
    // Vended, then customized while keeping the check.
    const current = tree.read(DEPLOY_LOCAL_PATH, 'utf-8') ?? '';
    expect(current).toContain('GREENGRASS_DEPLOY_TIMEOUT_SECONDS');
    tree.write(DEPLOY_LOCAL_PATH, `// user customisation\n${current}`);
    await sharedGreengrassScriptsGenerator(tree, declaration);

    const calls = warn.mock.calls.map(([first]) => String(first));
    warn.mockRestore();
    expect(
      calls.filter((message) => message.includes('deploy-local.ts')),
    ).toEqual([]);
  });
});
