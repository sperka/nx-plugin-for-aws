/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { ensureDirSync } from 'fs-extra';
import { createTestWorkspace, runCLI, tmpProjPath } from '../utils';

describe('smoke test - greengrass-component', () => {
  const targetDir = `${tmpProjPath()}/greengrass-component-pnpm`;

  beforeEach(() => {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { force: true, recursive: true });
    }
    ensureDirSync(targetDir);
  });

  it('infers language and applies conditional IPC defaults and explicit values', async () => {
    const projectRoot = await createTestWorkspace(
      'pnpm',
      targetDir,
      'e2e-test',
      'cdk',
    );
    const opts = {
      cwd: projectRoot,
      env: {
        NX_DAEMON: 'false',
        // Every generator below defers its install, so the manifests run ahead
        // of the lockfile on purpose. pnpm 11 would otherwise auto-install with
        // a frozen lockfile before each `pnpm exec nx` and fail; this test only
        // inspects generated files and never builds.
        PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
      },
    };

    await runCLI(
      'generate @aws/nx-plugin:py#project --name=python-host --type=application --no-interactive --prefer-install-dependencies=false',
      opts,
    );
    await runCLI(
      'generate @aws/nx-plugin:ts#project --name=typescript-host --no-interactive --prefer-install-dependencies=false',
      opts,
    );
    // The published plugin must not resolve any of the removed generator IDs.
    // A successful run would print the generator's help instead of an error.
    for (const legacyId of [
      'py#greengrass-component',
      'ts#greengrass-component',
      'greengrass-deployment',
    ]) {
      const legacyHelp = await runCLI(
        `generate @aws/nx-plugin:${legacyId} --help`,
        { ...opts, redirectStderr: true, silenceError: true },
      );
      expect(legacyHelp).toMatch(/cannot find|not found|unable to resolve/i);
    }

    // Omit --language and --ipc. Each host marker selects the adapter, then
    // its language-specific IPC default.
    await runCLI(
      'generate @aws/nx-plugin:greengrass#component --project=e2e_test.python_host --name=python-default --infra=none --no-interactive --prefer-install-dependencies=false',
      opts,
    );
    await runCLI(
      'generate @aws/nx-plugin:greengrass#component --project=typescript-host --name=typescript-default --infra=none --no-interactive --prefer-install-dependencies=false',
      opts,
    );

    await runCLI(
      'generate @aws/nx-plugin:greengrass#component --project=e2e_test.python_host --name=python-no-ipc --ipc=false --infra=none --no-interactive --prefer-install-dependencies=false',
      opts,
    );
    await runCLI(
      'generate @aws/nx-plugin:greengrass#component --project=typescript-host --name=typescript-ipc --ipc=true --infra=none --no-interactive --prefer-install-dependencies=false',
      opts,
    );

    // py#project names the project `<scope>.python_host` but places it under
    // `packages/python_host`; Python components live under the project root.
    const pythonComponents = `${projectRoot}/packages/python_host/greengrass`;
    const typescriptComponents = `${projectRoot}/packages/typescript-host/src/greengrass`;

    expect(
      readFileSync(`${pythonComponents}/python-default/main.py`, 'utf-8'),
    ).toContain('GreengrassCoreIPCClientV2');
    expect(
      readFileSync(`${pythonComponents}/python-no-ipc/main.py`, 'utf-8'),
    ).not.toContain('GreengrassCoreIPCClientV2');
    expect(
      readFileSync(
        `${typescriptComponents}/typescript-default/main.ts`,
        'utf-8',
      ),
    ).not.toContain('greengrasscoreipc');
    expect(
      readFileSync(`${typescriptComponents}/typescript-ipc/main.ts`, 'utf-8'),
    ).toContain('greengrasscoreipc');
  });
});
