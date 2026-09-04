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
import {
  GREENGRASS_PLATFORM_MAPPINGS,
  type GreengrassPlatform,
  RECIPE_FORMAT_VERSION,
} from '../../utils/greengrass/constants.js';
import {
  assertValidComponentName,
  buildDefaultComponentName,
} from '../../utils/greengrass/naming.js';
import { installDependencies } from '../../utils/install.js';
import { addGeneratorMetricsIfApplicable } from '../../utils/metrics.js';
import { toKebabCase, toSnakeCase } from '../../utils/names.js';
import { getNpmScope } from '../../utils/npm-scope.js';
import {
  addArtifactDependencyToTargets,
  addComponentGeneratorMetadata,
  getGeneratorInfo,
  type NxGeneratorInfo,
  normalizeTargetKeyOrder,
  readProjectConfigurationUnqualified,
} from '../../utils/nx.js';
import { toProjectRelativePath } from '../../utils/paths.js';
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
  readonly platform: GreengrassPlatform;
  readonly ipc: boolean;
}

export const DEPENDENCIES = declareDependencies<GreengrassComponentMetadata>()({
  ts: [...ownedElsewhere(SHARED_GREENGRASS_SCRIPTS_DEPENDENCIES)],
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
 * Generates an AWS IoT Greengrass v2 component on an existing Python project.
 *
 * PR 1 slice: packaging and local deployment only (`<c>-vendor`, `<c>-artifact`,
 * `<c>-deploy-local`, `<c>-logs`). No CDK/Terraform construct, no `infra`/`iac`
 * option — component-version publication arrives in a later PR.
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
  const platform: GreengrassPlatform = options.platform ?? 'linux-arm64';
  const { uvPlatform, manifestPlatform } =
    GREENGRASS_PLATFORM_MAPPINGS[platform];

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

  const templateOptions = {
    componentName,
    // Named `version` / `recipeFormat`, not `componentVersion` /
    // `recipeFormatVersion`: the version-sync migration's template scan treats
    // any `*Version` template variable as a vendored dependency pin it must
    // track, which neither a user-owned option nor a fixed protocol constant is.
    version: componentVersion,
    recipeFormat: RECIPE_FORMAT_VERSION,
    componentDescription: `${componentName} Greengrass component, generated by py#greengrass-component.`,
    publisher,
    ipc,
    manifestOs: manifestPlatform.os,
    manifestArchitecture: manifestPlatform.architecture,
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

  await sharedGreengrassScriptsGenerator(tree, DEPENDENCIES);

  const vendorTarget = `${componentDirName}-vendor`;
  const artifactTarget = `${componentDirName}-artifact`;
  const deployLocalTarget = `${componentDirName}-deploy-local`;
  const logsTarget = `${componentDirName}-logs`;
  const distDir = `dist/{projectRoot}/greengrass/${componentDirName}`;

  projectConfig.targets ??= {};

  projectConfig.targets[vendorTarget] = normalizeTargetKeyOrder({
    cache: true,
    // The vendor dir holds only exported dependencies, never test files.
    inputs: ['production', '^production'],
    outputs: [`{workspaceRoot}/${distDir}/vendor`],
    executor: 'nx:run-commands',
    dependsOn: ['compile'],
    options: {
      commands: [
        `uv export --frozen --no-dev --no-editable --no-emit-project --project {projectRoot} --package ${projectConfig.name} -o ${distDir}/vendor/requirements.txt`,
        // `--only-binary :all:` is required: without it an sdist can build a
        // host-architecture binary into a cross-architecture artifact.
        `uv pip install -n --no-deps --no-installer-metadata --no-compile-bytecode --only-binary :all: --python-platform ${uvPlatform} --python-version ${pythonFloor} --target ${distDir}/vendor -r ${distDir}/vendor/requirements.txt`,
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
      command: `tsx ${GREENGRASS_SCRIPTS_DIR}/build-artifact.ts {projectRoot} ${componentDirName} ${distDir}`,
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
  };

  addComponentGeneratorMetadata(
    tree,
    projectConfig.name,
    PY_GREENGRASS_COMPONENT_GENERATOR_INFO,
    toProjectRelativePath(projectConfig, mainPath),
    componentDirName,
    metadata,
  );

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
