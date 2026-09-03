import type { Tree } from '@nx/devkit';
import { expectHasMetricTags } from '../../utils/metrics.spec';
import { sharedConstructsGenerator } from '../../utils/shared-constructs';
import { createTreeUsingTsSolutionSetup } from '../../utils/test';
import {
  PY_GREENGRASS_COMPONENT_GENERATOR_INFO,
  pyGreengrassComponentGenerator,
} from './generator';

describe('py#greengrass-component generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  it('should run successfully', async () => {
    await pyGreengrassComponentGenerator(tree, { exampleOption: 'example' });

    // TODO: check the tree is updated as expected
  });

  it('should add generator metric to app.ts', async () => {
    await sharedConstructsGenerator(tree, { iac: 'cdk' });

    await pyGreengrassComponentGenerator(tree, { exampleOption: 'example' });

    expectHasMetricTags(tree, PY_GREENGRASS_COMPONENT_GENERATOR_INFO.metric);
  });
});
