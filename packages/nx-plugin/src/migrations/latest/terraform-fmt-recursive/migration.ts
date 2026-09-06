/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  getProjects,
  type MigrationReturnObject,
  type ProjectConfiguration,
  type TargetConfiguration,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import {
  TERRAFORM_FORMAT_TARGET,
  TERRAFORM_PROJECT_GENERATOR_INFO,
} from '../../../terraform/project/generator.js';
import { formatFilesInSubtree } from '../../../utils/format.js';

/**
 * Add `-recursive` to a Terraform project's `format` target and its `fix`
 * configuration.
 *
 * The target runs in `{projectRoot}/src`, and `terraform fmt` without
 * `-recursive` reads only the `.tf` files directly in that directory. A library
 * project such as `common/terraform` holds none there - every module it vends
 * sits in a nested directory - so the check inspected an empty file set and
 * passed without having read a single module. An earlier migration installed
 * the checking form before `-recursive` was part of it, so a workspace that ran
 * that one keeps the blind spot until this runs.
 */

/** The command the pre-fix target checked with. */
const CHECKING_COMMAND = 'terraform fmt -check -diff';
/** The command the pre-fix `fix` configuration wrote with. */
const WRITING_COMMAND = 'terraform fmt';

const FORMAT_TARGET = 'format';

const divergedMessage = (projectName: string) =>
  `${projectName}:${FORMAT_TARGET}: has diverged from the generated shape - left untouched. Add \`-recursive\` to it (\`${TERRAFORM_FORMAT_TARGET.options.command}\`), or its check reads only the \`.tf\` files directly in \`{projectRoot}/src\` and never sees a vended module.`;

/** Whether the target is the exact shape the pre-fix generator produced. */
const hasVendedShape = (target: TargetConfiguration): boolean =>
  target.executor === 'nx:run-commands' &&
  target.options?.command === CHECKING_COMMAND &&
  target.configurations?.fix?.command === WRITING_COMMAND;

export default async function migration(
  tree: Tree,
): Promise<MigrationReturnObject> {
  const nextSteps: string[] = [];

  for (const [projectName, project] of getProjects(tree)) {
    const generator = (project.metadata as { generator?: string } | undefined)
      ?.generator;
    if (generator !== TERRAFORM_PROJECT_GENERATOR_INFO.id) continue;

    const target = project.targets?.[FORMAT_TARGET];
    if (!target) continue;

    // Already recursive, which also makes a re-run - and a project generated
    // after the fix - a no-op.
    if (target.options?.command === TERRAFORM_FORMAT_TARGET.options.command) {
      continue;
    }

    if (!hasVendedShape(target)) {
      nextSteps.push(divergedMessage(projectName));
      continue;
    }

    project.targets[FORMAT_TARGET] = {
      ...target,
      options: {
        ...target.options,
        command: TERRAFORM_FORMAT_TARGET.options.command,
      },
      configurations: {
        ...target.configurations,
        fix: {
          ...target.configurations?.fix,
          command: TERRAFORM_FORMAT_TARGET.configurations?.fix.command,
        },
      },
    };

    updateProjectConfiguration(
      tree,
      projectName,
      project as ProjectConfiguration,
    );
  }

  await formatFilesInSubtree(tree);

  return { nextSteps };
}
