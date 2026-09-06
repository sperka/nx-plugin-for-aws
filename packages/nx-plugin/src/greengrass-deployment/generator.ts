/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type GeneratorCallback,
  generateFiles,
  joinPathFragments,
  logger,
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
 *
 * `thingGroupName` names a group this generator creates, so an omitted value is
 * derived from the project name rather than refused - the default `target` is
 * `thing-group`, and a caller choosing options up front (the docs Graph
 * Builder, say) has nothing else to go on. `thingName` and `targetArn` name
 * resources that already exist, which nothing here can guess.
 */
const resolveTarget = (
  options: GreengrassDeploymentGeneratorSchema,
): {
  targetPropLine: string;
  targetPropLineTf: string;
  targetDescription: string;
} => {
  const provided = TARGET_OPTIONS.filter((key) => options[key] !== undefined);
  const expected =
    options.target === 'thing-group'
      ? 'thingGroupName'
      : options.target === 'thing'
        ? 'thingName'
        : 'targetArn';

  const thingGroupName = options.thingGroupName ?? kebabCase(options.name);

  if (expected !== 'thingGroupName' && !options[expected]) {
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
        targetPropLine: `thingGroupName: '${thingGroupName}',`,
        targetPropLineTf: `thing_group_name = "${thingGroupName}"`,
        targetDescription: `a new thing group ("${thingGroupName}")`,
      };
    case 'thing':
      return {
        targetPropLine: `thingName: '${options.thingName}',`,
        targetPropLineTf: `thing_name = "${options.thingName}"`,
        targetDescription: `an existing thing ("${options.thingName}")`,
      };
    case 'existing-arn':
      return {
        targetPropLine: `targetArn: '${options.targetArn}',`,
        targetPropLineTf: `target_arn = "${options.targetArn}"`,
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

/** Terraform-flavoured twin of {@link resolveDeploymentPoliciesLiteral}. */
const resolveDeploymentPoliciesLiteralTf = (
  deploymentPolicy: GreengrassDeploymentGeneratorSchema['deploymentPolicy'],
): string | undefined => {
  switch (deploymentPolicy) {
    case 'no-rollback':
      return `{ failure_handling_policy = "DO_NOTHING" }`;
    case 'rollback':
      return `{ failure_handling_policy = "ROLLBACK" }`;
    default:
      return undefined;
  }
};

/**
 * Generates a Greengrass deployment: a small TypeScript library holding typed
 * component wiring, plus (unless `--infra none`) the CDK constructs or
 * Terraform modules an `AWS::GreengrassV2::Deployment` and its artifact
 * bucket need (Terraform via the `hashicorp/awscc` provider, since neither
 * `AWS::GreengrassV2` resource exists in the pinned `hashicorp/aws`
 * provider).
 */
export const greengrassDeploymentGenerator = async (
  tree: Tree,
  options: GreengrassDeploymentGeneratorSchema,
): Promise<GeneratorCallback> => {
  const target = options.target ?? 'thing-group';
  const artifactBucket = options.artifactBucket ?? 'create';
  const deploymentPolicy = options.deploymentPolicy ?? 'default';
  const { targetPropLine, targetPropLineTf, targetDescription } =
    resolveTarget({
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

  // Read before the user-owned files below are vended, so the Terraform branch
  // can tell "first generation" from "re-run with the JSON bridge missing".
  const componentsTsExisted = tree.exists(
    joinPathFragments(dir, 'src', 'components.ts'),
  );

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

  // Read at plan time by the terraform `deployment` app module's default,
  // and kept in sync by `greengrass-deployment#component-connection`
  // alongside `components.ts` - see that generator for why a separate,
  // snake_cased bridge file is needed rather than importing the TypeScript
  // map directly (Terraform cannot import TypeScript).
  const componentsJsonPathFromRoot = joinPathFragments(
    dir,
    'src',
    'components.json',
  );
  if (iac === 'terraform') {
    const componentsJsonExisted = tree.exists(componentsJsonPathFromRoot);
    generateFiles(
      tree,
      joinPathFragments(import.meta.dirname, 'files', 'components-json'),
      joinPathFragments(dir, 'src'),
      templateOptions,
      { overwriteStrategy: OverwriteStrategy.KeepExisting },
    );
    // `KeepExisting` recreates a deleted file rather than leaving it out, so an
    // empty bridge alongside a populated `components.ts` would otherwise mean
    // Terraform silently deploying no components at all.
    if (componentsTsExisted && !componentsJsonExisted) {
      logger.warn(
        `Created an empty ${componentsJsonPathFromRoot} next to an existing components.ts. Terraform deploys what that JSON file holds, so re-add every component already listed in components.ts - run 'greengrass-deployment#component-connection' again for each, or copy the entries across by hand (snake_case, e.g. { "com.example.MyComponent": { "component_version": "1.0.0" } }).`,
      );
    }
  }

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
        targetPropLineTf,
        targetDescription,
        parentTargetArn: options.parentTargetArn,
        tokenExchangeRoleArn: options.tokenExchangeRoleArn,
        artifactBucketImported: artifactBucket !== 'create',
        artifactBucketName:
          artifactBucket !== 'create' ? artifactBucket : undefined,
        deploymentPoliciesLiteral:
          resolveDeploymentPoliciesLiteral(deploymentPolicy),
        deploymentPoliciesLiteralTf:
          resolveDeploymentPoliciesLiteralTf(deploymentPolicy),
        libraryImportPath: fullyQualifiedName,
        componentsJsonPathFromRoot,
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
