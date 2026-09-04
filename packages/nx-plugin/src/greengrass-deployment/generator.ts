/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type GeneratorCallback,
  generateFiles,
  joinPathFragments,
  OverwriteStrategy,
  readProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import tsProjectGenerator, { getTsLibDetails } from '../ts/lib/generator.js';
import { addTsDependencies } from '../utils/add-dependencies.js';
import {
  declareDependencies,
  ownedElsewhere,
} from '../utils/declared-dependencies.js';
import { formatFilesInSubtree } from '../utils/format.js';
import {
  addGreengrassDeploymentAppConstruct,
  GREENGRASS_CONSTRUCTS_DEPENDENCIES,
} from '../utils/greengrass-constructs/greengrass-constructs.js';
import { resolveIac } from '../utils/iac.js';
import { installDependencies } from '../utils/install.js';
import { addGeneratorMetricsIfApplicable } from '../utils/metrics.js';
import { esmVars } from '../utils/module-format.js';
import { kebabCase, toClassName } from '../utils/names.js';
import {
  addGeneratorMetadata,
  getGeneratorInfo,
  type NxGeneratorInfo,
} from '../utils/nx.js';
import {
  SHARED_CONSTRUCTS_DEPENDENCIES,
  sharedConstructsGenerator,
} from '../utils/shared-constructs.js';
import type { GreengrassDeploymentGeneratorSchema } from './schema.js';

export const DEPENDENCIES = declareDependencies()({
  ts: [
    ...ownedElsewhere(SHARED_CONSTRUCTS_DEPENDENCIES),
    ...ownedElsewhere(GREENGRASS_CONSTRUCTS_DEPENDENCIES),
  ],
});

export const GREENGRASS_DEPLOYMENT_GENERATOR_INFO: NxGeneratorInfo =
  getGeneratorInfo(import.meta.filename);

const TARGET_OPTIONS = ['thingGroupName', 'thingName', 'targetArn'] as const;

/**
 * Validates the mutually exclusive target options against `target`, and
 * returns the pre-rendered `GreengrassDeployment` prop line plus a prose
 * description for the app construct's doc comment.
 */
const resolveTarget = (
  options: GreengrassDeploymentGeneratorSchema,
): { targetPropLine: string; targetDescription: string } => {
  const provided = TARGET_OPTIONS.filter((key) => options[key] !== undefined);
  const expected =
    options.target === 'thing-group'
      ? 'thingGroupName'
      : options.target === 'thing'
        ? 'thingName'
        : 'targetArn';

  if (!options[expected]) {
    throw new Error(
      `--target=${options.target} requires --${expected} to be set.`,
    );
  }
  const unexpected = provided.filter((key) => key !== expected);
  if (unexpected.length > 0) {
    throw new Error(
      `--target=${options.target} only accepts --${expected}, but got ${unexpected
        .map((key) => `--${key}`)
        .join(
          ', ',
        )} too. Specify exactly one of ${TARGET_OPTIONS.map((key) => `--${key}`).join(', ')}.`,
    );
  }

  switch (options.target) {
    case 'thing-group':
      return {
        targetPropLine: `thingGroupName: '${options.thingGroupName}',`,
        targetDescription: `a new thing group ("${options.thingGroupName}")`,
      };
    case 'thing':
      return {
        targetPropLine: `thingName: '${options.thingName}',`,
        targetDescription: `an existing thing ("${options.thingName}")`,
      };
    case 'existing-arn':
      return {
        targetPropLine: `targetArn: '${options.targetArn}',`,
        targetDescription: `an existing target (${options.targetArn})`,
      };
  }
};

/** `undefined` (omit the prop, service default `ROLLBACK` applies) unless the option is explicit. */
const resolveDeploymentPoliciesLiteral = (
  deploymentPolicy: GreengrassDeploymentGeneratorSchema['deploymentPolicy'],
): string | undefined => {
  switch (deploymentPolicy) {
    case 'no-rollback':
      return `{ failureHandlingPolicy: 'DO_NOTHING' }`;
    case 'rollback':
      return `{ failureHandlingPolicy: 'ROLLBACK' }`;
    default:
      return undefined;
  }
};

/**
 * Generates a Greengrass deployment: a small TypeScript library holding typed
 * component wiring, plus (unless `--infra none`) the CDK constructs a
 * `AWS::GreengrassV2::Deployment` and its artifact bucket need.
 */
export const greengrassDeploymentGenerator = async (
  tree: Tree,
  options: GreengrassDeploymentGeneratorSchema,
): Promise<GeneratorCallback> => {
  const target = options.target ?? 'thing-group';
  const artifactBucket = options.artifactBucket ?? 'create';
  const deploymentPolicy = options.deploymentPolicy ?? 'default';
  const { targetPropLine, targetDescription } = resolveTarget({
    ...options,
    target,
  });

  const { fullyQualifiedName, dir } = getTsLibDetails(tree, {
    name: options.name,
    directory: options.directory,
    subDirectory: options.subDirectory,
  });
  const nameClassName = toClassName(options.name);
  const nameKebabCase = kebabCase(options.name);

  let projectExists: boolean;
  try {
    readProjectConfiguration(tree, fullyQualifiedName);
    projectExists = true;
  } catch {
    projectExists = false;
  }

  if (!projectExists) {
    await tsProjectGenerator(tree, {
      name: options.name,
      directory: options.directory,
      subDirectory: options.subDirectory,
      preferInstallDependencies: false,
    });
    tree.delete(joinPathFragments(dir, 'src'));
  }

  const templateOptions = {
    name: options.name,
    nameClassName,
    nameKebabCase,
    ...esmVars(tree),
  };

  // Framework-owned barrel - safe to fully regenerate every run.
  generateFiles(
    tree,
    joinPathFragments(import.meta.dirname, 'files', 'index'),
    joinPathFragments(dir, 'src'),
    templateOptions,
    { overwriteStrategy: OverwriteStrategy.Overwrite },
  );
  // User-owned: this is where component entries accumulate over time.
  generateFiles(
    tree,
    joinPathFragments(import.meta.dirname, 'files', 'components'),
    joinPathFragments(dir, 'src'),
    templateOptions,
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );

  const iac =
    options.infra !== 'none' ? await resolveIac(tree, options.iac) : undefined;

  addGeneratorMetadata(
    tree,
    fullyQualifiedName,
    GREENGRASS_DEPLOYMENT_GENERATOR_INFO,
    iac ? { iac } : {},
  );

  if (options.infra !== 'none') {
    await sharedConstructsGenerator(tree, { iac: iac! }, DEPENDENCIES);
    await addGreengrassDeploymentAppConstruct(
      tree,
      {
        iac: iac!,
        name: options.name,
        nameClassName,
        nameKebabCase: templateOptions.nameKebabCase,
        targetPropLine,
        targetDescription,
        parentTargetArn: options.parentTargetArn,
        tokenExchangeRoleArn: options.tokenExchangeRoleArn,
        artifactBucketImported: artifactBucket !== 'create',
        artifactBucketName:
          artifactBucket !== 'create' ? artifactBucket : undefined,
        deploymentPoliciesLiteral:
          resolveDeploymentPoliciesLiteral(deploymentPolicy),
        libraryImportPath: fullyQualifiedName,
      },
      DEPENDENCIES,
    );
  }

  addTsDependencies(tree, DEPENDENCIES, { projectRoot: dir });

  await addGeneratorMetricsIfApplicable(tree, [
    GREENGRASS_DEPLOYMENT_GENERATOR_INFO,
  ]);

  await formatFilesInSubtree(tree);
  return () =>
    installDependencies(tree, options.preferInstallDependencies, {
      languages: ['typescript'],
    });
};

export default greengrassDeploymentGenerator;
