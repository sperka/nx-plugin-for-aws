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
  type GreengrassPlatformSelection,
  RECIPE_FORMAT_VERSION,
  resolvePlatforms,
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
import { registerPnpmBuiltDependencies } from '../../utils/pnpm-workspace.js';
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
import type { TsGreengrassComponentGeneratorSchema } from './schema.js';

/** The metadata this generator records, which its predicates read. */
export interface GreengrassComponentMetadata {
  readonly componentName: string;
  readonly componentVersion: string;
  readonly platform: GreengrassPlatformSelection;
  readonly ipc: boolean;
  readonly iac?: string;
}

export const DEPENDENCIES = declareDependencies<GreengrassComponentMetadata>()({
  ts: [
    // Bundled like everything else. Its aws-crt dependency ships a native
    // addon that cannot be bundled, so the vendor target copies that addon
    // into the artifact from this same pinned install - see vendor-crt-addon.ts.
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
 * `--infra none`, a `GreengrassComponentVersion` CDK construct (or Terraform
 * module, via the `hashicorp/awscc` provider) that publishes the built
 * artifact.
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
  // The default stays false only for continuity of existing invocations:
  // `--ipc` is now as self-contained as the Python component, at the cost of
  // about 2 MB of vendored native binary plus an accessControl block.
  const ipc = options.ipc ?? false;
  const platform: GreengrassPlatformSelection =
    options.platform ?? 'linux-arm64';
  const platforms = resolvePlatforms(platform);
  // A rolldown bundle is pure JavaScript over every architecture, and with
  // `ipc=true` one zip carries every targeted architecture's own vendored
  // addon - each manifest's Setenv selects only its own - so, unlike the
  // Python component, this generator has ONE artifact over N manifests, never
  // N artifacts.
  const manifests = platforms.map((p) => {
    const { manifestPlatform, nodeCrtAddonDir } =
      GREENGRASS_PLATFORM_MAPPINGS[p];
    return {
      os: manifestPlatform.os,
      architecture: manifestPlatform.architecture,
      artifactBaseName: componentDirName,
      nodeCrtAddonDir,
    };
  });

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
      components?: {
        generator?: string;
        name?: string;
        iac?: string;
        platform?: string;
      }[];
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

  if (
    existingComponentMetadata?.platform &&
    existingComponentMetadata.platform !== platform
  ) {
    const manifestPreview = manifests
      .map(
        (m) =>
          `  - Platform:\n      os: ${m.os}\n      architecture: ${m.architecture}\n    Artifacts:\n      - Uri: s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/${m.artifactBaseName}.zip\n        Unarchive: ZIP\n    Lifecycle:\n${
            // The Setenv block is per-manifest and names this architecture's
            // vendored addon, so a preview without it is not paste-ready for an
            // ipc=true component.
            ipc
              ? `      Setenv:\n        AWS_CRT_NODEJS_BINARY_RELATIVE_PATH: native/aws-crt/${m.nodeCrtAddonDir}/aws-crt-nodejs.node\n`
              : ''
          }      Run: node {artifacts:decompressedPath}/${m.artifactBaseName}/index.js`,
      )
      .join('\n');
    throw new Error(
      `This project already has a Greengrass component named "${componentDirName}" generated for platform "${existingComponentMetadata.platform}". recipe.yaml is user-owned and is never rewritten, so this run cannot change it to "${platform}" - the targets would then build artifacts the recipe does not declare. If you did not mean to change the platform, re-run with --platform=${existingComponentMetadata.platform} (this option has a default, so leaving it off asks for "${platform}"). To change it on purpose, edit ${joinPathFragments(componentDir, 'recipe.yaml')} by hand so its Manifests match, bump ComponentVersion (published versions are immutable), and set platform to "${platform}" in this project's project.json metadata.components entry. The manifests "${platform}" expects are:\n${manifestPreview}`,
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
    manifests,
    componentDirName,
    project: projectConfig.name,
  };

  // recipe.yaml is user-owned from first generation onward, so `ipc` shapes it
  // only on the first run: a later run that flips `ipc` to true adds the vendor
  // target and stages the addon, but leaves the recipe without the `Setenv` that
  // points aws-crt's loader at it, and the component then fails on the device
  // with "AWS CRT binary not present". Add that block by hand - the guide's
  // migration note carries the exact shape.
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

  // Checked BEFORE vending: the scripts are created once and never
  // overwritten, so a workspace whose Greengrass scripts predate bundle
  // support keeps its old copy - and this generator's artifact target would
  // then fail at build time with an unexplained "Nothing to package". Refuse
  // up front with the fix instead.
  const existingBuildArtifactScript = tree.read(
    joinPathFragments(GREENGRASS_SCRIPTS_DIR, 'build-artifact.ts'),
    'utf-8',
  );
  if (
    existingBuildArtifactScript &&
    !existingBuildArtifactScript.includes('bundle-dir')
  ) {
    throw new Error(
      `The vended Greengrass build scripts in ${GREENGRASS_SCRIPTS_DIR} were generated by an older plugin version and do not support bundled (TypeScript) components. Delete the files in that directory and re-run this generator to refresh them (re-apply any patches of your own afterwards).`,
    );
  }

  await sharedGreengrassScriptsGenerator(tree, DEPENDENCIES);

  if (ipc) {
    // aws-crt ships an install script that builds its native addon from
    // source. Recorded as `false`: this component vendors the prebuilt addon at
    // build time, so the script must not run - and pnpm 11 fails the install
    // outright with ERR_PNPM_IGNORED_BUILDS unless the decision is explicit.
    registerPnpmBuiltDependencies(tree, { 'aws-crt': false });
  }

  if (ipc) {
    // AFTER sharedGreengrassScriptsGenerator, never before: in a workspace with
    // no shared scripts project yet, that generator creates one and deletes the
    // whole `src` tree it scaffolded, which would take this script with it and
    // leave the `-vendor` target invoking a file that does not exist.
    //
    // Vended here rather than by that generator, and only when ipc is true,
    // because it vends its whole directory into every workspace - putting this
    // script there would change what an ipc=false run produces. KeepExisting
    // like every other vended script, so a user's patches survive.
    generateFiles(
      tree,
      joinPathFragments(import.meta.dirname, 'files', 'scripts'),
      GREENGRASS_SCRIPTS_DIR,
      templateOptions,
      { overwriteStrategy: OverwriteStrategy.KeepExisting },
    );
  }

  const bundleOutputDir = joinPathFragments('greengrass', componentDirName);
  await addTypeScriptBundleTarget(
    tree,
    projectConfig,
    {
      targetFilePath: mainPathFromProjectRoot,
      bundleOutputDir,
      platform: 'node',
    },
    DEPENDENCIES,
  );

  const artifactTarget = `${componentDirName}-artifact`;
  const vendorTarget = `${componentDirName}-vendor`;
  const deployLocalTarget = `${componentDirName}-deploy-local`;
  const logsTarget = `${componentDirName}-logs`;
  const distDir = `dist/{projectRoot}/greengrass/${componentDirName}`;
  const bundleDir = `dist/{projectRoot}/bundle/${bundleOutputDir}`;
  // Named `stage`, not `vendor`, so it cannot be confused with the
  // `<dist>/vendor` path build-artifact.ts reads in Python (non-bundle) mode.
  const stageDir = `${distDir}/stage`;

  projectConfig.targets ??= {};

  if (ipc) {
    projectConfig.targets[vendorTarget] = normalizeTargetKeyOrder({
      cache: true,
      inputs: [
        'production',
        '^production',
        `{workspaceRoot}/${GREENGRASS_SCRIPTS_DIR}/**/*`,
        // The addon bytes come from the installed aws-crt, not from any file
        // in this project, so without this the target would serve the
        // previous SDK's addon from cache after a version bump.
        { externalDependencies: ['aws-iot-device-sdk-v2'] },
      ],
      outputs: [`{workspaceRoot}/${stageDir}`],
      executor: 'nx:run-commands',
      dependsOn: ['bundle'],
      options: {
        command: `tsx ${GREENGRASS_SCRIPTS_DIR}/vendor-crt-addon.ts {projectRoot} ${bundleDir} ${stageDir} ${manifests
          .map((m) => m.nodeCrtAddonDir)
          .join(',')}`,
      },
    });
  }

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
    dependsOn: [ipc ? vendorTarget : 'bundle'],
    options: {
      command: `tsx ${GREENGRASS_SCRIPTS_DIR}/build-artifact.ts {projectRoot} ${componentDirName} ${distDir} ${ipc ? stageDir : bundleDir}`,
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
