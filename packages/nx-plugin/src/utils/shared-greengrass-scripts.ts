/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  generateFiles,
  joinPathFragments,
  logger,
  OverwriteStrategy,
  type Tree,
} from '@nx/devkit';
import type {
  DependencyDeclaration,
  MustDeclare,
} from './declared-dependencies.js';
import { addDependenciesToPackageJson } from './dependencies.js';
import { esmVars } from './module-format.js';
import {
  PACKAGES_DIR,
  SHARED_SCRIPTS_DIR,
} from './shared-constructs-constants.js';
import { ensureSharedScriptsProject } from './shared-scripts.js';
import { type ITsDepVersion, withVersions } from './versions.js';

/** Dependencies a caller must declare to use the shared Greengrass scripts. */
export const SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES = [
  { name: 'js-yaml' },
  { name: '@types/js-yaml' },
  { name: 'tsx' },
] as const satisfies readonly { name: ITsDepVersion }[];

/**
 * Only a `deploy-local.ts` that verifies the component's state after deploying
 * mentions this. The vended scripts are KeepExisting, so a workspace generated
 * before that check keeps a copy that reports `greengrass-cli`'s exit status
 * and nothing about the component - which stays green when the component ends
 * up BROKEN.
 */
const DEPLOY_LOCAL_VERIFICATION_MARKER = 'GREENGRASS_DEPLOY_TIMEOUT_SECONDS';

/**
 * Reported, never enforced, unlike the build-script guards in the component
 * generators: a stale `build-artifact.ts` silently ships the wrong artifact, so
 * those refuse to generate, while a stale `deploy-local.ts` still deploys
 * correctly and only checks less. Refusing over that would break working
 * workspaces for a missing check.
 */
const warnOnStaleDeployLocal = (tree: Tree, greengrassScriptsDir: string) => {
  const path = joinPathFragments(greengrassScriptsDir, 'deploy-local.ts');
  const existing = tree.read(path, 'utf-8');
  if (!existing || existing.includes(DEPLOY_LOCAL_VERIFICATION_MARKER)) {
    return;
  }
  logger.warn(
    `${path} was vended before this generator checked the component's state after a local deployment. It submits the deployment and reports greengrass-cli's exit status, which stays green when the component ends up BROKEN. It still deploys correctly, so it is left as it is - delete ${greengrassScriptsDir} and re-run this generator to take the check (re-apply any patches of your own afterwards).`,
  );
};

/**
 * Ensures the shared scripts package exists and adds Greengrass local-build
 * and local-deploy scripts to packages/common/scripts/src/greengrass/. Used
 * by both py#greengrass-component and (later) ts#greengrass-component so a
 * single set of TypeScript scripts serves both.
 */
export async function sharedGreengrassScriptsGenerator<
  const D extends DependencyDeclaration,
>(
  tree: Tree,
  declaration: D &
    MustDeclare<typeof SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES, D>,
): Promise<void> {
  const scriptsDir = joinPathFragments(PACKAGES_DIR, SHARED_SCRIPTS_DIR);
  const greengrassScriptsDir = joinPathFragments(
    scriptsDir,
    'src',
    'greengrass',
  );

  // Checked BEFORE vending, which would otherwise be a no-op over the stale
  // copy and leave nothing to detect.
  warnOnStaleDeployLocal(tree, greengrassScriptsDir);

  await ensureSharedScriptsProject(tree);

  generateFiles(
    tree,
    joinPathFragments(
      import.meta.dirname,
      'files',
      SHARED_SCRIPTS_DIR,
      'src',
      'greengrass',
    ),
    greengrassScriptsDir,
    esmVars(tree),
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );

  addDependenciesToPackageJson(
    tree,
    withVersions(
      declaration as DependencyDeclaration<
        typeof SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES
      >,
      ['js-yaml'],
    ),
    withVersions(
      declaration as DependencyDeclaration<
        typeof SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES
      >,
      ['@types/js-yaml'],
    ),
    joinPathFragments(PACKAGES_DIR, SHARED_SCRIPTS_DIR, 'package.json'),
  );
  addDependenciesToPackageJson(
    tree,
    {},
    withVersions(
      declaration as DependencyDeclaration<
        typeof SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES
      >,
      ['tsx'],
    ),
  );
}
