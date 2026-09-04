import type { GeneratorCallback, Tree } from '@nx/devkit';
import { formatFilesInSubtree } from '../utils/format';
import { installDependencies } from '../utils/install';
import { addGeneratorMetricsIfApplicable } from '../utils/metrics';
import { getGeneratorInfo, type NxGeneratorInfo } from '../utils/nx';
import type { GreengrassDeploymentGeneratorSchema } from './schema.js';

export const GREENGRASS_DEPLOYMENT_GENERATOR_INFO: NxGeneratorInfo =
  getGeneratorInfo(import.meta.filename);

export const greengrassDeploymentGenerator = async (
  tree: Tree,
  options: GreengrassDeploymentGeneratorSchema,
): Promise<GeneratorCallback> => {
  // TODO: implement your generator here

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
