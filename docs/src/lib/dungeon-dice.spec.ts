/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const fixtures = resolve(
  __dirname,
  '../../../e2e/src/files/dungeon-adventure/dice',
);
const source = readFileSync(resolve(fixtures, 'roll-dice.ts.template'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const fixtureModule = {
  exports: {} as {
    createDiceRoller: (...args: any[]) => (sides: number) => Promise<any>;
  },
};
new Function('exports', 'require', compiled)(
  fixtureModule.exports,
  createRequire(import.meta.url),
);
const { createDiceRoller } = fixtureModule.exports;

function shadowDevice(respond = true) {
  let now = 1_000_000;
  const shadow: any = { version: 1, state: { desired: {}, reported: {} } };
  let rolls = 0;
  const updates: any[] = [];
  const transport = {
    read: async () => structuredClone(shadow),
    update: async (change: any) => {
      if (change.version !== shadow.version) throw new Error('VersionConflict');
      updates.push(structuredClone(change));
      shadow.version++;
      shadow.state.desired = change.state.desired;
      const command = change.state.desired.command;
      if (command && respond) {
        rolls++;
        shadow.version++;
        shadow.state.reported.result = {
          requestId: command.requestId,
          sides: command.sides,
          value: 17,
          rolledAt: 1001,
        };
      }
    },
  };
  return {
    transport,
    updates,
    get rolls() {
      return rolls;
    },
    get shadow() {
      return shadow;
    },
    roll: createDiceRoller(
      transport,
      () => now,
      async () => {
        now += 1000;
      },
    ),
  };
}

describe('Dungeon Greengrass dice tutorial', () => {
  it('returns the device result and releases its own request slot', async () => {
    const device = shadowDevice();
    const result = await device.roll(20);
    expect(result.value).toBe(17);
    expect(result.requestId).toBe(
      device.updates[0].state.desired.command.requestId,
    );
    expect(device.shadow.state.desired.command).toBeNull();
    expect(device.rolls).toBe(1);
  });

  it('rejects an unsupported die before contacting the device', async () => {
    const device = shadowDevice();
    await expect(device.roll(7)).rejects.toThrow('Choose');
    expect(device.updates).toHaveLength(0);
  });

  it('prevents simultaneous tools from replacing each other', async () => {
    const device = shadowDevice();
    const results = await Promise.allSettled([
      device.roll(20),
      device.roll(20),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(device.rolls).toBe(1);
  });

  it('refuses a busy device, including a completed request not yet collected', async () => {
    const device = shadowDevice();
    device.shadow.state.desired.command = {
      requestId: 'another',
      expiresAt: 1100,
    };
    await expect(device.roll(20)).rejects.toThrow('busy');
    expect(device.updates).toHaveLength(0);
  });

  it('allows a request after the old slot expires', async () => {
    const device = shadowDevice();
    device.shadow.state.desired.command = {
      requestId: 'expired',
      expiresAt: 999,
    };
    await expect(device.roll(20)).resolves.toMatchObject({ value: 17 });
  });

  it('does not return an old result or fabricate one when offline', async () => {
    const device = shadowDevice(false);
    device.shadow.state.reported.result = {
      requestId: 'old',
      sides: 20,
      value: 20,
    };
    await expect(device.roll(20)).rejects.toThrow('did not respond');
    expect(device.updates).toHaveLength(1);
    expect(device.rolls).toBe(0);
  });

  it('rejects a correlated result outside the die range', async () => {
    const device = shadowDevice();
    await expect(device.roll(6)).rejects.toThrow('invalid dice result');
  });

  it('does not clear a newer command if the acknowledgement loses a version race', async () => {
    const device = shadowDevice();
    const update = device.transport.update;
    device.transport.update = async (change: any) => {
      if (change.state.desired.command === null) {
        device.shadow.version++;
        device.shadow.state.desired.command = {
          requestId: 'newer',
          expiresAt: 1100,
        };
      }
      return update(change);
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(device.roll(20)).resolves.toMatchObject({ value: 17 });
      expect(device.shadow.state.desired.command.requestId).toBe('newer');
    } finally {
      warning.mockRestore();
    }
  });

  it('runs the device tests for redelivery, restart, expiry and failed persistence', () => {
    const output = execFileSync(
      'uv',
      [
        'run',
        '--no-project',
        'python',
        '-B',
        resolve(fixtures, 'test_dice.py.template'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          UV_PYTHON_PREFERENCE: 'system',
          UV_PYTHON_DOWNLOADS: 'never',
          DICE_MODULE_PATH: resolve(fixtures, 'main.py.template'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(output).toBe('');
  });
});
