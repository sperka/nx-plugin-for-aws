/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  generateFiles,
  joinPathFragments,
  OverwriteStrategy,
  type ProjectConfiguration,
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
import type { IacMetadata } from '../shared-constructs-constants.js';
import {
  PACKAGES_DIR,
  SHARED_CONSTRUCTS_DIR,
  SHARED_TERRAFORM_DIR,
} from '../shared-constructs-constants.js';
import {
  cdkLambdaRuntimeVars,
  type ITsDepVersion,
  terraformProviderVersions,
  withVersions,
} from '../versions.js';

/**
 * Dependencies the vended `core/greengrass` construct files need at synth
 * time, owned by whichever generator triggers their creation
 * (`greengrass-deployment` or `py#greengrass-component --infra
 * component-version`) via `ownedElsewhere` - the install itself always
 * happens here. CDK adds `js-yaml` in `common/constructs`; Terraform adds the
 * Greengrass and STS SDK clients its plan-time external resolver requires at
 * the workspace root. CDK declares the same two clients in `common/constructs`
 * too: the vended `next-version/index.js` handler `require`s them, the
 * workspace's biome `noUndeclaredDependencies` rule checks that against the
 * package manifest, and the Node.js Lambda runtime supplies them at run time
 * (the `api-gateway-account` handler declares its clients the same way).
 */
export const GREENGRASS_CONSTRUCTS_DEPENDENCIES = [
  { name: 'js-yaml', when: (m: IacMetadata) => m.iac === 'cdk' },
  {
    name: '@types/js-yaml',
    dev: true,
    when: (m: IacMetadata) => m.iac === 'cdk',
  },
  {
    name: '@aws-sdk/client-greengrassv2',
    dev: true,
    root: true,
    when: (m: IacMetadata) => m.iac === 'terraform',
  },
  {
    name: '@aws-sdk/client-sts',
    dev: true,
    root: true,
    when: (m: IacMetadata) => m.iac === 'terraform',
  },
] as const satisfies readonly {
  name: ITsDepVersion;
  dev?: boolean;
  root?: boolean;
  when?: (m: IacMetadata) => boolean;
}[];

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
const CORE_GREENGRASS_TERRAFORM_DIR = joinPathFragments(
  PACKAGES_DIR,
  SHARED_TERRAFORM_DIR,
  'src',
  'core',
  'greengrass',
);
const APP_GREENGRASS_TERRAFORM_DIR = joinPathFragments(
  PACKAGES_DIR,
  SHARED_TERRAFORM_DIR,
  'src',
  'app',
  'greengrass-deployment',
);
const APP_GREENGRASS_COMPONENT_TERRAFORM_DIR = joinPathFragments(
  PACKAGES_DIR,
  SHARED_TERRAFORM_DIR,
  'src',
  'app',
  'greengrass-component',
);
// `terraform test` (the terraform#project `test` target) only discovers test
// files directly in the root configuration directory or in a `tests`
// subdirectory of it - never in an arbitrarily nested one - so these are
// vended at `src/tests`, a sibling of `core` and `app`, rather than inside
// `core/greengrass` alongside the modules they test.
const TESTS_TERRAFORM_DIR = joinPathFragments(
  PACKAGES_DIR,
  SHARED_TERRAFORM_DIR,
  'src',
  'tests',
);

/** Registers `projectName`'s artifact target on the shared iac project the caller vended into. */
const addArtifactProjectToSharedTargets = (
  tree: Tree,
  iac: Iac,
  projectName: string,
): void => {
  updateJson(
    tree,
    joinPathFragments(
      PACKAGES_DIR,
      iac === 'cdk' ? SHARED_CONSTRUCTS_DIR : SHARED_TERRAFORM_DIR,
      'project.json',
    ),
    (config: ProjectConfiguration) => {
      addArtifactProjectToTargets(config, projectName);
      return config;
    },
  );
};

/**
 * Vends the shared `GreengrassArtifactBucket` / `GreengrassComponentVersion` /
 * `GreengrassDeployment` / recipe-reader constructs (CDK) or modules
 * (Terraform, via the `hashicorp/awscc` provider - neither
 * `AWS::GreengrassV2::ComponentVersion` nor `AWS::GreengrassV2::Deployment`
 * exists in the pinned `hashicorp/aws` provider) into
 * `common/constructs/src/core/greengrass/` or
 * `common/terraform/src/core/greengrass/`. Framework-owned and fully
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
  if (iac === 'terraform') {
    generateFiles(
      tree,
      joinPathFragments(
        import.meta.dirname,
        'files',
        'terraform',
        'core',
        'greengrass',
      ),
      CORE_GREENGRASS_TERRAFORM_DIR,
      terraformProviderVersions(),
      { overwriteStrategy: OverwriteStrategy.Overwrite },
    );
    generateFiles(
      tree,
      joinPathFragments(import.meta.dirname, 'files', 'next-version'),
      joinPathFragments(CORE_GREENGRASS_TERRAFORM_DIR, 'component-version'),
      { nextVersionFileName: 'next-version.cjs' },
      { overwriteStrategy: OverwriteStrategy.Overwrite },
    );
    // Credential-free `terraform test` coverage for the modules above (mocked
    // providers, no AWS calls) - see the test file's own header comment.
    generateFiles(
      tree,
      joinPathFragments(import.meta.dirname, 'files', 'terraform', 'tests'),
      TESTS_TERRAFORM_DIR,
      {},
      { overwriteStrategy: OverwriteStrategy.Overwrite },
    );
    addDependenciesToPackageJson(
      tree,
      {},
      withVersions(
        forDependencies<typeof GREENGRASS_CONSTRUCTS_DEPENDENCIES>(declaration),
        ['@aws-sdk/client-greengrassv2', '@aws-sdk/client-sts'],
      ),
    );
    return;
  }
  if (iac !== 'cdk') {
    throw new Error(`Unsupported iac ${iac}`);
  }

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
    { ...esmVars(tree), ...cdkLambdaRuntimeVars() },
    { overwriteStrategy: OverwriteStrategy.Overwrite },
  );
  generateFiles(
    tree,
    joinPathFragments(import.meta.dirname, 'files', 'next-version'),
    joinPathFragments(CORE_GREENGRASS_DIR, 'next-version'),
    { nextVersionFileName: 'index.js' },
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
      ['js-yaml', '@aws-sdk/client-greengrassv2', '@aws-sdk/client-sts'],
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
  /** Pre-rendered terraform `deployment` module target attribute, eg `thing_group_name = "my-things"`. */
  readonly targetPropLineTf: string;
  /** Prose describing the target, for the class doc comment. */
  readonly targetDescription: string;
  readonly parentTargetArn?: string;
  readonly tokenExchangeRoleArn?: string;
  /** Narrows the tokenExchangeRoleArn grant. Defaults to the whole bucket ("*") when unset. */
  readonly tokenExchangeKeyPrefix?: string;
  readonly artifactBucketImported: boolean;
  readonly artifactBucketName?: string;
  /** Pre-rendered `DeploymentPoliciesProperty` object literal, or undefined to omit the prop entirely. */
  readonly deploymentPoliciesLiteral?: string;
  /** Pre-rendered terraform `deployment_policies` object literal, or undefined to omit the attribute entirely. */
  readonly deploymentPoliciesLiteralTf?: string;
  readonly libraryImportPath: string;
  /**
   * Workspace-root-relative path to the components JSON bridge file the
   * Terraform `deployment` module reads by default (`packages/<lib>/src/components.json`).
   * Only used on the Terraform branch.
   */
  readonly componentsJsonPathFromRoot?: string;
}

/**
 * Vends the per-deployment app construct/modules, wiring the shared artifact
 * bucket and a `GreengrassDeployment` from this generator's options.
 *
 * CDK: one construct at
 * `common/constructs/src/app/greengrass/<nameKebabCase>.ts`, owning both the
 * artifact bucket and the deployment as sibling children - CDK's per-child
 * dependency tracking lets a component version depend on the bucket while the
 * deployment depends on the component version, without a cycle.
 *
 * Terraform: two sibling modules,
 * `common/terraform/src/app/greengrass-deployment/<nameKebabCase>-artifact-bucket/`
 * and `.../<nameKebabCase>/` - a `module` block is Terraform's finest reuse
 * granularity, so bundling both concerns in one module the way CDK does would
 * force exactly that cycle the moment a caller wires
 * `component -> bucket` and `deployment -> component` with `depends_on`.
 *
 * `OverwriteStrategy.KeepExisting` on the app files either way, like every
 * other `app/` construct - it's the one layer in this vending path a user
 * might reasonably extend.
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

  if (options.iac === 'terraform') {
    generateFiles(
      tree,
      joinPathFragments(
        import.meta.dirname,
        'files',
        'terraform',
        'app',
        'greengrass-deployment',
      ),
      APP_GREENGRASS_TERRAFORM_DIR,
      options,
      { overwriteStrategy: OverwriteStrategy.KeepExisting },
    );
    return;
  }

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
 * Vends the per-component app construct/module: a thin
 * `GreengrassComponentVersion` wrapper pinning this component's build output
 * paths, at `common/constructs/src/app/greengrass/<componentDirName>.ts`
 * (CDK) or `common/terraform/src/app/greengrass-component/<componentDirName>/`
 * (Terraform, taking the artifact bucket's name as a plain input variable -
 * see the deployment app construct's doc comment for why the bucket is a
 * separate module rather than an argument this module creates itself).
 * `OverwriteStrategy.KeepExisting` either way. Registers the host project on
 * the shared iac project's `build`/`assemble` targets so `nx run
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

  if (options.iac === 'terraform') {
    generateFiles(
      tree,
      joinPathFragments(
        import.meta.dirname,
        'files',
        'terraform',
        'app',
        'greengrass-component',
      ),
      APP_GREENGRASS_COMPONENT_TERRAFORM_DIR,
      options,
      { overwriteStrategy: OverwriteStrategy.KeepExisting },
    );
    addArtifactProjectToSharedTargets(
      tree,
      'terraform',
      options.hostProjectName,
    );
    return;
  }

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

  addArtifactProjectToSharedTargets(tree, 'cdk', options.hostProjectName);
};
