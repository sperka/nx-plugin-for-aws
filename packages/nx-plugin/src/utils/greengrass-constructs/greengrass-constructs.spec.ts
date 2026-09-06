/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tree } from '@nx/devkit';
import ts from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { declareDependencies } from '../declared-dependencies.js';
import { createTreeUsingTsSolutionSetup } from '../test.js';
import terraformProjectGenerator from '../../terraform/project/generator.js';
import {
  addGreengrassComponentAppConstruct,
  addGreengrassCoreConstructs,
  addGreengrassDeploymentAppConstruct,
  GREENGRASS_CONSTRUCTS_DEPENDENCIES,
} from './greengrass-constructs.js';

// Real npm packages (`aws-cdk-lib`, `constructs`, `js-yaml`) are resolved
// against this package's own installed dependencies by writing the
// transpiled module to a real temporary file next to this spec, the same
// pattern `greengrass-scripts.spec.ts` uses for the vended tsx scripts -
// `aws-cdk-lib`/`constructs` are pinned at the workspace root, which Node's
// directory walk-up module resolution reaches from anywhere under it.
const CORE_DIR = join(
  import.meta.dirname,
  'files',
  'cdk',
  'core',
  'greengrass',
);

const MODULE_NAMES = [
  'recipe',
  'artifact-bucket',
  'component-version',
  'deployment',
] as const;
type ModuleName = (typeof MODULE_NAMES)[number];

// `artifact-bucket` imports the shared `suppressRules` helper from the core
// constructs dir one level up, which `sharedConstructsGenerator` vends into
// the same workspace. Transpiled alongside the greengrass modules so the
// suppression runs for real here rather than being stubbed out.
const CHECKOV_TEMPLATE = join(
  import.meta.dirname,
  '..',
  'files',
  'common',
  'constructs',
  'src',
  'core',
  'checkov.ts.template',
);

const checkovTmpModulePath = (): string =>
  join(
    import.meta.dirname,
    `.tmp-greengrass-constructs-checkov-${process.pid}.mjs`,
  );

const tmpModulePath = (name: ModuleName): string =>
  join(
    import.meta.dirname,
    `.tmp-greengrass-constructs-${name}-${process.pid}.mjs`,
  );

const loadTemplate = (name: ModuleName): string => {
  const content = readFileSync(join(CORE_DIR, `${name}.ts.template`), 'utf-8');
  return content
    .replace(/<% if \(esm\) \{ %>\.js<% \} %>/g, '.js')
    .replace(/<%.*?%>/g, '');
};

const transpileTemplate = (name: ModuleName): string => {
  const jsCode = ts.transpileModule(loadTemplate(name), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  // Point sibling imports (`./recipe.js`) at the real temp files this helper
  // writes them as.
  const withSiblings = MODULE_NAMES.reduce(
    (code, sibling) =>
      code
        .split(`./${sibling}.js`)
        .join(pathToFileURL(tmpModulePath(sibling)).href),
    jsCode,
  );
  return withSiblings
    .split('../checkov.js')
    .join(pathToFileURL(checkovTmpModulePath()).href);
};

const transpileCheckovTemplate = (): string =>
  ts.transpileModule(
    readFileSync(CHECKOV_TEMPLATE, 'utf-8')
      .replace(/<% if \(esm\) \{ %>\.js<% \} %>/g, '.js')
      .replace(/<%.*?%>/g, ''),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;

// The vended modules are transpiled from `.ts.template` sources that don't
// exist as real `.ts` files on disk, so their real types aren't statically
// resolvable here - these narrow interfaces describe only what this spec
// calls, mirroring `greengrass-scripts.spec.ts`'s `RecipeUtilsModule` /
// `ZipWriterModule` pattern for the same reason.
interface RecipeModuleShape {
  readonly readRecipeSummary: (
    yamlSource: string,
    recipePath: string,
  ) => { componentName: string; componentVersion: string; raw: any };
  readonly substituteArtifactUris: (raw: any, substitution: any) => string[];
}

interface ArtifactBucketModuleShape {
  readonly GreengrassArtifactBucket: new (
    scope: import('constructs').Construct,
    id: string,
    props?: any,
  ) => {
    readonly bucket: import('aws-cdk-lib/aws-s3').IBucket;
    grantReadTo: (grantee: any, keyPrefix?: string) => unknown;
  };
}

interface ComponentVersionModuleShape {
  readonly GreengrassComponentVersion: new (
    scope: import('constructs').Construct,
    id: string,
    props: any,
  ) => {
    readonly componentName: string;
    readonly componentVersion: string;
    readonly cfnComponentVersion: import('aws-cdk-lib').CfnResource;
  };
}

interface DeploymentModuleShape {
  readonly GreengrassDeployment: new (
    scope: import('constructs').Construct,
    id: string,
    props: any,
  ) => {
    readonly thingGroup?: unknown;
    readonly targetArn: unknown;
    readonly deployment: import('aws-cdk-lib').CfnResource;
    dependOn: (
      ...componentVersions: import('constructs').IDependable[]
    ) => unknown;
  };
}

let cdkLib: typeof import('aws-cdk-lib');
let assertionsLib: typeof import('aws-cdk-lib/assertions');
let RecipeModule: RecipeModuleShape;
let ArtifactBucketModule: ArtifactBucketModuleShape;
let ComponentVersionModule: ComponentVersionModuleShape;
let DeploymentModule: DeploymentModuleShape;

// Holds the fake `greengrass-build` output `writeBuildOutput` writes, shared by
// every spec that needs a real component version.
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'greengrass-component-version-'));
  writeFileSync(checkovTmpModulePath(), transpileCheckovTemplate());
  for (const name of MODULE_NAMES) {
    writeFileSync(tmpModulePath(name), transpileTemplate(name));
  }
  cdkLib = await import('aws-cdk-lib');
  assertionsLib = await import('aws-cdk-lib/assertions');
  RecipeModule = await import(pathToFileURL(tmpModulePath('recipe')).href);
  ArtifactBucketModule = await import(
    pathToFileURL(tmpModulePath('artifact-bucket')).href
  );
  ComponentVersionModule = await import(
    pathToFileURL(tmpModulePath('component-version')).href
  );
  DeploymentModule = await import(
    pathToFileURL(tmpModulePath('deployment')).href
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  for (const name of MODULE_NAMES) {
    try {
      unlinkSync(tmpModulePath(name));
    } catch {
      // already cleaned up
    }
  }
});

/**
 * Writes a `greengrass-build`-shaped recipe and artifact pair under {@link tmpDir},
 * which `GreengrassComponentVersion` reads at synth time.
 */
const writeBuildOutput = (
  componentName: string,
  componentVersion: string,
  artifactContent: string,
  // Defaults to matching the recipe. Override to exercise the guard against
  // a recipe naming an artifact the build never produced.
  artifactFileName = 'my-component.zip',
): { recipesDir: string; artifactsDir: string } => {
  const recipesDir = join(tmpDir, componentName, componentVersion, 'recipes');
  const artifactsDir = join(
    tmpDir,
    componentName,
    componentVersion,
    'artifacts',
  );
  mkdirSync(recipesDir, { recursive: true });
  mkdirSync(join(artifactsDir, componentName, componentVersion), {
    recursive: true,
  });
  writeFileSync(
    join(recipesDir, `${componentName}-${componentVersion}.yaml`),
    [
      'RecipeFormatVersion: 2020-01-25',
      `ComponentName: ${componentName}`,
      `ComponentVersion: ${componentVersion}`,
      'Manifests:',
      '  - Artifacts:',
      `      - Uri: s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component.zip`,
    ].join('\n'),
  );
  writeFileSync(
    join(artifactsDir, componentName, componentVersion, artifactFileName),
    artifactContent,
  );
  return { recipesDir, artifactsDir };
};

describe('recipe.ts (readRecipeSummary / substituteArtifactUris)', () => {
  it('extracts ComponentName and ComponentVersion', () => {
    const { componentName, componentVersion } = RecipeModule.readRecipeSummary(
      [
        'RecipeFormatVersion: 2020-01-25',
        'ComponentName: com.example.MyComponent',
        'ComponentVersion: 1.0.0',
        'Manifests: []',
      ].join('\n'),
      'recipe.yaml',
    );
    expect(componentName).toBe('com.example.MyComponent');
    expect(componentVersion).toBe('1.0.0');
  });

  it('throws an actionable error when ComponentName or ComponentVersion is missing', () => {
    expect(() =>
      RecipeModule.readRecipeSummary('Manifests: []', 'recipe.yaml'),
    ).toThrow(/ComponentName/);
  });

  it('substitutes only Uris carrying the GDK placeholder prefix, leaving others untouched', () => {
    const raw = {
      Manifests: [
        {
          Artifacts: [
            {
              Uri: 's3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component.zip',
            },
            { Uri: 's3://already-published-bucket/some/other/key.zip' },
          ],
        },
      ],
    };

    const substituted = RecipeModule.substituteArtifactUris(raw, {
      bucketName: 'real-bucket',
      componentName: 'com.example.MyComponent',
      componentVersion: '1.0.0',
      sha256: 'deadbeef',
    });

    // Only the placeholder URI's basename is reported back.
    expect(substituted).toEqual(['my-component.zip']);

    expect(raw.Manifests[0].Artifacts[0].Uri).toBe(
      's3://real-bucket/com.example.MyComponent/1.0.0/deadbeef/my-component.zip',
    );
    // Not a placeholder - left exactly as authored.
    expect(raw.Manifests[0].Artifacts[1].Uri).toBe(
      's3://already-published-bucket/some/other/key.zip',
    );
  });
});

describe('GreengrassArtifactBucket', () => {
  it('is retained, versioned, SSE-S3 encrypted, blocks public access and enforces TLS', () => {
    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    new ArtifactBucketModule.GreengrassArtifactBucket(stack, 'ArtifactBucket');

    const template = assertionsLib.Template.fromStack(stack);

    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: assertionsLib.Match.objectLike({
        VersioningConfiguration: { Status: 'Enabled' },
        BucketEncryption: assertionsLib.Match.objectLike({
          ServerSideEncryptionConfiguration: [
            assertionsLib.Match.objectLike({
              ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
            }),
          ],
        }),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }),
    });

    // enforceSSL: true - a deny statement for non-TLS requests.
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: assertionsLib.Match.objectLike({
        Statement: assertionsLib.Match.arrayWith([
          assertionsLib.Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  it('imports an existing bucket by name instead of creating one', () => {
    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    new ArtifactBucketModule.GreengrassArtifactBucket(stack, 'ArtifactBucket', {
      existingBucketName: 'my-existing-bucket',
    });

    const template = assertionsLib.Template.fromStack(stack);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  it('grantReadTo grants exactly s3:GetObject, scoped to the given prefix', async () => {
    const iam = await import('aws-cdk-lib/aws-iam');
    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    const artifactBucket = new ArtifactBucketModule.GreengrassArtifactBucket(
      stack,
      'ArtifactBucket',
    );
    const grantee = new iam.Role(stack, 'Grantee', {
      assumedBy: new iam.ServicePrincipal('greengrass.amazonaws.com'),
    });

    artifactBucket.grantReadTo(grantee, 'com.example.MyComponent/*');

    const template = assertionsLib.Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: assertionsLib.Match.objectLike({
        Statement: assertionsLib.Match.arrayWith([
          assertionsLib.Match.objectLike({
            Action: 's3:GetObject',
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });
});

describe('GreengrassComponentVersion', () => {
  const sha256Of = (content: string): string =>
    createHash('sha256').update(content).digest('hex');

  it('uploads the artifact, substitutes the recipe placeholders, and depends on the upload', () => {
    const { recipesDir, artifactsDir } = writeBuildOutput(
      'com.example.DependsOnTest',
      '1.0.0',
      'artifact bytes v1',
    );

    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    const bucket = new ArtifactBucketModule.GreengrassArtifactBucket(
      stack,
      'ArtifactBucket',
    );
    const componentVersion =
      new ComponentVersionModule.GreengrassComponentVersion(
        stack,
        'ComponentVersion',
        { recipesDir, artifactsDir, bucket },
      );

    const template = assertionsLib.Template.fromStack(stack);
    const json = template.toJSON();
    const resources = json.Resources as Record<string, any>;

    const cfnLogicalId = stack.getLogicalId(
      componentVersion.cfnComponentVersion,
    );
    const componentVersionResource = resources[cfnLogicalId];
    expect(componentVersionResource.Type).toBe(
      'AWS::GreengrassV2::ComponentVersion',
    );
    expect(componentVersionResource.DeletionPolicy).toBe('Retain');
    expect(componentVersionResource.UpdateReplacePolicy).toBe('Retain');

    // DependsOn must reach a Custom::CDKBucketDeployment resource - referencing
    // the bucket's name in InlineRecipe does not make CloudFormation wait for
    // the upload custom resource on its own.
    const dependsOn: string[] = Array.isArray(
      componentVersionResource.DependsOn,
    )
      ? componentVersionResource.DependsOn
      : [componentVersionResource.DependsOn];
    expect(dependsOn.length).toBeGreaterThan(0);
    const dependedOnTypes = dependsOn.map((id) => resources[id]?.Type);
    expect(dependedOnTypes).toContain('Custom::CDKBucketDeployment');

    const sha256 = sha256Of('artifact bytes v1');
    const bucketDeploymentResource = Object.values(resources).find(
      (r: any) => r.Type === 'Custom::CDKBucketDeployment',
    ) as any;
    expect(bucketDeploymentResource.Properties.DestinationBucketKeyPrefix).toBe(
      `com.example.DependsOnTest/1.0.0/${sha256}/`,
    );
    // `extract` must stay at its default. The handler syncs the *unpacked*
    // asset, so each file keeps its own name under the prefix; `extract:
    // false` would publish the archive under the CDK asset's hashed file name
    // instead, which the recipe's artifact URI could never reference.
    expect([undefined, true, 'true']).toContain(
      bucketDeploymentResource.Properties.Extract,
    );

    // InlineRecipe carries the substituted Uri with the sha256 path segment,
    // and the zip's basename survives untouched.
    const inlineRecipe = componentVersionResource.Properties.InlineRecipe;
    expect(inlineRecipe).toEqual(
      expect.objectContaining({ 'Fn::Join': expect.anything() }),
    );
    const renderedRecipe = (inlineRecipe['Fn::Join'][1] as unknown[])
      .filter((part): part is string => typeof part === 'string')
      .join('');
    expect(renderedRecipe).toContain(
      `/com.example.DependsOnTest/1.0.0/${sha256}/my-component.zip`,
    );

    expect(componentVersion.componentName).toBe('com.example.DependsOnTest');
    expect(componentVersion.componentVersion).toBe('1.0.0');
    void bucket;
  });

  it('throws when the recipe references an artifact the build did not produce', () => {
    const { recipesDir, artifactsDir } = writeBuildOutput(
      'com.example.BasenameMismatch',
      '1.0.0',
      'content',
      'renamed-by-hand.zip',
    );

    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    const bucket = new ArtifactBucketModule.GreengrassArtifactBucket(
      stack,
      'ArtifactBucket',
    );

    expect(
      () =>
        new ComponentVersionModule.GreengrassComponentVersion(
          stack,
          'ComponentVersion',
          { recipesDir, artifactsDir, bucket },
        ),
    ).toThrow(/renamed-by-hand\.zip/);
  });

  it('fails synth when the same version is claimed twice with a different content hash', () => {
    const { recipesDir: recipesDirA, artifactsDir: artifactsDirA } =
      writeBuildOutput('com.example.DriftTest', '1.0.0', 'content A');

    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    const bucket = new ArtifactBucketModule.GreengrassArtifactBucket(
      stack,
      'ArtifactBucket',
    );
    new ComponentVersionModule.GreengrassComponentVersion(
      stack,
      'ComponentVersionA',
      { recipesDir: recipesDirA, artifactsDir: artifactsDirA, bucket },
    );

    // A second build directory for the SAME componentName@componentVersion,
    // with genuinely different artifact bytes - eg the user forgot to bump
    // ComponentVersion after editing the component.
    const recipesDirB = join(
      tmpDir,
      'com.example.DriftTest',
      '1.0.0',
      'recipes-b',
    );
    const artifactsDirB = join(
      tmpDir,
      'com.example.DriftTest',
      '1.0.0',
      'artifacts-b',
    );
    mkdirSync(recipesDirB, { recursive: true });
    mkdirSync(join(artifactsDirB, 'com.example.DriftTest', '1.0.0'), {
      recursive: true,
    });
    writeFileSync(
      join(recipesDirB, 'com.example.DriftTest-1.0.0.yaml'),
      [
        'RecipeFormatVersion: 2020-01-25',
        'ComponentName: com.example.DriftTest',
        'ComponentVersion: 1.0.0',
        'Manifests:',
        '  - Artifacts:',
        '      - Uri: s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component.zip',
      ].join('\n'),
    );
    writeFileSync(
      join(artifactsDirB, 'com.example.DriftTest', '1.0.0', 'my-component.zip'),
      'content B - genuinely different',
    );

    expect(
      () =>
        new ComponentVersionModule.GreengrassComponentVersion(
          stack,
          'ComponentVersionB',
          { recipesDir: recipesDirB, artifactsDir: artifactsDirB, bucket },
        ),
    ).toThrow(/immutable/i);
  });

  it('throws an actionable error when the recipes directory holds more than one recipe', () => {
    const { recipesDir, artifactsDir } = writeBuildOutput(
      'com.example.MultiRecipe',
      '1.0.0',
      'content',
    );
    writeFileSync(join(recipesDir, 'extra.yaml'), 'ComponentName: x');

    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    const bucket = new ArtifactBucketModule.GreengrassArtifactBucket(
      stack,
      'ArtifactBucket',
    );

    expect(
      () =>
        new ComponentVersionModule.GreengrassComponentVersion(
          stack,
          'ComponentVersion',
          {
            recipesDir,
            artifactsDir,
            bucket,
          },
        ),
    ).toThrow(/Expected exactly one/);
  });
});

describe('GreengrassDeployment', () => {
  it('creates a thing group and targets its ARN', () => {
    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    const deployment = new DeploymentModule.GreengrassDeployment(
      stack,
      'Deployment',
      { thingGroupName: 'my-things' },
    );

    const template = assertionsLib.Template.fromStack(stack);
    template.hasResourceProperties('AWS::IoT::ThingGroup', {
      ThingGroupName: 'my-things',
    });

    const json = template.toJSON();
    const resources = json.Resources as Record<string, any>;
    const deploymentLogicalId = stack.getLogicalId(deployment.deployment);
    expect(resources[deploymentLogicalId].DeletionPolicy).toBe('Retain');
    expect(resources[deploymentLogicalId].UpdateReplacePolicy).toBe('Retain');
    expect(deployment.thingGroup).toBeDefined();
  });

  it('dependOn orders the deployment after the given component versions', () => {
    const { recipesDir, artifactsDir } = writeBuildOutput(
      'com.example.DependOnOrdering',
      '1.0.0',
      'artifact bytes',
    );

    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    const bucket = new ArtifactBucketModule.GreengrassArtifactBucket(
      stack,
      'ArtifactBucket',
    );
    const componentVersion =
      new ComponentVersionModule.GreengrassComponentVersion(
        stack,
        'ComponentVersion',
        { recipesDir, artifactsDir, bucket },
      );
    const deployment = new DeploymentModule.GreengrassDeployment(
      stack,
      'Deployment',
      {
        thingGroupName: 'my-things',
        components: {
          'com.example.DependOnOrdering': { componentVersion: '1.0.0' },
        },
      },
    );

    deployment.dependOn(componentVersion);

    const json = assertionsLib.Template.fromStack(stack).toJSON();
    const resources = json.Resources as Record<string, any>;
    const deploymentResource =
      resources[stack.getLogicalId(deployment.deployment)];
    const dependsOn: string[] = Array.isArray(deploymentResource.DependsOn)
      ? deploymentResource.DependsOn
      : [deploymentResource.DependsOn].filter(Boolean);

    // CloudFormation creates unrelated resources in parallel; without this edge
    // the IoT job can reach devices before the version exists in the registry.
    const componentVersionLogicalId = stack.getLogicalId(
      componentVersion.cfnComponentVersion,
    );
    expect(resources[componentVersionLogicalId].Type).toBe(
      'AWS::GreengrassV2::ComponentVersion',
    );
    expect(dependsOn).toContain(componentVersionLogicalId);
  });

  it('imports an existing thing by name without creating a thing group', () => {
    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    const deployment = new DeploymentModule.GreengrassDeployment(
      stack,
      'Deployment',
      { thingName: 'my-thing' },
    );

    const template = assertionsLib.Template.fromStack(stack);
    template.resourceCountIs('AWS::IoT::ThingGroup', 0);
    // `formatArn` returns an unresolved token at construct-authoring time;
    // it only becomes an `Fn::Join` once the template is synthesized.
    expect(cdkLib.Token.isUnresolved(deployment.targetArn)).toBe(true);

    const json = template.toJSON();
    const deploymentLogicalId = stack.getLogicalId(deployment.deployment);
    expect(json.Resources[deploymentLogicalId].Properties.TargetArn).toEqual(
      expect.objectContaining({ 'Fn::Join': expect.anything() }),
    );
  });

  it('throws when more than one target option is provided', () => {
    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    expect(
      () =>
        new DeploymentModule.GreengrassDeployment(stack, 'Deployment', {
          thingGroupName: 'my-things',
          thingName: 'my-thing',
        }),
    ).toThrow(/exactly one/);
  });

  it('throws when a literal targetArn belongs to a different account/region than the stack', () => {
    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    expect(
      () =>
        new DeploymentModule.GreengrassDeployment(stack, 'Deployment', {
          targetArn:
            'arn:aws:iot:eu-west-1:222222222222:thinggroup/other-account-group',
        }),
    ).toThrow(/does not match stack/);
  });

  it('accepts a literal targetArn on an environment-agnostic stack', () => {
    // No `env`, so the stack's own account and region are unresolved tokens.
    // Comparing a real account number against a token would reject every ARN.
    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack');
    const deployment = new DeploymentModule.GreengrassDeployment(
      stack,
      'Deployment',
      {
        targetArn: 'arn:aws:iot:eu-west-1:222222222222:thinggroup/my-group',
      },
    );
    expect(deployment.targetArn).toBe(
      'arn:aws:iot:eu-west-1:222222222222:thinggroup/my-group',
    );
  });

  it('accepts a matching literal targetArn', () => {
    const app = new cdkLib.App();
    const stack = new cdkLib.Stack(app, 'TestStack', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const deployment = new DeploymentModule.GreengrassDeployment(
      stack,
      'Deployment',
      {
        targetArn: 'arn:aws:iot:us-east-1:111111111111:thinggroup/my-group',
      },
    );
    expect(deployment.targetArn).toBe(
      'arn:aws:iot:us-east-1:111111111111:thinggroup/my-group',
    );
  });
});

// Terraform has no `aws-cdk-lib`/`assertions` equivalent to synth against, so
// these assert directly on the rendered `.tf` text `generateFiles` produces -
// the same real EJS rendering path the generators use, just invoked here on a
// bare `createTreeUsingTsSolutionSetup()` tree rather than through a full
// component/deployment generator run.
describe('terraform core modules (via hashicorp/awscc)', () => {
  let tree: Tree;
  const declaration = declareDependencies()({
    ts: [...GREENGRASS_CONSTRUCTS_DEPENDENCIES],
  });

  beforeEach(() => {
    tree = createTreeUsingTsSolutionSetup();
  });

  const readCore = (name: string): string =>
    tree.read(
      `packages/common/terraform/src/core/greengrass/${name}/main.tf`,
      'utf-8',
    )!;

  it('vends all three modules with pinned required_providers blocks', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);

    // Every provider a module uses must be declared in that module's own
    // `required_providers` - one it uses but never declares is inherited from
    // the root module UNPINNED, bypassing the versions vended here. Derived
    // from the `resource`/`data` block types the way the
    // `terraform-declare-used-providers` migration derives it, rather than
    // hand-listed, so a module gaining a resource from a new provider fails
    // here instead of shipping unpinned.
    for (const name of ['artifact-bucket', 'component-version', 'deployment']) {
      const content = readCore(name);
      const used = new Set(
        [...content.matchAll(/^(?:resource|data) "([a-z0-9]+)_[a-z0-9_]+"/gm)]
          .map((match) => match[1])
          // `terraform_data` is built in to Terraform: no entry, no version.
          .filter((provider) => provider !== 'terraform'),
      );
      expect(used.size).toBeGreaterThan(0);
      for (const provider of used) {
        expect(content).toContain(`source  = "hashicorp/${provider}"`);
      }
    }

    expect(readCore('component-version')).toContain(
      'resource "awscc_greengrassv2_component_version" "this"',
    );
    // The one the previous version of this test missed: `aws_s3_object` makes
    // the component-version module an `aws` consumer as well as an `awscc` one.
    expect(readCore('component-version')).toContain(
      'resource "aws_s3_object" "artifact"',
    );
    expect(readCore('deployment')).toContain(
      'resource "awscc_greengrassv2_deployment" "this"',
    );
    expect(readCore('deployment')).toContain(
      'resource "aws_iot_thing_group" "this"',
    );
  });

  it('retains the artifact bucket, and orders replacements create-before-destroy', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);

    // The bucket is the only resource `RemovalPolicy.RETAIN` maps onto
    // cleanly: nothing about it forces a replacement, so `prevent_destroy`
    // only ever refuses a genuine teardown.
    const bucket = readCore('artifact-bucket');
    expect(
      bucket.slice(bucket.indexOf('resource "aws_s3_bucket" "bucket"')),
    ).toContain('prevent_destroy = true');

    // On the component version and the deployment it would instead reject the
    // replacement an ordinary version bump or deployment revision needs, so it
    // must NOT be there. `create_before_destroy` is what keeps the safety
    // property: the new version is published (and rejected by
    // `CreateComponentVersion` if it reuses a version with different content)
    // before the outgoing one is deleted.
    for (const [name, resourceBlock] of [
      [
        'component-version',
        'resource "awscc_greengrassv2_component_version" "this"',
      ],
      ['component-version', 'resource "aws_s3_object" "artifact"'],
      ['deployment', 'resource "awscc_greengrassv2_deployment" "this"'],
    ] as const) {
      const content = readCore(name);
      const afterResource = content.slice(content.indexOf(resourceBlock));
      const lifecycle = afterResource.slice(
        afterResource.indexOf('lifecycle {'),
      );
      expect(lifecycle).toContain('create_before_destroy = true');
      expect(lifecycle.slice(0, lifecycle.indexOf('}'))).not.toContain(
        'prevent_destroy',
      );
    }
  });

  it('component-version depends on the uploaded artifact object, not just the recipe reference', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);

    const content = readCore('component-version');
    expect(content).toContain(
      'depends_on = [aws_s3_object.artifact]',
    );
  });

  it('uploads the artifact under a sha256-hashed key prefix, and substitutes only the GDK placeholder Uri', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);

    const content = readCore('component-version');
    // The hash lives in the prefix, not the basename - see the doc comment on
    // `destination_key_prefix`/`replacement_prefix`.
    expect(content).toContain(
      'destination_key_prefix = "${local.component_name}/${local.component_version}/${local.sha256}/"',
    );
    expect(content).toContain('key         = "${local.destination_key_prefix}${local.artifact_basename}"');
    expect(content).toContain(
      'placeholder_prefix = "s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/"',
    );
    // Only the placeholder-prefixed Uri is rewritten; every other Uri (and
    // every other field) passes through the `merge(...)` untouched.
    expect(content).toContain('startswith(artifact.Uri, local.placeholder_prefix)');
    expect(content).toContain(': artifact.Uri');
  });

  it('guards against more than one recipe or artifact file, and a recipe/artifact basename mismatch', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);

    const content = readCore('component-version');
    expect(content).toContain('resource "terraform_data" "guard"');
    expect(content).toContain('length(local.recipe_files) == 1');
    expect(content).toContain('length(local.artifact_files) == 1');
    expect(content).toContain('length(local.mismatched_basenames) == 0');
  });

  it('deployment requires exactly one of thing_group_name, thing_name or target_arn', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);

    const content = readCore('deployment');
    expect(content).toContain('length(local.target_inputs_provided) == 1');
    expect(content).toContain('requires exactly one of thing_group_name, thing_name or target_arn');
  });

  it('cross-checks a literal target_arn against the caller identity, region and partition', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);

    // The CDK construct's `assertArnMatchesStack`. Verified against the real
    // terraform CLI: the mocked identity reaches this precondition through a
    // nested module from a root-level `mock_data "aws_caller_identity"`, which
    // is exactly what the generated plan test writes.
    const content = readCore('deployment');
    expect(content).toContain('length(local.target_arn_mismatches) == 0');
    expect(content).toContain('data.aws_caller_identity.current.account_id');
    expect(content).toContain('data.aws_region.current.region');
    expect(content).toContain('data.aws_partition.current.partition');
    expect(content).toContain(
      'looks like it belongs to a different environment',
    );
  });

  it('leaves a recipe without Manifests, and a manifest without Artifacts, without those keys', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);

    // HCL forbids a conditional whose arms have different types, so "add the
    // key only when the authored recipe had it" is expressed as a zero- or
    // one-element list expanded into `merge`. An unconditional
    // `merge(x, { Manifests = ... })` would add an empty list to every recipe
    // that has no manifests.
    const content = readCore('component-version');
    expect(content).toContain('range(can(local.recipe.Manifests) ? 1 : 0)');
    expect(content).toContain('range(can(manifest.Artifacts) ? 1 : 0)');
    // The unconditional forms these replaced, which would add the key to every
    // recipe. (`try(manifest.Artifacts, [])` is still correct in
    // `substituted_basenames`, which only enumerates names.)
    expect(content).not.toContain('merge(local.recipe, { Manifests');
    expect(content).not.toContain('merge(manifest, {');
  });

  it('grants s3:GetObject, scoped to the given prefix, when a token exchange role is configured', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);

    const content = readCore('artifact-bucket');
    expect(content).toContain('resource "aws_iam_role_policy" "token_exchange_read"');
    expect(content).toContain('Action   = "s3:GetObject"');
    expect(content).toContain(
      'Resource = "${local.bucket_arn}/${var.token_exchange_key_prefix}"',
    );
  });

  it('is idempotent: re-running fully regenerates the framework-owned core modules', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);
    const before = readCore('deployment');
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);
    expect(readCore('deployment')).toBe(before);
  });

  it('does not add js-yaml to any package.json - the terraform path never installs it', async () => {
    await addGreengrassCoreConstructs(tree, { iac: 'terraform' }, declaration);
    expect(tree.exists('packages/common/terraform/package.json')).toBe(false);
  });
});

describe('terraform app modules', () => {
  let tree: Tree;
  const declaration = declareDependencies()({
    ts: [...GREENGRASS_CONSTRUCTS_DEPENDENCIES],
  });

  beforeEach(async () => {
    tree = createTreeUsingTsSolutionSetup();
    // `addArtifactProjectToSharedTargets` updates this project's targets, so
    // it must already exist - `sharedConstructsGenerator` is what creates it
    // in the real generator flow.
    await terraformProjectGenerator(tree, {
      name: 'terraform',
      directory: 'packages/common',
      type: 'library',
    });
  });

  it('vends a per-component module taking the bucket name as a plain variable', async () => {
    await addGreengrassComponentAppConstruct(
      tree,
      {
        iac: 'terraform',
        componentNameClassName: 'MyComponent',
        componentDisplayName: 'com.example.MyComponent',
        componentDirName: 'my-component',
        project: 'my-project',
        hostProjectName: 'my-project',
        recipesDirFromRoot:
          'dist/apps/my-project/greengrass/my-component/greengrass-build/recipes',
        artifactsDirFromRoot:
          'dist/apps/my-project/greengrass/my-component/greengrass-build/artifacts',
      },
      declaration,
    );

    const modulePath =
      'packages/common/terraform/src/app/greengrass-component/my-component/my-component.tf';
    expect(tree.exists(modulePath)).toBe(true);
    const content = tree.read(modulePath, 'utf-8')!;
    expect(content).toContain('variable "bucket_name"');
    expect(content).toContain(
      'source = "../../../core/greengrass/component-version"',
    );
    expect(content).toContain(
      'dist/apps/my-project/greengrass/my-component/greengrass-build/recipes',
    );
  });

  it('vends the deployment and artifact-bucket modules as separate sibling directories, to avoid a dependency cycle', async () => {
    await addGreengrassDeploymentAppConstruct(
      tree,
      {
        iac: 'terraform',
        name: 'MyDeployment',
        nameClassName: 'MyDeployment',
        nameKebabCase: 'my-deployment',
        targetPropLine: `thingGroupName: 'my-things',`,
        targetPropLineTf: `thing_group_name = "my-things"`,
        targetDescription: 'a new thing group ("my-things")',
        parentTargetArn: undefined,
        tokenExchangeRoleArn: undefined,
        artifactBucketImported: false,
        artifactBucketName: undefined,
        deploymentPoliciesLiteral: undefined,
        deploymentPoliciesLiteralTf: undefined,
        libraryImportPath: '@proj/my-deployment',
        componentsJsonPathFromRoot: 'packages/my-deployment/src/components.json',
      },
      declaration,
    );

    const deploymentPath =
      'packages/common/terraform/src/app/greengrass-deployment/my-deployment/my-deployment.tf';
    const bucketPath =
      'packages/common/terraform/src/app/greengrass-deployment/my-deployment-artifact-bucket/my-deployment-artifact-bucket.tf';
    expect(tree.exists(deploymentPath)).toBe(true);
    expect(tree.exists(bucketPath)).toBe(true);

    const deploymentContent = tree.read(deploymentPath, 'utf-8')!;
    expect(deploymentContent).toContain('thing_group_name = "my-things"');
    expect(deploymentContent).toContain('packages/my-deployment/src/components.json');
    // Neither module block references the other - the caller wires the
    // ordering itself with `depends_on` on the `deployment` module block.
    expect(deploymentContent).not.toContain('module "artifact_bucket"');

    const bucketContent = tree.read(bucketPath, 'utf-8')!;
    expect(bucketContent).toContain(
      'source = "../../../core/greengrass/artifact-bucket"',
    );
  });

  it('renders the imported-bucket and token-exchange-role branches without leftover EJS tags', async () => {
    await addGreengrassDeploymentAppConstruct(
      tree,
      {
        iac: 'terraform',
        name: 'MyDeployment',
        nameClassName: 'MyDeployment',
        nameKebabCase: 'my-deployment',
        targetPropLine: `targetArn: 'arn:aws:iot:us-east-1:111111111111:thinggroup/my-group',`,
        targetPropLineTf: `target_arn = "arn:aws:iot:us-east-1:111111111111:thinggroup/my-group"`,
        targetDescription: 'an existing target',
        parentTargetArn:
          'arn:aws:iot:us-east-1:111111111111:thinggroup/parent-group',
        tokenExchangeRoleArn:
          'arn:aws:iam::111111111111:role/GreengrassTokenExchangeRole',
        artifactBucketImported: true,
        artifactBucketName: 'my-existing-bucket',
        deploymentPoliciesLiteral: `{ failureHandlingPolicy: 'DO_NOTHING' }`,
        deploymentPoliciesLiteralTf: `{ failure_handling_policy = "DO_NOTHING" }`,
        libraryImportPath: '@proj/my-deployment',
        componentsJsonPathFromRoot: 'packages/my-deployment/src/components.json',
      },
      declaration,
    );

    const deploymentContent = tree.read(
      'packages/common/terraform/src/app/greengrass-deployment/my-deployment/my-deployment.tf',
      'utf-8',
    )!;
    expect(deploymentContent).not.toContain('<%');
    expect(deploymentContent).toContain(
      'parent_target_arn = "arn:aws:iot:us-east-1:111111111111:thinggroup/parent-group"',
    );
    expect(deploymentContent).toContain(
      'deployment_policies = { failure_handling_policy = "DO_NOTHING" }',
    );

    const bucketContent = tree.read(
      'packages/common/terraform/src/app/greengrass-deployment/my-deployment-artifact-bucket/my-deployment-artifact-bucket.tf',
      'utf-8',
    )!;
    expect(bucketContent).not.toContain('<%');
    expect(bucketContent).toContain(
      'existing_bucket_name = "my-existing-bucket"',
    );
    expect(bucketContent).toContain(
      'token_exchange_role_arn = "arn:aws:iam::111111111111:role/GreengrassTokenExchangeRole"',
    );
  });

  it('is idempotent: re-running twice registers the artifact dependency exactly once', async () => {
    const options = {
      iac: 'terraform' as const,
      componentNameClassName: 'MyComponent',
      componentDisplayName: 'com.example.MyComponent',
      componentDirName: 'my-component',
      project: 'my-project',
      hostProjectName: 'my-project',
      recipesDirFromRoot:
        'dist/apps/my-project/greengrass/my-component/greengrass-build/recipes',
      artifactsDirFromRoot:
        'dist/apps/my-project/greengrass/my-component/greengrass-build/artifacts',
    };
    await addGreengrassComponentAppConstruct(tree, options, declaration);
    await addGreengrassComponentAppConstruct(tree, options, declaration);

    const sharedTerraformConfig = JSON.parse(
      tree.read('packages/common/terraform/project.json', 'utf-8') ?? '{}',
    );
    expect(
      sharedTerraformConfig.targets.build.dependsOn.filter(
        (d: string) => d === 'my-project:build',
      ),
    ).toHaveLength(1);
  });
});
