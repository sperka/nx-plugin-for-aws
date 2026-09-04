import type { GeneratorCallback, Tree } from '@nx/devkit';
import { formatFilesInSubtree } from '../../utils/format';
import { installDependencies } from '../../utils/install';
import { addGeneratorMetricsIfApplicable } from '../../utils/metrics';
import { getGeneratorInfo, type NxGeneratorInfo } from '../../utils/nx';
import type { TsGreengrassComponentGeneratorSchema } from './schema.js';

export const TS_GREENGRASS_COMPONENT_GENERATOR_INFO: NxGeneratorInfo =
  getGeneratorInfo(import.meta.filename);

export const tsGreengrassComponentGenerator = async (
  tree: Tree,
  options: TsGreengrassComponentGeneratorSchema,
): Promise<GeneratorCallback> => {
  // TODO: implement your generator here

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
