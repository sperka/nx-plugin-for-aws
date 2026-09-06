/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  addProjectConfiguration,
  readProjectConfiguration,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { beforeEach, describe, expect, it } from 'vitest';
import { terraformProjectGenerator } from '../../../terraform/project/generator.js';
import { createTreeUsingTsSolutionSetup } from '../../../utils/test.js';
import migration from './migration.js';

const PROJECT = '@proj/infra';

/** The `format` target as the pre-fix generator vended it. */
const preFixFormatTarget = () => ({
  executor: 'nx:run-commands',
  cache: true,
  inputs: ['default'],
  options: {
    command: 'terraform fmt -check -diff',
    forwardAllArgs: true,
    cwd: '{projectRoot}/src',
  },
  configurations: {
    fix: { command: 'terraform fmt' },
    'skip-lint': { command: 'node -e ""' },
  },
});

/**
 * Generates a terraform project, then reverts `format` to the shape the pre-fix
 * generator produced - so the fixture is what users are upgrading from.
 */
const generatePreFixProject = async (
  tree: Tree,
  type: 'application' | 'library' = 'library',
) => {
  await terraformProjectGenerator(tree, {
    name: 'infra',
    type,
    directory: 'packages',
  });

  const config = readProjectConfiguration(tree, PROJECT);
  config.targets.format = preFixFormatTarget() as never;
  updateProjectConfiguration(tree, PROJECT, config);
};

describe('terraform-fmt-recursive migration', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  it('should be a no-op when the workspace has no terraform project', async () => {
    const result = await migration(tree);
    expect(result.nextSteps).toEqual([]);
  });

  it('should start from a fixture whose check is not recursive', async () => {
    // Guards the fixture: without this the assertions below could pass without
    // the migration doing anything.
    await generatePreFixProject(tree);

    const { format } = readProjectConfiguration(tree, PROJECT).targets;
    expect(format.options.command).toBe('terraform fmt -check -diff');
  });

  it('should make the check and its fix configuration recursive', async () => {
    await generatePreFixProject(tree);

    const result = await migration(tree);

    const { format } = readProjectConfiguration(tree, PROJECT).targets;
    expect(format.options.command).toBe(
      'terraform fmt -check -diff -recursive',
    );
    expect(format.configurations.fix.command).toBe('terraform fmt -recursive');
    // Everything else the user may have set is preserved.
    expect(format.options.cwd).toBe('{projectRoot}/src');
    expect(format.options.forwardAllArgs).toBe(true);
    expect(format.inputs).toEqual(['default']);
    expect(format.cache).toBe(true);
    expect(format.configurations['skip-lint'].command).toBe('node -e ""');
    expect(result.nextSteps).toEqual([]);
  });

  it('should migrate an application project the same way', async () => {
    await generatePreFixProject(tree, 'application');

    const result = await migration(tree);

    expect(
      readProjectConfiguration(tree, PROJECT).targets.format.options.command,
    ).toBe('terraform fmt -check -diff -recursive');
    expect(result.nextSteps).toEqual([]);
  });

  it('should leave a customised format target untouched and report it', async () => {
    await generatePreFixProject(tree);

    const config = readProjectConfiguration(tree, PROJECT);
    config.targets.format.options.command = 'terraform fmt -check';
    updateProjectConfiguration(tree, PROJECT, config);

    const result = await migration(tree);

    expect(
      readProjectConfiguration(tree, PROJECT).targets.format.options.command,
    ).toBe('terraform fmt -check');
    expect(result.nextSteps).toEqual([
      expect.stringContaining('@proj/infra:format'),
    ]);
  });

  it('should leave a project this generator did not create alone', async () => {
    addProjectConfiguration(tree, '@proj/other', {
      root: 'packages/other',
      targets: { format: preFixFormatTarget() } as never,
    });

    const result = await migration(tree);

    expect(
      readProjectConfiguration(tree, '@proj/other').targets.format.options
        .command,
    ).toBe('terraform fmt -check -diff');
    expect(result.nextSteps).toEqual([]);
  });

  it('should be idempotent, and a no-op on a freshly generated project', async () => {
    await terraformProjectGenerator(tree, {
      name: 'infra',
      type: 'library',
      directory: 'packages',
    });
    const generated = readProjectConfiguration(tree, PROJECT).targets.format;

    const first = await migration(tree);
    const afterFirst = readProjectConfiguration(tree, PROJECT).targets.format;
    const second = await migration(tree);

    expect(afterFirst).toEqual(generated);
    expect(readProjectConfiguration(tree, PROJECT).targets.format).toEqual(
      generated,
    );
    expect(first.nextSteps).toEqual([]);
    expect(second.nextSteps).toEqual([]);
  });

  it('should preserve user terraform code', async () => {
    await generatePreFixProject(tree);

    const mainPath = 'packages/infra/src/main.tf';
    const userMain = `resource "aws_sns_topic" "mine" {
  name = "mine"
}
`;
    tree.write(mainPath, userMain);

    await migration(tree);

    expect(tree.read(mainPath, 'utf-8')).toBe(userMain);
  });
});
