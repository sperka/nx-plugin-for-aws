/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInstallCommand } from '../../../packages/nx-plugin/src/utils/commands';
import { getDungeonDiceDependencies, runCLI } from '../utils';

const fixtureRoot = join(__dirname, '../files/dungeon-adventure/dice');
const copyFixture = (workspace: string, relativePath: string, name: string) =>
  writeFileSync(
    join(workspace, relativePath),
    readFileSync(join(fixtureRoot, name), 'utf8'),
  );

function templates(directory: string): any[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return templates(path);
    return entry.name.endsWith('.template.json')
      ? [JSON.parse(readFileSync(path, 'utf8'))]
      : [];
  });
}

/** Continue the completed base tutorial using the optional route's exact files. */
export async function exerciseDungeonDice(workspace: string) {
  const opts = { cwd: workspace, env: { NX_DAEMON: 'false' } };
  await runCLI(
    'generate @aws/nx-plugin:py#project --name=edge --no-interactive',
    opts,
  );
  await runCLI(
    'generate @aws/nx-plugin:greengrass#component --project=edge --name=dice --language=python --componentName=com.example.DungeonDice --componentVersion=NEXT_PATCH --platform=linux-amd64 --ipc=true --infra=component-version --iac=cdk --no-interactive',
    opts,
  );
  await runCLI(
    buildInstallCommand(
      'pnpm',
      getDungeonDiceDependencies(),
      false,
      '@dungeon-adventure/inventory',
    ),
    { ...opts, prefixWithPackageManagerCmd: false },
  );
  copyFixture(
    workspace,
    'packages/edge/greengrass/dice/main.py',
    'main.py.template',
  );
  copyFixture(
    workspace,
    'packages/edge/tests/greengrass/test_dice.py',
    'test_dice.py.template',
  );
  writeFileSync(
    join(workspace, 'packages/edge/greengrass/dice/recipe.yaml'),
    readFileSync(join(fixtureRoot, 'recipe.yaml.template'), 'utf8').replaceAll(
      'REPLACE_WITH_CORE_THING_NAME',
      'gg-dungeon-dice-core',
    ),
  );
  for (const name of ['roll-dice', 'register-dice']) {
    copyFixture(
      workspace,
      `packages/inventory/src/mcp-server/${name}.ts`,
      `${name}.ts.template`,
    );
  }
  const serverPath = join(
    workspace,
    'packages/inventory/src/mcp-server/server.ts',
  );
  const server = readFileSync(serverPath, 'utf8');
  if (!server.includes('return server;'))
    throw new Error('Inventory MCP server no longer matches the tutorial.');
  writeFileSync(
    serverPath,
    `import { registerDiceTool } from './register-dice.js';\n${server.replace('return server;', 'registerDiceTool(server);\n  return server;')}`,
  );
  copyFixture(
    workspace,
    'packages/story/dungeon_adventure_story/agent/agent.py',
    'agent.py.template',
  );
  copyFixture(
    workspace,
    'packages/infra/src/stacks/application-stack.ts',
    'application-stack.ts.template',
  );
  await runCLI('sync', opts);
  await runCLI('pnpm lint --skip-nx-cache', {
    ...opts,
    prefixWithPackageManagerCmd: false,
  });
  await runCLI('run-many --target build --all --output-style=stream', opts);
  const all = templates(join(workspace, 'dist/packages/infra/cdk.out'));
  const app = all.find((template) =>
    Object.values<any>(template.Resources).some(
      (resource) => resource.Type === 'AWS::GreengrassV2::Deployment',
    ),
  );
  expect(app).toBeDefined();
  const resources = Object.entries<any>(app.Resources);
  const version = resources.find(
    ([, resource]) => resource.Type === 'AWS::GreengrassV2::ComponentVersion',
  );
  const deployment = resources.find(
    ([, resource]) => resource.Type === 'AWS::GreengrassV2::Deployment',
  );
  const attachment = resources.find(
    ([, resource]) => resource.Type === 'AWS::IoT::PolicyPrincipalAttachment',
  );
  expect(version).toBeDefined();
  expect(attachment).toBeDefined();
  expect(
    deployment?.[1].Properties.Components['com.example.DungeonDice']
      .ComponentVersion,
  ).toEqual({ 'Fn::GetAtt': [version?.[0], 'ComponentVersion'] });
  expect(deployment?.[1].DependsOn).toContain(attachment?.[0]);
  expect(
    resources.some(([, resource]) => resource.Type === 'AWS::DynamoDB::Table'),
  ).toBe(true);
  expect(
    resources.some(
      ([, resource]) => resource.Type === 'AWS::Cognito::UserPool',
    ),
  ).toBe(true);
  const policy = resources.find(
    ([, resource]) => resource.Type === 'AWS::IoT::Policy',
  )?.[1];
  const statements = policy.Properties.PolicyDocument.Statement;
  expect(statements.map((statement: any) => statement.Action)).toEqual([
    'iot:Publish',
    'iot:Subscribe',
    'iot:Receive',
  ]);
  expect(JSON.stringify(policy)).toContain('dungeon-dice');
  expect(JSON.stringify(policy)).not.toContain('"Resource":"*"');
  expect(
    resources
      .filter(
        ([, resource]) => resource.Type === 'AWS::BedrockAgentCore::Runtime',
      )
      .some(
        ([, resource]) =>
          resource.Properties.EnvironmentVariables?.DICE_THING_NAME,
      ),
  ).toBe(true);

  // Cleanup begins with an empty deployment revision, while the game still exists.
  const stackPath = join(
    workspace,
    'packages/infra/src/stacks/application-stack.ts',
  );
  const stack = readFileSync(stackPath, 'utf8');
  writeFileSync(stackPath, stack.replace('fleet.addComponent(dice);', ''));
  await runCLI(
    'run @dungeon-adventure/infra:synth --output-style=stream',
    opts,
  );
  const empty = templates(join(workspace, 'dist/packages/infra/cdk.out')).find(
    (template) =>
      Object.values<any>(template.Resources).some(
        (resource) => resource.Type === 'AWS::GreengrassV2::Deployment',
      ),
  );
  const emptyDeployment = Object.values<any>(empty.Resources).find(
    (resource) => resource.Type === 'AWS::GreengrassV2::Deployment',
  );
  expect(emptyDeployment.Properties.Components ?? {}).toEqual({});
  writeFileSync(stackPath, stack);
}
