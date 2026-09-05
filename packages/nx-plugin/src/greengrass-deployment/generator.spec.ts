/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Tree } from '@nx/devkit';
import { expectHasMetricTags } from '../utils/metrics.spec.js';
import { readProjectConfigurationUnqualified } from '../utils/nx.js';
import { createTreeUsingTsSolutionSetup } from '../utils/test.js';
import {
  GREENGRASS_DEPLOYMENT_GENERATOR_INFO,
  greengrassDeploymentGenerator,
} from './generator.js';
import type { GreengrassDeploymentGeneratorSchema } from './schema.js';

describe('greengrass-deployment generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  const defaultOptions: GreengrassDeploymentGeneratorSchema = {
    name: 'MyDeployment',
    directory: 'packages',
    target: 'thing-group',
    thingGroupName: 'my-things',
    artifactBucket: 'create',
    deploymentPolicy: 'default',
    nucleus: 'classic',
    infra: 'deployment',
    iac: 'cdk',
  };

  it('should generate the deployment library and CDK infrastructure', async () => {
    await greengrassDeploymentGenerator(tree, defaultOptions);

    const projectConfig = readProjectConfigurationUnqualified(
      tree,
      '@proj/my-deployment',
    );
    expect(projectConfig).toBeDefined();

    expect(
      tree.read('packages/my-deployment/src/components.ts', 'utf-8'),
    ).toMatchSnapshot();
    expect(
      tree.read('packages/my-deployment/src/index.ts', 'utf-8'),
    ).toMatchSnapshot();

    expect(
      tree.read(
        'packages/common/constructs/src/app/greengrass/my-deployment.ts',
        'utf-8',
      ),
    ).toMatchSnapshot();
    expect(
      tree.read(
        'packages/common/constructs/src/core/greengrass/index.ts',
        'utf-8',
      ),
    ).toMatchSnapshot();

    // Core constructs vended
    for (const file of [
      'artifact-bucket.ts',
      'component-version.ts',
      'deployment.ts',
      'recipe.ts',
    ]) {
      expect(
        tree.exists(`packages/common/constructs/src/core/greengrass/${file}`),
      ).toBe(true);
    }

    expect(
      tree.read(
        'packages/common/constructs/src/app/greengrass/index.ts',
        'utf-8',
      ),
    ).toContain(`export * from './my-deployment.js';`);
    expect(
      tree.read('packages/common/constructs/src/app/index.ts', 'utf-8'),
    ).toContain(`export * from './greengrass/index.js';`);
    expect(
      tree.read('packages/common/constructs/src/core/index.ts', 'utf-8'),
    ).toContain(`export * from './greengrass/index.js';`);

    const commonConstructsPackageJson = JSON.parse(
      tree.read('packages/common/constructs/package.json', 'utf-8') ?? '{}',
    );
    expect(commonConstructsPackageJson.dependencies['js-yaml']).toBeDefined();
    expect(
      commonConstructsPackageJson.devDependencies['@types/js-yaml'],
    ).toBeDefined();
  });

  it('should be idempotent when re-run with the same options', async () => {
    await greengrassDeploymentGenerator(tree, defaultOptions);
    await greengrassDeploymentGenerator(tree, defaultOptions);

    const appIndex = tree.read(
      'packages/common/constructs/src/app/greengrass/index.ts',
      'utf-8',
    );
    expect(appIndex?.match(/my-deployment\.js/g)).toHaveLength(1);

    const coreIndex = tree.read(
      'packages/common/constructs/src/app/index.ts',
      'utf-8',
    );
    expect(coreIndex?.match(/greengrass\/index\.js/g)).toHaveLength(1);
  });

  it('should preserve user edits to components.ts on re-run', async () => {
    await greengrassDeploymentGenerator(tree, defaultOptions);
    const componentsPath = 'packages/my-deployment/src/components.ts';
    tree.write(
      componentsPath,
      `${tree.read(componentsPath, 'utf-8')}\nexport const userAddition = true;\n`,
    );

    await greengrassDeploymentGenerator(tree, defaultOptions);

    // `formatFilesInSubtree` may reformat whitespace, so this checks the
    // user's addition survives rather than requiring byte-identical output.
    expect(tree.read(componentsPath, 'utf-8')).toContain(
      'export const userAddition = true;',
    );
  });

  it('should escalate from infra=none to infra=deployment', async () => {
    await greengrassDeploymentGenerator(tree, {
      ...defaultOptions,
      infra: 'none',
    });
    expect(tree.exists('packages/common/constructs')).toBe(false);

    await greengrassDeploymentGenerator(tree, defaultOptions);

    expect(
      tree.exists(
        'packages/common/constructs/src/app/greengrass/my-deployment.ts',
      ),
    ).toBe(true);
  });

  it('should throw when the target option does not match the provided target input', async () => {
    await expect(
      greengrassDeploymentGenerator(tree, {
        ...defaultOptions,
        target: 'thing',
        thingGroupName: 'my-things',
        thingName: undefined,
      }),
    ).rejects.toThrow(/requires --thingName/);
  });

  it('should derive thingGroupName from the project name when omitted', async () => {
    await greengrassDeploymentGenerator(tree, {
      ...defaultOptions,
      thingGroupName: undefined,
    });

    expect(
      tree.read(
        'packages/common/constructs/src/app/greengrass/my-deployment.ts',
        'utf-8',
      ),
    ).toContain(`thingGroupName: 'my-deployment',`);
  });

  it('should throw when more than one target input is provided', async () => {
    await expect(
      greengrassDeploymentGenerator(tree, {
        ...defaultOptions,
        thingName: 'my-thing',
      }),
    ).rejects.toThrow(/only accepts --thingGroupName/);
  });

  it('should throw an actionable error for --iac terraform', async () => {
    await expect(
      greengrassDeploymentGenerator(tree, {
        ...defaultOptions,
        iac: 'terraform',
      }),
    ).rejects.toThrow(/hashicorp\/awscc/);
  });

  it('should create an independent project for a different name', async () => {
    await greengrassDeploymentGenerator(tree, defaultOptions);
    await greengrassDeploymentGenerator(tree, {
      ...defaultOptions,
      name: 'OtherDeployment',
      thingGroupName: 'other-things',
    });

    expect(
      tree.exists(
        'packages/common/constructs/src/app/greengrass/my-deployment.ts',
      ),
    ).toBe(true);
    expect(
      tree.exists(
        'packages/common/constructs/src/app/greengrass/other-deployment.ts',
      ),
    ).toBe(true);
  });

  it('should wire a tokenExchangeRoleArn grant when provided', async () => {
    await greengrassDeploymentGenerator(tree, {
      ...defaultOptions,
      tokenExchangeRoleArn:
        'arn:aws:iam::111111111111:role/GreengrassTokenExchangeRole',
    });

    expect(
      tree.read(
        'packages/common/constructs/src/app/greengrass/my-deployment.ts',
        'utf-8',
      ),
    ).toContain('GreengrassTokenExchangeRole');
  });

  it('should record the plugin metric', async () => {
    await greengrassDeploymentGenerator(tree, defaultOptions);
    expectHasMetricTags(tree, GREENGRASS_DEPLOYMENT_GENERATOR_INFO.metric);
  });
});
