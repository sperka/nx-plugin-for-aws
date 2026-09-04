/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  generateFiles,
  joinPathFragments,
  OverwriteStrategy,
  type Tree,
  updateJson,
} from '@nx/devkit';
import { addStarExport } from '../ast.js';
import type {
  DependencyDeclaration,
  MustDeclare,
} from '../declared-dependencies.js';
import { forDependencies } from '../declared-dependencies.js';
import { addDependenciesToPackageJson } from '../dependencies.js';
import type { Iac } from '../iac.js';
import { esmVars } from '../module-format.js';
import { addArtifactProjectToTargets } from '../nx.js';
import {
  PACKAGES_DIR,
  SHARED_CONSTRUCTS_DIR,
} from '../shared-constructs-constants.js';
import { type ITsDepVersion, withVersions } from '../versions.js';

/**
 * Dependencies the vended `core/greengrass` construct files need at synth
 * time, owned by whichever generator triggers their creation
 * (`greengrass-deployment` or `py#greengrass-component --infra
 * component-version`) via `ownedElsewhere` - the install itself always
 * happens here, in `common/constructs`'s own package.json.
 */
export const GREENGRASS_CONSTRUCTS_DEPENDENCIES = [
  { name: 'js-yaml' },
  { name: '@types/js-yaml', dev: true },
] as const satisfies readonly { name: ITsDepVersion; dev?: boolean }[];

const CORE_GREENGRASS_DIR = joinPathFragments(
  PACKAGES_DIR,
  SHARED_CONSTRUCTS_DIR,
  'src',
  'core',
  'greengrass',
);
const APP_GREENGRASS_DIR = joinPathFragments(
  PACKAGES_DIR,
  SHARED_CONSTRUCTS_DIR,
  'src',
  'app',
  'greengrass',
);

const assertCdk = (iac: Iac): void => {
  if (iac === 'terraform') {
    throw new Error(
      'Greengrass infrastructure does not support --iac terraform yet: ' +
        'AWS::GreengrassV2::ComponentVersion and AWS::GreengrassV2::Deployment ' +
        'exist only in the hashicorp/awscc Terraform provider, which this ' +
        'workspace does not pin (the pinned hashicorp/aws provider has no ' +
        'GreengrassV2 resources at all). Use --iac cdk, or raise pinning ' +
        'the awscc provider as a follow-up.',
    );
  }
  if (iac !== 'cdk') {
    throw new Error(`Unsupported iac ${iac}`);
  }
};

/**
 * Vends the shared `GreengrassArtifactBucket` / `GreengrassComponentVersion` /
 * `GreengrassDeployment` / recipe-reader constructs into
 * `common/constructs/src/core/greengrass/`. Framework-owned and fully
 * generated - regenerated with `OverwriteStrategy.Overwrite` on every call, so
 * it always matches the plugin's current implementation. Idempotent: called
 * from both `greengrass-deployment` and `py#greengrass-component`, in either
 * order, any number of times.
 */
export const addGreengrassCoreConstructs = async <
  const D extends DependencyDeclaration,
>(
  tree: Tree,
  { iac }: { iac: Iac },
  declaration: D & MustDeclare<typeof GREENGRASS_CONSTRUCTS_DEPENDENCIES, D>,
): Promise<void> => {
  assertCdk(iac);

  generateFiles(
    tree,
    joinPathFragments(
      import.meta.dirname,
      'files',
      'cdk',
      'core',
      'greengrass',
    ),
    CORE_GREENGRASS_DIR,
    esmVars(tree),
    { overwriteStrategy: OverwriteStrategy.Overwrite },
  );

  await addStarExport(
    tree,
    joinPathFragments(
      PACKAGES_DIR,
      SHARED_CONSTRUCTS_DIR,
      'src',
      'core',
      'index.ts',
    ),
    './greengrass/index.js',
  );

  addDependenciesToPackageJson(
    tree,
    withVersions(
      forDependencies<typeof GREENGRASS_CONSTRUCTS_DEPENDENCIES>(declaration),
      ['js-yaml'],
    ),
    withVersions(
      forDependencies<typeof GREENGRASS_CONSTRUCTS_DEPENDENCIES>(declaration),
      ['@types/js-yaml'],
    ),
    joinPathFragments(PACKAGES_DIR, SHARED_CONSTRUCTS_DIR, 'package.json'),
  );
};

export interface AddGreengrassDeploymentAppConstructOptions {
  readonly iac: Iac;
  /** The generator's `name` option, verbatim, for the class doc comment. */
  readonly name: string;
  readonly nameClassName: string;
  readonly nameKebabCase: string;
  /** Pre-rendered `GreengrassDeployment` target prop, eg `thingGroupName: 'my-things',`. */
  readonly targetPropLine: string;
  /** Prose describing the target, for the class doc comment. */
  readonly targetDescription: string;
  readonly parentTargetArn?: string;
  readonly tokenExchangeRoleArn?: string;
  readonly artifactBucketImported: boolean;
  readonly artifactBucketName?: string;
  /** Pre-rendered `DeploymentPoliciesProperty` object literal, or undefined to omit the prop entirely. */
  readonly deploymentPoliciesLiteral?: string;
  readonly libraryImportPath: string;
}

/**
 * Vends the per-deployment app construct at
 * `common/constructs/src/app/greengrass/<nameKebabCase>.ts`, wiring the
 * shared artifact bucket and a `GreengrassDeployment` from this generator's
 * options. `OverwriteStrategy.KeepExisting`, like every other `app/`
 * construct - it's the one file in this vending path a user might reasonably
 * extend.
 */
export const addGreengrassDeploymentAppConstruct = async <
  const D extends DependencyDeclaration,
>(
  tree: Tree,
  options: AddGreengrassDeploymentAppConstructOptions,
  declaration: D & MustDeclare<typeof GREENGRASS_CONSTRUCTS_DEPENDENCIES, D>,
): Promise<void> => {
  await addGreengrassCoreConstructs(
    tree,
    { iac: options.iac },
    forDependencies<typeof GREENGRASS_CONSTRUCTS_DEPENDENCIES>(declaration),
  );

  generateFiles(
    tree,
    joinPathFragments(
      import.meta.dirname,
      'files',
      'cdk',
      'app',
      'greengrass-deployment',
    ),
    APP_GREENGRASS_DIR,
    { ...options, ...esmVars(tree) },
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );

  await addStarExport(
    tree,
    joinPathFragments(APP_GREENGRASS_DIR, 'index.ts'),
    `./${options.nameKebabCase}.js`,
  );
  await addStarExport(
    tree,
    joinPathFragments(
      PACKAGES_DIR,
      SHARED_CONSTRUCTS_DIR,
      'src',
      'app',
      'index.ts',
    ),
    './greengrass/index.js',
  );
};

export interface AddGreengrassComponentAppConstructOptions {
  readonly iac: Iac;
  readonly componentNameClassName: string;
  readonly componentDisplayName: string;
  readonly componentDirName: string;
  readonly project: string;
  /** The host project whose `<c>-artifact` target this construct reads at synth time. */
  readonly hostProjectName: string;
  readonly recipesDirFromRoot: string;
  readonly artifactsDirFromRoot: string;
}

/**
 * Vends the per-component app construct at
 * `common/constructs/src/app/greengrass/<componentDirName>.ts`, a thin
 * `GreengrassComponentVersion` subclass pinning this component's build
 * output paths. `OverwriteStrategy.KeepExisting`. Registers the host project
 * on `common/constructs`'s `build`/`assemble` targets so `nx run
 * <infra>:deploy` always deploys a freshly built artifact.
 */
export const addGreengrassComponentAppConstruct = async <
  const D extends DependencyDeclaration,
>(
  tree: Tree,
  options: AddGreengrassComponentAppConstructOptions,
  declaration: D & MustDeclare<typeof GREENGRASS_CONSTRUCTS_DEPENDENCIES, D>,
): Promise<void> => {
  await addGreengrassCoreConstructs(
    tree,
    { iac: options.iac },
    forDependencies<typeof GREENGRASS_CONSTRUCTS_DEPENDENCIES>(declaration),
  );

  generateFiles(
    tree,
    joinPathFragments(
      import.meta.dirname,
      'files',
      'cdk',
      'app',
      'greengrass-component',
    ),
    APP_GREENGRASS_DIR,
    { ...options, ...esmVars(tree) },
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );

  await addStarExport(
    tree,
    joinPathFragments(APP_GREENGRASS_DIR, 'index.ts'),
    `./${options.componentDirName}.js`,
  );
  await addStarExport(
    tree,
    joinPathFragments(
      PACKAGES_DIR,
      SHARED_CONSTRUCTS_DIR,
      'src',
      'app',
      'index.ts',
    ),
    './greengrass/index.js',
  );

  updateJson(
    tree,
    joinPathFragments(PACKAGES_DIR, SHARED_CONSTRUCTS_DIR, 'project.json'),
    (config) => {
      addArtifactProjectToTargets(config, options.hostProjectName);
      return config;
    },
  );
};
