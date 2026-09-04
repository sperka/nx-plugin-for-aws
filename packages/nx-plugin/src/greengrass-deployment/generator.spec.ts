import type { Tree } from '@nx/devkit';
import { expectHasMetricTags } from '../utils/metrics.spec';
import { sharedConstructsGenerator } from '../utils/shared-constructs';
import { createTreeUsingTsSolutionSetup } from '../utils/test';
import {
  GREENGRASS_DEPLOYMENT_GENERATOR_INFO,
  greengrassDeploymentGenerator,
} from './generator';

describe('greengrass-deployment generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  it('should run successfully', async () => {
    await greengrassDeploymentGenerator(tree, { exampleOption: 'example' });

    // TODO: check the tree is updated as expected
  });

  it('should add generator metric to app.ts', async () => {
    await sharedConstructsGenerator(tree, { iac: 'cdk' });

    await greengrassDeploymentGenerator(tree, { exampleOption: 'example' });

    expectHasMetricTags(tree, GREENGRASS_DEPLOYMENT_GENERATOR_INFO.metric);
  });
});
