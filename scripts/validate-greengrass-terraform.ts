/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terraformProviderVersions } from '../packages/nx-plugin/src/utils/versions.js';

type Ejs = {
  render(template: string, data: object): string;
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, '..');
const greengrassTemplates = join(
  repositoryRoot,
  'packages/nx-plugin/src/utils/greengrass-constructs/files',
);
const e2eTemplates = join(repositoryRoot, 'e2e/src/files/terraform-plan');
const requireFromNx = createRequire(
  join(repositoryRoot, 'node_modules/@nx/devkit/package.json'),
);
const ejs = requireFromNx('ejs') as Ejs;

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const render = (source: string, destination: string, data: object) => {
  write(destination, ejs.render(readFileSync(source, 'utf-8'), data));
};

const renderCore = (terraformRoot: string) => {
  const coreRoot = join(terraformRoot, 'core/greengrass');
  const versions = terraformProviderVersions();
  for (const name of ['artifact-bucket', 'component-version', 'deployment']) {
    render(
      join(
        greengrassTemplates,
        `terraform/core/greengrass/${name}/main.tf.template`,
      ),
      join(coreRoot, name, 'main.tf'),
      versions,
    );
  }
  render(
    join(greengrassTemplates, 'next-version/__nextVersionFileName__.template'),
    join(coreRoot, 'component-version/next-version.cjs'),
    { nextVersionFileName: 'next-version.cjs' },
  );
};

const renderComponent = (
  terraformRoot: string,
  componentDirName: string,
  componentDisplayName: string,
  project: string,
  recipesDirFromRoot: string,
  artifactsDirFromRoot: string,
) => {
  render(
    join(
      greengrassTemplates,
      'terraform/app/greengrass-component/__componentDirName__/__componentDirName__.tf.template',
    ),
    join(
      terraformRoot,
      `app/greengrass-component/${componentDirName}/${componentDirName}.tf`,
    ),
    {
      artifactsDirFromRoot,
      componentDirName,
      componentDisplayName,
      project,
      recipesDirFromRoot,
    },
  );
};

const renderTests = (terraformRoot: string) => {
  const testsRoot = join(terraformRoot, 'tests');
  cpSync(
    join(greengrassTemplates, 'terraform/tests/fixtures'),
    join(testsRoot, 'fixtures'),
    {
      recursive: true,
    },
  );
  render(
    join(greengrassTemplates, 'terraform/tests/greengrass.tftest.hcl.template'),
    join(testsRoot, 'greengrass.tftest.hcl'),
    terraformProviderVersions(),
  );
};

const writeComponentFixture = (
  root: string,
  fixtureName: string,
  componentName: string,
  componentVersion: string,
) => {
  const fixtureRoot = join(root, 'fixtures', fixtureName);
  write(
    join(fixtureRoot, 'recipes', `${componentName}-${componentVersion}.yaml`),
    `RecipeFormatVersion: '2020-01-25'\nComponentName: ${componentName}\nComponentVersion: ${componentVersion}\nManifests:\n  - Platform:\n      os: linux\n    Artifacts:\n      - Uri: s3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/${fixtureName}.txt\n`,
  );
  write(
    join(
      fixtureRoot,
      'artifacts',
      componentName,
      componentVersion,
      `${fixtureName}.txt`,
    ),
    `${fixtureName} artifact\n`,
  );
};

const renderComposition = (root: string) => {
  const planRoot = join(root, 'packages/infra/src');
  const versions = terraformProviderVersions();
  render(
    join(e2eTemplates, 'greengrass.tf.template'),
    join(planRoot, 'greengrass.tf'),
    {},
  );
  write(
    join(planRoot, 'versions.tf'),
    `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "${versions.awsProviderVersion}"
    }
    awscc = {
      source  = "hashicorp/awscc"
      version = "${versions.awsccProviderVersion}"
    }
    external = {
      source  = "hashicorp/external"
      version = "${versions.externalProviderVersion}"
    }
    random = {
      source  = "hashicorp/random"
      version = "${versions.randomProviderVersion}"
    }
  }
}
`,
  );
  write(
    join(planRoot, 'plan.tftest.hcl'),
    `mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { id = "us-east-1", region = "us-east-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
      dns_suffix = "amazonaws.com"
      reverse_dns_prefix = "com.amazonaws"
    }
  }
  # The awscc provider validates a deployment's target_arn against the IoT ARN
  # pattern once the value is known. A mocked thing group would otherwise
  # return a random string for its arn, failing the mocked apply run below.
  mock_resource "aws_iot_thing_group" {
    defaults = {
      arn = "arn:aws:iot:us-east-1:123456789012:thinggroup/mock-thing-group"
    }
  }
}
mock_provider "awscc" {}
mock_provider "external" {}
mock_provider "random" {}

# The TypeScript fixture recipe carries NEXT_PATCH, so its module reads
# data.external. Supply the resolver answer the mocked provider cannot; it
# differs from the Python literal so the assertions tell the two apart.
run "plan" {
  command = plan

  override_data {
    target = module.greengrass_ts_component.module.component_version.data.external.next_version[0]
    values = {
      result = {
        version = "1.0.1"
        action = "create"
        highest = "1.0.0"
        content_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  }

  # A literal recipe version reaches the root module's deployment map at plan.
  assert {
    condition     = output.greengrass_component_versions["com.test.PythonComponent"] == "1.0.0"
    error_message = "the Python wrapper must forward its literal recipe version at plan time"
  }
}

# The resolver query includes the artifact bucket name, and this composition
# creates that bucket in the same operation, so the resolved NEXT_PATCH version
# is unknown until apply (an imported bucket makes it known at plan). A mocked
# apply checks that the wrapper forwards the resolver's answer. It proves the
# value the deployment map receives, not the order AWS creates resources in.
run "apply_forwards_resolved_version" {
  command = apply

  override_data {
    target = module.greengrass_ts_component.module.component_version.data.external.next_version[0]
    values = {
      result = {
        version = "1.0.1"
        action = "create"
        highest = "1.0.0"
        content_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  }

  assert {
    condition     = output.greengrass_component_versions["com.test.TypeScriptComponent"] == "1.0.1"
    error_message = "the TypeScript wrapper must forward the resolver's NEXT_PATCH answer"
  }
}
`,
  );
};

const runTerraform = (workingDirectory: string, args: string[]) => {
  const result = spawnSync('terraform', args, {
    cwd: workingDirectory,
    encoding: 'utf-8',
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `terraform ${args.join(' ')} failed in ${relative(repositoryRoot, workingDirectory) || '.'}`,
    );
  }
};

export const runGreengrassTerraformValidation = ({
  keep = false,
}: {
  keep?: boolean;
} = {}) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'nx-plugin-greengrass-tf-'));
  const terraformRoot = join(temporaryRoot, 'packages/common/terraform/src');
  const planRoot = join(temporaryRoot, 'packages/infra/src');

  try {
    renderCore(terraformRoot);
    renderTests(terraformRoot);
    writeComponentFixture(
      temporaryRoot,
      'greengrass-python',
      'com.test.PythonComponent',
      '1.0.0',
    );
    writeComponentFixture(
      temporaryRoot,
      'greengrass-typescript',
      'com.test.TypeScriptComponent',
      'NEXT_PATCH',
    );
    renderComponent(
      terraformRoot,
      'my-greengrass-component',
      'Python Greengrass component',
      'python-greengrass-project',
      'fixtures/greengrass-python/recipes',
      'fixtures/greengrass-python/artifacts',
    );
    renderComponent(
      terraformRoot,
      'my-ts-greengrass-component',
      'TypeScript Greengrass component',
      'typescript-greengrass-project',
      'fixtures/greengrass-typescript/recipes',
      'fixtures/greengrass-typescript/artifacts',
    );
    renderComposition(temporaryRoot);
    runTerraform(temporaryRoot, ['fmt', '-recursive']);

    console.log(`Terraform validation directory: ${temporaryRoot}`);
    runTerraform(terraformRoot, ['init', '-backend=false', '-no-color']);
    runTerraform(terraformRoot, ['test', '-no-color']);
    runTerraform(planRoot, ['init', '-backend=false', '-no-color']);
    runTerraform(planRoot, ['test', '-no-color']);
    console.log(`Terraform validation passed: ${temporaryRoot}`);
  } finally {
    if (keep) {
      console.log(`Terraform validation directory retained: ${temporaryRoot}`);
    } else if (existsSync(temporaryRoot)) {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arguments_ = new Set(process.argv.slice(2));
  const unknownArguments = [...arguments_].filter(
    (argument) => argument !== '--keep',
  );
  if (unknownArguments.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknownArguments.join(', ')}. Use --keep to retain the rendered Terraform graph.`,
    );
  }
  runGreengrassTerraformValidation({ keep: arguments_.has('--keep') });
}
