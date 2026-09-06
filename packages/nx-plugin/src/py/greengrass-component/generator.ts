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
import { addPyDependencies } from '../../utils/add-dependencies.js';
import { readAwsNxPluginConfig } from '../../utils/config/utils.js';
import {
  declareDependencies,
  ownedElsewhere,
} from '../../utils/declared-dependencies.js';
import { formatFilesInSubtree } from '../../utils/format.js';
import { FS_DEPENDENCIES, FsCommands } from '../../utils/fs.js';
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
import { toClassName, toKebabCase, toSnakeCase } from '../../utils/names.js';
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
import { tryReadToml } from '../../utils/toml.js';
import { LAMBDA_RUNTIME_VERSIONS } from '../../utils/versions.js';
import type { PyGreengrassComponentGeneratorSchema } from './schema.js';

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
    ...ownedElsewhere(FS_DEPENDENCIES),
    ...ownedElsewhere(SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES),
    ...ownedElsewhere(SHARED_CONSTRUCTS_DEPENDENCIES),
    ...ownedElsewhere(GREENGRASS_CONSTRUCTS_DEPENDENCIES),
  ],
  py: [{ name: 'awsiotsdk', when: (m) => m.ipc }],
});

export const PY_GREENGRASS_COMPONENT_GENERATOR_INFO: NxGeneratorInfo =
  getGeneratorInfo(import.meta.filename);

const GREENGRASS_SCRIPTS_DIR = joinPathFragments(
  PACKAGES_DIR,
  SHARED_SCRIPTS_DIR,
  'src',
  'greengrass',
);

/**
 * The lowest Python `major.minor` declared by `[project].requires-python`
 * (eg "3.14" from ">=3.14"), so vendoring targets the device's own floor
 * rather than the Lambda runtime `addPythonBundleTarget` pins. Falls back to
 * the plugin's Lambda Python floor only when the project declares none.
 */
const pythonVersionFloor = (requiresPython: unknown): string => {
  if (typeof requiresPython === 'string') {
    let min: { major: number; minor: number } | undefined;
    for (const match of requiresPython.matchAll(/(\d+)\.(\d+)/g)) {
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (
        !min ||
        major < min.major ||
        (major === min.major && minor < min.minor)
      ) {
        min = { major, minor };
      }
    }
    if (min) {
      return `${min.major}.${min.minor}`;
    }
  }
  return LAMBDA_RUNTIME_VERSIONS.python;
};

/**
 * The default `ComponentPublisher`: `greengrass.publisher` from
 * `aws-nx-plugin.config.mts` when set, else the workspace's npm scope.
 */
const resolveGreengrassPublisher = (tree: Tree): string =>
  readAwsNxPluginConfig(tree)?.greengrass?.publisher ??
  getNpmScope(tree) ??
  'monorepo';

/**
 * Generates an AWS IoT Greengrass v2 component on an existing Python project:
 * packaging and local-deployment targets (`<c>-vendor`, `<c>-artifact`,
 * `<c>-deploy-local`, `<c>-logs`), plus, unless `--infra none`, a
 * `GreengrassComponentVersion` CDK construct (or Terraform module, via the
 * `hashicorp/awscc` provider) that publishes the built artifact.
 */
export const pyGreengrassComponentGenerator = async (
  tree: Tree,
  options: PyGreengrassComponentGeneratorSchema,
): Promise<GeneratorCallback> => {
  const projectConfig = readProjectConfigurationUnqualified(
    tree,
    options.project,
  );

  const pyProjectPath = joinPathFragments(projectConfig.root, 'pyproject.toml');
  if (!tree.exists(pyProjectPath)) {
    throw new Error(
      `py#greengrass-component only supports python projects, but "${options.project}" has no pyproject.toml. Select a python project (eg one created with py#project).`,
    );
  }

  const componentDirName = toKebabCase(options.name);
  const componentSnakeCase = toSnakeCase(options.name);

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
  const ipc = options.ipc ?? true;
  const platform: GreengrassPlatformSelection =
    options.platform ?? 'linux-arm64';
  const platforms = resolvePlatforms(platform);
  const isMultiPlatform = platforms.length > 1;
  const distDir = `dist/{projectRoot}/greengrass/${componentDirName}`;
  const distDirVendor = `${distDir}/vendor`;
  // One entry per recipe manifest. Every per-architecture name - the vendor
  // subdirectory, the zip base name and the manifest `architecture` value -
  // is derived from the SAME mapping entry, so they cannot drift apart.
  const manifests = platforms.map((p) => {
    const { uvPlatform, manifestPlatform } = GREENGRASS_PLATFORM_MAPPINGS[p];
    return {
      uvPlatform,
      os: manifestPlatform.os,
      architecture: manifestPlatform.architecture,
      // Single platform keeps today's flat names exactly: `<c>.zip` and
      // `vendor/`. See work item 12's compatibility hinge.
      artifactBaseName: isMultiPlatform
        ? `${componentDirName}-${manifestPlatform.architecture}`
        : componentDirName,
      vendorDir: isMultiPlatform
        ? `${distDirVendor}/${manifestPlatform.architecture}`
        : distDirVendor,
    };
  });

  const infra = options.infra ?? 'component-version';
  const iac =
    infra !== 'none'
      ? await resolveIac(tree, options.iac ?? 'inherit')
      : undefined;

  const pyproject = tryReadToml(tree, pyProjectPath) as unknown as
    | { project?: { 'requires-python'?: unknown } }
    | undefined;
  const pythonFloor = pythonVersionFloor(
    pyproject?.project?.['requires-python'],
  );

  const componentDir = joinPathFragments(
    projectConfig.root,
    'greengrass',
    componentDirName,
  );
  const mainPath = joinPathFragments(componentDir, 'main.py');
  // Flat under tests/greengrass/, one file per component: pytest imports a test
  // module by basename, so two components sharing a `test_main.py` basename in
  // sibling directories would collide.
  const testDir = joinPathFragments(projectConfig.root, 'tests', 'greengrass');

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
      c.generator === PY_GREENGRASS_COMPONENT_GENERATOR_INFO.id &&
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
          `  - Platform:\n      os: ${m.os}\n      architecture: ${m.architecture}\n    Artifacts:\n      - Uri: s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/${m.artifactBaseName}.zip\n        Unarchive: ZIP\n    Lifecycle:\n      Run: python${pythonFloor} {artifacts:decompressedPath}/${m.artifactBaseName}/main.py`,
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
    componentDescription: `${componentName} Greengrass component, generated by py#greengrass-component.`,
    publisher,
    ipc,
    manifests,
    // The recipe Run command pins the same interpreter the wheels were
    // vendored for; a bare `python3` can resolve to an older device default
    // whose ABI the vendored native wheels do not support.
    pythonFloor,
    componentDirName,
    componentSnakeCase,
    project: projectConfig.name,
  };

  // recipe.yaml and main.py are user-owned from first generation onward.
  generateFiles(
    tree,
    joinPathFragments(import.meta.dirname, 'files', 'component'),
    componentDir,
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

  generateFiles(
    tree,
    joinPathFragments(import.meta.dirname, 'files', 'tests'),
    testDir,
    templateOptions,
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );

  // Checked BEFORE vending: the scripts are created once and never
  // overwritten, so a workspace whose Greengrass scripts predate
  // multi-architecture support keeps its old copy - which ignores the trailing
  // --platforms flag and would ship ONE zip under a two-manifest recipe, a
  // failure that only surfaces on a device.
  if (isMultiPlatform) {
    const existingBuildArtifactScript = tree.read(
      joinPathFragments(GREENGRASS_SCRIPTS_DIR, 'build-artifact.ts'),
      'utf-8',
    );
    if (
      existingBuildArtifactScript &&
      !existingBuildArtifactScript.includes('--platforms')
    ) {
      throw new Error(
        `The vended Greengrass build scripts in ${GREENGRASS_SCRIPTS_DIR} were generated by an older plugin version and do not support multi-architecture components. Delete the files in that directory and re-run this generator to refresh them (re-apply any patches of your own afterwards, and bump ComponentVersion before re-deploying any component whose artifact bytes change).`,
      );
    }
  }

  await sharedGreengrassScriptsGenerator(tree, DEPENDENCIES);

  const vendorTarget = `${componentDirName}-vendor`;
  const artifactTarget = `${componentDirName}-artifact`;
  const deployLocalTarget = `${componentDirName}-deploy-local`;
  const logsTarget = `${componentDirName}-logs`;

  projectConfig.targets ??= {};

  const fs = new FsCommands(tree, DEPENDENCIES);

  projectConfig.targets[vendorTarget] = normalizeTargetKeyOrder({
    cache: true,
    // The vendor dir holds only exported dependencies, never test files.
    inputs: ['production', '^production'],
    outputs: [`{workspaceRoot}/${distDirVendor}`],
    executor: 'nx:run-commands',
    dependsOn: ['compile'],
    options: {
      commands: [
        // `uv pip install --target` adds to whatever is already there and
        // never prunes, so without this a dropped dependency - or the other
        // platform's `vendor/<architecture>` directory after a deliberate
        // platform change - would still be packaged into the next artifact.
        // Artifact bytes must depend only on the current source.
        fs.rm(distDirVendor),
        fs.mkdir(distDirVendor),
        `uv export --frozen --no-dev --no-editable --no-emit-project --project {projectRoot} --package ${projectConfig.name} -o ${distDirVendor}/requirements.txt`,
        // `--only-binary :all:` is required: without it an sdist can build a
        // host-architecture binary into a cross-architecture artifact.
        ...manifests.map(
          (m) =>
            `uv pip install -n --no-deps --no-installer-metadata --no-compile-bytecode --only-binary :all: --python-platform ${m.uvPlatform} --python-version ${pythonFloor} --target ${m.vendorDir} -r ${distDirVendor}/requirements.txt`,
        ),
      ],
      parallel: false,
    },
  });

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
    dependsOn: [vendorTarget],
    options: {
      command: `tsx ${GREENGRASS_SCRIPTS_DIR}/build-artifact.ts {projectRoot} ${componentDirName} ${distDir}${
        isMultiPlatform
          ? ` --platforms=${manifests.map((m) => m.architecture).join(',')}`
          : ''
      }`,
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
    PY_GREENGRASS_COMPONENT_GENERATOR_INFO,
    toProjectRelativePath(projectConfig, mainPath),
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
      PY_GREENGRASS_COMPONENT_GENERATOR_INFO,
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

  addPyDependencies(tree, DEPENDENCIES, {
    metadata,
    projectRoot: projectConfig.root,
  });

  await addGeneratorMetricsIfApplicable(tree, [
    PY_GREENGRASS_COMPONENT_GENERATOR_INFO,
  ]);

  await formatFilesInSubtree(tree);

  return () =>
    installDependencies(tree, options.preferInstallDependencies, {
      languages: ['typescript', 'python'],
    });
};

export default pyGreengrassComponentGenerator;
