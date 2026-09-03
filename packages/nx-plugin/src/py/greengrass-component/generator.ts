import type { GeneratorCallback, Tree } from '@nx/devkit';
import { formatFilesInSubtree } from '../../utils/format';
import { installDependencies } from '../../utils/install';
import { addGeneratorMetricsIfApplicable } from '../../utils/metrics';
import { getGeneratorInfo, type NxGeneratorInfo } from '../../utils/nx';
import type { PyGreengrassComponentGeneratorSchema } from './schema.js';

export const PY_GREENGRASS_COMPONENT_GENERATOR_INFO: NxGeneratorInfo =
  getGeneratorInfo(import.meta.filename);

export const pyGreengrassComponentGenerator = async (
  tree: Tree,
  options: PyGreengrassComponentGeneratorSchema,
): Promise<GeneratorCallback> => {
  // TODO: implement your generator here

  await addGeneratorMetricsIfApplicable(tree, [
    PY_GREENGRASS_COMPONENT_GENERATOR_INFO,
  ]);

  await formatFilesInSubtree(tree);
  return () =>
    installDependencies(tree, options.preferInstallDependencies, {
      languages: ['typescript'],
    });
};

export default pyGreengrassComponentGenerator;
