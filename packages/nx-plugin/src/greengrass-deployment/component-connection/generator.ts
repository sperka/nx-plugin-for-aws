/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  type GeneratorCallback,
  joinPathFragments,
  logger,
  type Tree,
} from '@nx/devkit';
import {
  captureGritQL,
  captureGritQLVariable,
  GRIT_INSERT_PLACEHOLDER,
  insertViaGritQL,
} from '../../utils/ast.js';
import { formatFilesInSubtree } from '../../utils/format.js';
import { parseRecipe } from '../../utils/greengrass/recipe.js';
import { installDependencies } from '../../utils/install.js';
import { addGeneratorMetricsIfApplicable } from '../../utils/metrics.js';
import {
  addComponentGeneratorMetadata,
  getGeneratorInfo,
  type NxGeneratorInfo,
  readProjectConfigurationUnqualified,
} from '../../utils/nx.js';
import { GREENGRASS_DEPLOYMENT_GENERATOR_INFO } from '../generator.js';
import type { GreengrassDeploymentComponentConnectionGeneratorSchema } from './schema.js';

export const GREENGRASS_DEPLOYMENT_COMPONENT_CONNECTION_GENERATOR_INFO: NxGeneratorInfo =
  getGeneratorInfo(import.meta.filename);

/** The declaration the patterns below key off, as the template vends it. */
const COMPONENTS_DECLARATION =
  'const components: Record<string, DeploymentComponent> =';

/**
 * Insert `'<componentName>': <entry>` into a deployment project's user-owned
 * `components` map, returning whether the map was written.
 *
 * Three ordered arms, because the map's shape differs by how far along it is,
 * and the file is the user's to keep in every case:
 *
 * 1. **Has entries.** Appended after the last existing property via
 *    `$last +=`, rather than concatenated ahead of `$props`'s own text -
 *    `$props` includes any trailing comma the last property already has, so
 *    prepending `text, $props` would double it up into invalid syntax once
 *    the map is multi-line, which this map always is (its nested
 *    `DeploymentComponent` values force the formatter to wrap).
 * 2. **Comments only.** GritQL's `$props` does not bind a comment, so an
 *    otherwise-empty map holding the vended illustrative entry - or a note the
 *    user left themselves - falls through arm 1. Appending after the comment
 *    node keeps it, where rewriting the whole declaration would delete it.
 * 3. **Genuinely empty.** Nothing inside the braces to anchor on, so the
 *    declaration is rewritten.
 *
 * Every arm is guarded on the component's own key, so no arm can duplicate an
 * entry and none can fall through to a later arm that would. The guard matches
 * the key as a **top-level property** (`[$..., \`'name': $_\`, $...]`) rather
 * than as text anywhere in the subtree: a component name appearing inside
 * another component's `configurationUpdate` is not an entry for it, and must
 * not skip the insertion.
 */
const addComponentToDeploymentMap = (
  tree: Tree,
  componentsPath: string,
  componentName: string,
  entry: string,
): Promise<boolean> => {
  const key = `'${componentName}'`;
  return insertViaGritQL(
    tree,
    componentsPath,
    `or {
      \`${COMPONENTS_DECLARATION} { $props }\` where {
        $props <: not [$..., \`${key}: $_\`, $...],
        $props <: [$..., $last],
        $last += \`, ${GRIT_INSERT_PLACEHOLDER}\`
      },
      \`${COMPONENTS_DECLARATION} $obj\` where {
        $obj <: not contains \`${key}: $_\`,
        $obj <: contains comment() as $comment,
        $comment += \`\n  ${GRIT_INSERT_PLACEHOLDER}\`
      },
      \`${COMPONENTS_DECLARATION} {}\` => \`${COMPONENTS_DECLARATION} { ${GRIT_INSERT_PLACEHOLDER} }\`
    }`,
    `${key}: ${entry}`,
  );
};

/**
 * The entry the map already holds for `componentName`: whether there is one at
 * all, and the `componentVersion` it declares (absent for an entry carrying
 * only a `configurationUpdate`).
 *
 * Consulted only after {@link addComponentToDeploymentMap} declines to write,
 * which is what makes the loose `` `'name': $_` `` match safe here: a key
 * matched at a nested position would have left the top-level guard satisfied,
 * so the insertion would have gone ahead and this is never reached.
 */
const existingEntry = async (
  tree: Tree,
  componentsPath: string,
  componentName: string,
): Promise<{ exists: boolean; version?: string }> => {
  const entry = await captureGritQL(
    tree,
    componentsPath,
    `\`'${componentName}': $_\``,
  );
  if (entry === undefined) return { exists: false };

  const version = await captureGritQLVariable(
    tree,
    componentsPath,
    `\`'${componentName}': $entry\` where { $entry <: contains \`componentVersion: $version\` }`,
    'version',
  );
  return {
    exists: true,
    // The binding carries the literal's own quotes.
    ...(version ? { version: version.replace(/^['"]|['"]$/g, '') } : {}),
  };
};

/**
 * The `ComponentName` and `ComponentVersion` to write, read from the
 * component's own `recipe.yaml` when it is there.
 *
 * The recipe is the source of truth for both: it is user-owned from first
 * generation onward, the component guides tell the user to bump
 * `ComponentVersion` in it whenever the component changes, and the vended
 * `GreengrassComponentVersion` construct reads the same file at synth time to
 * decide what it publishes. The component's project metadata records only what
 * the component generator resolved on its *first* run, so a documented version
 * bump would otherwise be written here stale.
 *
 * Both component generators vend the recipe at
 * `<projectRoot>/greengrass/<component>/recipe.yaml`. A workspace missing it
 * falls back to the recorded metadata rather than refusing the connection.
 */
const resolveComponentIdentity = (
  tree: Tree,
  projectRoot: string,
  componentDirName: string,
  fromMetadata: { componentName: string; componentVersion: string },
): { componentName: string; componentVersion: string } => {
  const recipePath = joinPathFragments(
    projectRoot,
    'greengrass',
    componentDirName,
    'recipe.yaml',
  );
  const source = tree.read(recipePath, 'utf-8');
  if (!source) return fromMetadata;

  const { recipe } = parseRecipe(source);
  return {
    componentName: recipe.ComponentName,
    componentVersion: recipe.ComponentVersion,
  };
};

/**
 * Connect an AWS IoT Greengrass component (`py#greengrass-component` or
 * `ts#greengrass-component`) to a `greengrass-deployment` project, writing it
 * into the deployment's `components` map at the `ComponentName` and
 * `ComponentVersion` its `recipe.yaml` currently declares.
 *
 * Both the map and the recipe are user-owned, so a re-run never rewrites an
 * entry that is already there: it reports the skip, and warns when the recipe's
 * version has moved past the one the map holds.
 *
 * The generator cannot wire the CloudFormation dependency between the
 * component's `ComponentVersion` and the deployment - that needs a `.dependOn(...)`
 * call in the user's own infra stack, which this generator never touches. See
 * the connection's guide page.
 */
export const greengrassDeploymentComponentConnectionGenerator = async (
  tree: Tree,
  options: GreengrassDeploymentComponentConnectionGeneratorSchema,
): Promise<GeneratorCallback> => {
  const sourceProject = readProjectConfigurationUnqualified(
    tree,
    options.sourceProject,
  );
  if (
    (sourceProject.metadata as { generator?: string } | undefined)
      ?.generator !== GREENGRASS_DEPLOYMENT_GENERATOR_INFO.id
  ) {
    throw new Error(
      `Project '${sourceProject.name}' was not generated by the '${GREENGRASS_DEPLOYMENT_GENERATOR_INFO.id}' generator.`,
    );
  }

  const targetProject = readProjectConfigurationUnqualified(
    tree,
    options.targetProject,
  );
  const component = options.targetComponent;
  if (!component) {
    throw new Error(
      `Target project '${options.targetProject}' has no Greengrass component metadata. Did you run the 'py#greengrass-component' or 'ts#greengrass-component' generator?`,
    );
  }

  const recordedName = component.componentName as string | undefined;
  const recordedVersion = component.componentVersion as string | undefined;
  if (!recordedName || !recordedVersion) {
    throw new Error(
      `Component '${component.name ?? options.targetProject}' is missing componentName/componentVersion metadata. Re-run 'py#greengrass-component' or 'ts#greengrass-component' to regenerate it.`,
    );
  }

  // `CONNECTION_CONSTRAINTS` tells the Graph Builder about this restriction so
  // it can warn while drawing; this is the actual runtime enforcement.
  if (!component.iac) {
    throw new Error(
      `Component '${recordedName}' on '${targetProject.name}' was generated with --infra none, so it publishes no ComponentVersion for '${sourceProject.name}' to reference. Re-run '${component.generator ?? 'py#greengrass-component'}' on '${targetProject.name}' with --infra component-version first.`,
    );
  }

  const { componentName, componentVersion } = resolveComponentIdentity(
    tree,
    targetProject.root,
    (component.name as string | undefined) ?? recordedName,
    { componentName: recordedName, componentVersion: recordedVersion },
  );

  const componentsPath = joinPathFragments(
    sourceProject.sourceRoot ?? joinPathFragments(sourceProject.root, 'src'),
    'components.ts',
  );
  const entry = `{ componentVersion: '${componentVersion}' }`;
  const written = await addComponentToDeploymentMap(
    tree,
    componentsPath,
    componentName,
    entry,
  );

  if (!written) {
    const existing = await existingEntry(tree, componentsPath, componentName);
    if (!existing.exists) {
      throw new Error(
        `Could not find the 'components' map to add '${componentName}' to in ${componentsPath}. This connection edits the declaration the 'greengrass-deployment' generator vends (\`${COMPONENTS_DECLARATION} { ... }\`), and that file is yours to edit, so a restructured declaration is no longer recognised. Add the entry by hand instead:\n\n  '${componentName}': ${entry},\n`,
      );
    }

    // The entry is user-owned once written, so a re-run reports rather than
    // rewrites - including when the recipe has moved on since.
    if (existing.version && existing.version !== componentVersion) {
      logger.warn(
        `'${componentName}' is already in ${componentsPath} at componentVersion '${existing.version}', but its recipe.yaml now declares '${componentVersion}'. The entry is left as it is - update it by hand to deploy the new version.`,
      );
    } else {
      logger.info(
        `'${componentName}' is already in ${componentsPath} - left unchanged.`,
      );
    }
  }

  // Recorded so the version sync and future tooling can identify this
  // connection, keyed by ComponentName so a re-run is a no-op and a second
  // component is additive.
  addComponentGeneratorMetadata(
    tree,
    sourceProject.name,
    GREENGRASS_DEPLOYMENT_COMPONENT_CONNECTION_GENERATOR_INFO,
    targetProject.root,
    componentName,
  );

  await addGeneratorMetricsIfApplicable(tree, [
    GREENGRASS_DEPLOYMENT_COMPONENT_CONNECTION_GENERATOR_INFO,
  ]);

  await formatFilesInSubtree(tree);
  return () =>
    installDependencies(tree, options.preferInstallDependencies, {
      languages: ['typescript'],
    });
};

export default greengrassDeploymentComponentConnectionGenerator;
