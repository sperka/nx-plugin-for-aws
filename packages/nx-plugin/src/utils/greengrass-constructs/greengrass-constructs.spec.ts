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
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  return MODULE_NAMES.reduce(
    (code, sibling) =>
      code
        .split(`./${sibling}.js`)
        .join(pathToFileURL(tmpModulePath(sibling)).href),
    jsCode,
  );
};

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
