/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type GeneratorCallback,
  generateFiles,
  joinPathFragments,
  OverwriteStrategy,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { valid as validSemver } from 'semver';
import { addTsDependencies } from '../../utils/add-dependencies.js';
import {
  addTypeScriptBundleTarget,
  BUNDLE_DEPENDENCIES,
} from '../../utils/bundle/bundle.js';
import { readAwsNxPluginConfig } from '../../utils/config/utils.js';
import {
  declareDependencies,
  ownedElsewhere,
} from '../../utils/declared-dependencies.js';
import { formatFilesInSubtree } from '../../utils/format.js';
import {
  GREENGRASS_PLATFORM_MAPPINGS,
  type GreengrassPlatform,
  RECIPE_FORMAT_VERSION,
} from '../../utils/greengrass/constants.js';
import {
  assertValidComponentName,
  buildDefaultComponentName,
} from '../../utils/greengrass/naming.js';
import {
  addGreengrassComponentAppConstruct,
  GREENGRASS_CONSTRUCTS_DEPENDENCIES,
} from '../../utils/greengrass-constructs/greengrass-constructs.js';
import { resolveIac } from '../../utils/iac.js';
import { installDependencies } from '../../utils/install.js';
import { addGeneratorMetricsIfApplicable } from '../../utils/metrics.js';
import { toClassName, toKebabCase } from '../../utils/names.js';
import { getNpmScope } from '../../utils/npm-scope.js';
import {
  addArtifactDependencyToTargets,
  addComponentGeneratorMetadata,
  getGeneratorInfo,
  type NxGeneratorInfo,
  normalizeTargetKeyOrder,
  readProjectConfigurationUnqualified,
  updateComponentGeneratorMetadata,
} from '../../utils/nx.js';
import { toProjectRelativePath } from '../../utils/paths.js';
import {
  SHARED_CONSTRUCTS_DEPENDENCIES,
  sharedConstructsGenerator,
} from '../../utils/shared-constructs.js';
import {
  PACKAGES_DIR,
  SHARED_SCRIPTS_DIR,
} from '../../utils/shared-constructs-constants.js';
import {
  SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES,
  sharedGreengrassScriptsGenerator,
} from '../../utils/shared-greengrass-scripts.js';
import { TS_VERSIONS } from '../../utils/versions.js';
import type { TsGreengrassComponentGeneratorSchema } from './schema.js';

/** The metadata this generator records, which its predicates read. */
export interface GreengrassComponentMetadata {
  readonly componentName: string;
  readonly componentVersion: string;
  readonly platform: GreengrassPlatform;
  readonly ipc: boolean;
  readonly iac?: string;
}

export const DEPENDENCIES = declareDependencies<GreengrassComponentMetadata>()({
  ts: [
    // aws-crt ships a per-ABI native addon that cannot be bundled, so it is
    // installed on the device instead - see the recipe's Install step.
    { name: 'aws-iot-device-sdk-v2', when: (m) => m.ipc },
    ...ownedElsewhere(BUNDLE_DEPENDENCIES),
    ...ownedElsewhere(SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES),
    ...ownedElsewhere(SHARED_CONSTRUCTS_DEPENDENCIES),
    ...ownedElsewhere(GREENGRASS_CONSTRUCTS_DEPENDENCIES),
  ],
});

export const TS_GREENGRASS_COMPONENT_GENERATOR_INFO: NxGeneratorInfo =
  getGeneratorInfo(import.meta.filename);

const GREENGRASS_SCRIPTS_DIR = joinPathFragments(
  PACKAGES_DIR,
  SHARED_SCRIPTS_DIR,
  'src',
  'greengrass',
);

/**
 * The default `ComponentPublisher`: `greengrass.publisher` from
 * `aws-nx-plugin.config.mts` when set, else the workspace's npm scope.
 */
const resolveGreengrassPublisher = (tree: Tree): string =>
  readAwsNxPluginConfig(tree)?.greengrass?.publisher ??
  getNpmScope(tree) ??
  'monorepo';

/**
 * Generates an AWS IoT Greengrass v2 component on an existing TypeScript
 * project: a single-file rolldown bundle plus packaging and local-deployment
 * targets (`<c>-artifact`, `<c>-deploy-local`, `<c>-logs`), plus, unless
 * `--infra none`, a `GreengrassComponentVersion` CDK construct that publishes
 * the built artifact. `--iac terraform` throws: neither `AWS::GreengrassV2`
 * resource exists in the pinned `hashicorp/aws` Terraform provider.
 */
export const tsGreengrassComponentGenerator = async (
  tree: Tree,
  options: TsGreengrassComponentGeneratorSchema,
): Promise<GeneratorCallback> => {
  const projectConfig = readProjectConfigurationUnqualified(
    tree,
    options.project,
  );

  const tsconfigPath = joinPathFragments(projectConfig.root, 'tsconfig.json');
  if (!tree.exists(tsconfigPath)) {
    throw new Error(
      `ts#greengrass-component only supports typescript projects, but "${options.project}" has no tsconfig.json. Select a typescript project (eg one created with ts#project).`,
    );
  }
  if (!projectConfig.sourceRoot) {
    throw new Error(
      `This project does not have a source root. Please add a source root to the project configuration before running this generator.`,
    );
  }

  const componentDirName = toKebabCase(options.name);

  const componentName =
    options.componentName ?? buildDefaultComponentName(tree, options.name);
  assertValidComponentName(componentName);

  const componentVersion = options.componentVersion ?? '1.0.0';
  if (!validSemver(componentVersion)) {
    throw new Error(
      `ComponentVersion "${componentVersion}" must be a valid semantic version (eg "1.0.0").`,
    );
  }

  const publisher = options.publisher ?? resolveGreengrassPublisher(tree);
  // The opposite default from py#greengrass-component: aws-iot-device-sdk-v2
  // ships the aws-crt native addon, which cannot be bundled, so opting in
  // costs an on-device install step rather than being free.
  const ipc = options.ipc ?? false;
  const platform: GreengrassPlatform = options.platform ?? 'linux-arm64';
  const { manifestPlatform } = GREENGRASS_PLATFORM_MAPPINGS[platform];

  const infra = options.infra ?? 'component-version';
  const iac =
    infra !== 'none'
      ? await resolveIac(tree, options.iac ?? 'inherit')
      : undefined;

  const componentDir = joinPathFragments(
    projectConfig.root,
    'greengrass',
    componentDirName,
  );
  const entrypointDir = joinPathFragments(
    projectConfig.sourceRoot,
    'greengrass',
    componentDirName,
  );
  const mainPath = joinPathFragments(entrypointDir, 'main.ts');
  const mainPathFromProjectRoot = toProjectRelativePath(
    projectConfig,
    mainPath,
  );

  // A re-run with the same `--infra none` it already had is a stable no-op
  // (the idempotency contract every generator owes); only a run that would
  // *remove* previously-generated infrastructure is ambiguous enough to
  // refuse outright.
  const existingComponentMetadata = (
    projectConfig.metadata as {
      components?: { generator?: string; name?: string; iac?: string }[];
    }
  )?.components?.find(
    (c) =>
      c.generator === TS_GREENGRASS_COMPONENT_GENERATOR_INFO.id &&
      c.name === componentDirName,
  );
  if (existingComponentMetadata?.iac && infra === 'none') {
    throw new Error(
      `This project already has a Greengrass component named "${componentDirName}" with infrastructure provisioned (iac=${existingComponentMetadata.iac}). Re-running with --infra=none would leave that infrastructure orphaned - remove it manually first, or keep --infra=component-version.`,
    );
  }

  const templateOptions = {
    componentName,
    // Named `version` / `recipeFormat`, not `componentVersion` /
    // `recipeFormatVersion`: a `*Version` template variable is how a template
    // names a vended dependency pin (see `VENDED_TEMPLATE_VARS` in
    // `version-upgrade-migration/real-templates.spec.ts`), which neither a
    // user-owned option nor a fixed protocol constant is.
    version: componentVersion,
    recipeFormat: RECIPE_FORMAT_VERSION,
    componentDescription: `${componentName} Greengrass component, generated by ts#greengrass-component.`,
    publisher,
    ipc,
    manifestOs: manifestPlatform.os,
    manifestArchitecture: manifestPlatform.architecture,
    componentDirName,
    project: projectConfig.name,
    // Named `awsIotDeviceSdkPin` for the same reason, and it is not one of the
    // embedded pins the version sync reaches: that path only visits Dockerfiles
    // and `.tf` files. The on-device package.json this renders is
    // framework-owned, so re-running this generator refreshes it from
    // TS_VERSIONS, while the version sync owns the host project's own manifest
    // entry through the `DEPENDENCIES` declaration above.
    awsIotDeviceSdkPin: TS_VERSIONS['aws-iot-device-sdk-v2'],
  };

  // recipe.yaml is user-owned from first generation onward.
  generateFiles(
    tree,
    joinPathFragments(import.meta.dirname, 'files', 'component'),
    componentDir,
    templateOptions,
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );

  // main.ts is user-owned from first generation onward. It lives under the
  // project's own source tree (not beside recipe.yaml, unlike py#greengrass-component)
  // so it participates in the project's normal TypeScript compile/lint/test targets.
  generateFiles(
    tree,
    joinPathFragments(import.meta.dirname, 'files', 'entrypoint'),
    entrypointDir,
    templateOptions,
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );

  // gdk-config.json is framework-owned and fully derived from the options
  // above, so it converges to the desired state on every run.
  generateFiles(
    tree,
    joinPathFragments(import.meta.dirname, 'files', 'gdk'),
    componentDir,
    templateOptions,
    { overwriteStrategy: OverwriteStrategy.Overwrite },
  );

  if (ipc) {
    // The minimal manifest the recipe's Install step needs to `npm install`
    // aws-iot-device-sdk-v2 on the device - framework-owned, fully derived.
    // Like recipe.yaml, `ipc` is only read on first generation: re-running
    // with a different `ipc` value does not retroactively rewrite either.
    generateFiles(
      tree,
      joinPathFragments(import.meta.dirname, 'files', 'ipc-package'),
      componentDir,
      templateOptions,
      { overwriteStrategy: OverwriteStrategy.Overwrite },
    );
  }

  await sharedGreengrassScriptsGenerator(tree, DEPENDENCIES);

  const bundleOutputDir = joinPathFragments('greengrass', componentDirName);
  await addTypeScriptBundleTarget(
    tree,
    projectConfig,
    {
      targetFilePath: mainPathFromProjectRoot,
      bundleOutputDir,
      platform: 'node',
      ...(ipc ? { external: ['aws-iot-device-sdk-v2'] } : {}),
    },
    DEPENDENCIES,
  );

  const artifactTarget = `${componentDirName}-artifact`;
  const deployLocalTarget = `${componentDirName}-deploy-local`;
  const logsTarget = `${componentDirName}-logs`;
  const distDir = `dist/{projectRoot}/greengrass/${componentDirName}`;
  const bundleDir = `dist/{projectRoot}/bundle/${bundleOutputDir}`;

  projectConfig.targets ??= {};

  projectConfig.targets[artifactTarget] = normalizeTargetKeyOrder({
    cache: true,
    // The vended scripts live outside this project, so the cache key must
    // name them explicitly or a refreshed script serves a stale artifact.
    inputs: [
      'production',
      '^production',
      `{workspaceRoot}/${GREENGRASS_SCRIPTS_DIR}/**/*`,
    ],
    outputs: [`{workspaceRoot}/${distDir}/greengrass-build`],
    executor: 'nx:run-commands',
    dependsOn: ['bundle'],
    options: {
      command: `tsx ${GREENGRASS_SCRIPTS_DIR}/build-artifact.ts {projectRoot} ${componentDirName} ${distDir} ${bundleDir}`,
    },
  });
  addArtifactDependencyToTargets(projectConfig, artifactTarget);

  projectConfig.targets[deployLocalTarget] = normalizeTargetKeyOrder({
    executor: 'nx:run-commands',
    dependsOn: [artifactTarget],
    options: {
      command: `tsx ${GREENGRASS_SCRIPTS_DIR}/deploy-local.ts ${distDir}`,
    },
  });

  projectConfig.targets[logsTarget] = normalizeTargetKeyOrder({
    executor: 'nx:run-commands',
    continuous: true,
    options: {
      command: `tsx ${GREENGRASS_SCRIPTS_DIR}/component-logs.ts ${componentName}`,
    },
  });

  updateProjectConfiguration(tree, projectConfig.name, projectConfig);

  const metadata: GreengrassComponentMetadata = {
    componentName,
    componentVersion,
    platform,
    ipc,
    ...(iac ? { iac } : {}),
  };

  addComponentGeneratorMetadata(
    tree,
    projectConfig.name,
    TS_GREENGRASS_COMPONENT_GENERATOR_INFO,
    mainPathFromProjectRoot,
    componentDirName,
    metadata,
  );
  // An escalation from `--infra none` already has an entry, which the add above
  // leaves as it is - including its missing `iac`. Record the resolved one, or
  // the orphan guard would not see the infrastructure this run provisions and a
  // later `--infra none` would silently orphan it.
  if (iac) {
    updateComponentGeneratorMetadata(
      tree,
      projectConfig.name,
      TS_GREENGRASS_COMPONENT_GENERATOR_INFO,
      componentDirName,
      { iac },
    );
  }

  if (infra !== 'none') {
    await sharedConstructsGenerator(tree, { iac: iac! }, DEPENDENCIES);
    await addGreengrassComponentAppConstruct(
      tree,
      {
        iac: iac!,
        componentNameClassName: toClassName(options.name),
        componentDisplayName: componentName,
        componentDirName,
        project: projectConfig.name,
        hostProjectName: projectConfig.name,
        recipesDirFromRoot: `dist/${projectConfig.root}/greengrass/${componentDirName}/greengrass-build/recipes`,
        artifactsDirFromRoot: `dist/${projectConfig.root}/greengrass/${componentDirName}/greengrass-build/artifacts`,
      },
      DEPENDENCIES,
    );
  }

  addTsDependencies(tree, DEPENDENCIES, {
    metadata,
    projectRoot: projectConfig.root,
  });

  await addGeneratorMetricsIfApplicable(tree, [
    TS_GREENGRASS_COMPONENT_GENERATOR_INFO,
  ]);

  await formatFilesInSubtree(tree);

  return () =>
    installDependencies(tree, options.preferInstallDependencies, {
      languages: ['typescript'],
    });
};

export default tsGreengrassComponentGenerator;
