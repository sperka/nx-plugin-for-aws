/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
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
import { inflateRawSync } from 'node:zlib';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Load the actual template files and strip EJS tags for import. The `<% if
// (esm) { %>.js<% } %>` suffix on a relative import resolves to its ESM form,
// because these tests import the transpiled output as `.mjs`.
const loadTemplate = (relativePath: string): string => {
  const content = readFileSync(
    join(
      import.meta.dirname,
      'files',
      'common',
      'scripts',
      'src',
      'greengrass',
      relativePath,
    ),
    'utf-8',
  );
  return content
    .replace(/<% if \(esm\) { %>\.js<% } %>/g, '.js')
    .replace(/<%.*?%>/g, '');
};

const transpileTemplate = (templateFileName: string): string =>
  ts.transpileModule(loadTemplate(templateFileName), {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;

// Unlike the plugin's own `importTypeScriptModule` (a `data:` URL import,
// which cannot resolve bare package specifiers because it has no real
// location to resolve `node_modules` against), these templates import real npm
// packages (`js-yaml`). So the module is written to a real temporary file next
// to this spec instead, which resolves against this package's own installed
// dependencies exactly as the vended copy resolves against the shared-scripts
// project's dependencies.
const importVendedModule = async <T>(templateFileName: string): Promise<T> => {
  const jsCode = transpileTemplate(templateFileName);
  const tempPath = join(
    import.meta.dirname,
    `.tmp-${templateFileName.replace(/\W/g, '-')}-${process.pid}-${Date.now()}.mjs`,
  );
  writeFileSync(tempPath, jsCode);
  try {
    return (await import(pathToFileURL(tempPath).href)) as T;
  } finally {
    unlinkSync(tempPath);
  }
};

interface RecipeUtilsModule {
  loadRecipe: (recipePath: string) => Record<string, unknown>;
  validateRecipe: (
    recipe: Record<string, unknown>,
    componentDirName: string,
  ) => {
    componentName: string;
    componentVersion: string;
    recipe: Record<string, unknown>;
  };
  readResolvedRecipe: (recipesDir: string) => {
    componentName: string;
    componentVersion: string;
  };
}

interface ZipWriterModule {
  writeZip: (
    entries: readonly { name: string; data: Buffer }[],
    outPath: string,
  ) => void;
}

/** Minimal independent ZIP reader used only to verify the vended scripts' output. */
function readZipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  const entries: { name: string; data: Buffer }[] = [];
  let offset = 0;
  while (offset < buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = buf.toString('utf-8', nameStart, nameStart + nameLen);
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    expect(data.length).toBe(uncompressedSize);
    entries.push({ name, data });
    offset = dataStart + compressedSize;
  }
  return entries;
}

describe('greengrass recipe-utils.ts', () => {
  let loadRecipe: RecipeUtilsModule['loadRecipe'];
  let validateRecipe: RecipeUtilsModule['validateRecipe'];
  let readResolvedRecipe: RecipeUtilsModule['readResolvedRecipe'];
  let tmpDir: string;

  beforeAll(async () => {
    const mod = await importVendedModule<RecipeUtilsModule>(
      'recipe-utils.ts.template',
    );
    loadRecipe = mod.loadRecipe;
    validateRecipe = mod.validateRecipe;
    readResolvedRecipe = mod.readResolvedRecipe;
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'greengrass-recipe-utils-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const validRecipe = () => ({
    RecipeFormatVersion: '2020-01-25',
    ComponentName: 'com.example.MyComponent',
    ComponentVersion: '1.0.0',
    ComponentDescription: 'A test component',
    Manifests: [
      {
        Platform: { os: 'linux' },
        Artifacts: [
          {
            Uri: 's3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component.zip',
            Unarchive: 'ZIP',
          },
        ],
        Lifecycle: {
          Run: 'python3 {artifacts:decompressedPath}/my-component/main.py',
        },
      },
    ],
  });

  describe('validateRecipe', () => {
    it('should accept a valid recipe and resolve its name and version', () => {
      const recipe = validRecipe();
      const resolved = validateRecipe(recipe, 'my-component');
      expect(resolved.componentName).toBe('com.example.MyComponent');
      expect(resolved.componentVersion).toBe('1.0.0');
    });

    it('should preserve unknown keys untouched', () => {
      const recipe = { ...validRecipe(), SomeUnknownKey: { nested: true } };
      const resolved = validateRecipe(recipe, 'my-component');
      expect(resolved.recipe.SomeUnknownKey).toEqual({ nested: true });
    });

    it('should reject a missing ComponentName', () => {
      const recipe = validRecipe() as Record<string, unknown>;
      delete recipe.ComponentName;
      expect(() => validateRecipe(recipe, 'my-component')).toThrow(
        /ComponentName is required/,
      );
    });

    it('should reject illegal ComponentName characters', () => {
      const recipe = { ...validRecipe(), ComponentName: 'com/example!bad' };
      expect(() => validateRecipe(recipe, 'my-component')).toThrow(
        /may only contain letters, numbers/,
      );
    });

    it('should reject the reserved aws.greengrass. prefix', () => {
      const recipe = {
        ...validRecipe(),
        ComponentName: 'aws.greengrass.MyComponent',
      };
      expect(() => validateRecipe(recipe, 'my-component')).toThrow(
        /reserved prefix/,
      );
    });

    it('should reject a ComponentName over 128 characters', () => {
      const recipe = { ...validRecipe(), ComponentName: 'a'.repeat(129) };
      expect(() => validateRecipe(recipe, 'my-component')).toThrow(
        /at most 128 characters/,
      );
    });

    it('should reject a non-semver ComponentVersion', () => {
      const recipe = { ...validRecipe(), ComponentVersion: 'v1.0' };
      expect(() => validateRecipe(recipe, 'my-component')).toThrow(
        /valid semver version/,
      );
    });

    it('should reject when no lifecycle script references the decompressed component dir', () => {
      const recipe = {
        ...validRecipe(),
        Manifests: [
          {
            Lifecycle: {
              Run: 'python3 {artifacts:decompressedPath}/wrong-dir/main.py',
            },
          },
        ],
      };
      expect(() => validateRecipe(recipe, 'my-component')).toThrow(
        /Run script path must match the artifact zip base name/,
      );
    });

    it('should accept a top-level Lifecycle block, not only per-manifest', () => {
      const recipe = {
        ComponentName: 'com.example.MyComponent',
        ComponentVersion: '1.0.0',
        Lifecycle: {
          Run: 'python3 {artifacts:decompressedPath}/my-component/main.py',
        },
        Manifests: [
          {
            Artifacts: [
              {
                Uri: 's3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component.zip',
                Unarchive: 'ZIP',
              },
            ],
          },
        ],
      };
      expect(() => validateRecipe(recipe, 'my-component')).not.toThrow();
    });

    it('should reject a recipe declaring no artifact for the component zip', () => {
      const recipe = validRecipe() as Record<string, unknown>;
      recipe.Manifests = [
        {
          Lifecycle: {
            Run: 'python3 {artifacts:decompressedPath}/my-component/main.py',
          },
        },
      ];
      expect(() => validateRecipe(recipe, 'my-component')).toThrow(
        /No manifest declares an artifact whose Uri ends in "\/my-component\.zip"/,
      );
    });

    it('should reject an artifact Uri whose basename is not the component zip', () => {
      const recipe = validRecipe() as Record<string, unknown>;
      recipe.Manifests = [
        {
          Artifacts: [
            {
              Uri: 's3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/renamed.zip',
            },
          ],
          Lifecycle: {
            Run: 'python3 {artifacts:decompressedPath}/my-component/main.py',
          },
        },
      ];
      expect(() => validateRecipe(recipe, 'my-component')).toThrow(
        /No manifest declares an artifact whose Uri ends in/,
      );
    });

    it('should accept an artifact spelled URI rather than Uri', () => {
      const recipe = validRecipe() as Record<string, unknown>;
      recipe.Manifests = [
        {
          Artifacts: [
            {
              URI: 's3://BUCKET_NAME/COMPONENT_NAME/COMPONENT_VERSION/my-component.zip',
            },
          ],
          Lifecycle: {
            Run: 'python3 {artifacts:decompressedPath}/my-component/main.py',
          },
        },
      ];
      expect(() => validateRecipe(recipe, 'my-component')).not.toThrow();
    });

    it('should collect every violation in one error', () => {
      const recipe = { ComponentName: 'aws.greengrass.bad name!' };
      let thrown: Error | undefined;
      try {
        validateRecipe(recipe, 'my-component');
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown?.message).toMatch(/reserved prefix/);
      expect(thrown?.message).toMatch(/may only contain letters, numbers/);
      expect(thrown?.message).toMatch(/ComponentVersion is required/);
      expect(thrown?.message).toMatch(/Run script path must match/);
      expect(thrown?.message).toMatch(/No manifest declares an artifact/);
    });
  });

  describe('loadRecipe', () => {
    it('should load and parse a recipe.yaml from disk', () => {
      const recipePath = join(tmpDir, 'recipe.yaml');
      writeFileSync(
        recipePath,
        'ComponentName: com.example.MyComponent\nComponentVersion: 1.0.0\n',
      );
      const recipe = loadRecipe(recipePath);
      expect(recipe.ComponentName).toBe('com.example.MyComponent');
    });

    it('should throw a clear message when the file is missing', () => {
      expect(() => loadRecipe(join(tmpDir, 'missing.yaml'))).toThrow(
        /Cannot read recipe/,
      );
    });

    it('should throw when the document is not an object', () => {
      const recipePath = join(tmpDir, 'recipe.yaml');
      writeFileSync(recipePath, '- just\n- a\n- list\n');
      expect(() => loadRecipe(recipePath)).toThrow(
        /is not a Greengrass recipe document/,
      );
    });
  });

  describe('readResolvedRecipe', () => {
    it('should read the single resolved recipe in a directory', () => {
      writeFileSync(
        join(tmpDir, 'com.example.MyComponent-1.0.0.yaml'),
        'ComponentName: com.example.MyComponent\nComponentVersion: 1.0.0\n',
      );
      const resolved = readResolvedRecipe(tmpDir);
      expect(resolved.componentName).toBe('com.example.MyComponent');
      expect(resolved.componentVersion).toBe('1.0.0');
    });

    it('should throw when the directory does not exist', () => {
      expect(() => readResolvedRecipe(join(tmpDir, 'does-not-exist'))).toThrow(
        /run the component's "-artifact" target first/,
      );
    });

    it('should throw when more than one recipe is present', () => {
      writeFileSync(join(tmpDir, 'a-1.0.0.yaml'), 'ComponentName: a\n');
      writeFileSync(join(tmpDir, 'b-1.0.0.yaml'), 'ComponentName: b\n');
      expect(() => readResolvedRecipe(tmpDir)).toThrow(
        /Expected exactly one resolved recipe/,
      );
    });
  });
});

describe('greengrass zip-writer.ts', () => {
  let writeZip: ZipWriterModule['writeZip'];
  let tmpDir: string;

  beforeAll(async () => {
    const mod = await importVendedModule<ZipWriterModule>(
      'zip-writer.ts.template',
    );
    writeZip = mod.writeZip;
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'greengrass-zip-writer-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should round-trip multiple files with their exact contents', () => {
    const outPath = join(tmpDir, 'out.zip');
    const entries = [
      { name: 'main.py', data: Buffer.from('print("hello")\n') },
      { name: 'vendor/lib/pkg.py', data: Buffer.from('x = 1\n') },
      { name: 'binary.dat', data: Buffer.from([0, 1, 2, 255, 254, 253]) },
    ];
    writeZip(entries, outPath);

    const read = readZipEntries(readFileSync(outPath));
    expect(read.map((e) => e.name).sort()).toEqual(
      entries.map((e) => e.name).sort(),
    );
    for (const entry of entries) {
      const found = read.find((e) => e.name === entry.name);
      expect(found?.data).toEqual(entry.data);
    }
  });

  it('should use forward slashes for nested entry names', () => {
    const outPath = join(tmpDir, 'out.zip');
    writeZip([{ name: 'a/b/c.txt', data: Buffer.from('x') }], outPath);
    const [entry] = readZipEntries(readFileSync(outPath));
    expect(entry.name).toBe('a/b/c.txt');
  });

  it('should round-trip incompressible (random) data via the STORED fallback', () => {
    const outPath = join(tmpDir, 'out.zip');
    const random = Buffer.from(
      Array.from({ length: 256 }, (_, i) => (i * 97 + 13) % 256),
    );
    writeZip([{ name: 'random.bin', data: random }], outPath);
    const [entry] = readZipEntries(readFileSync(outPath));
    expect(entry.data).toEqual(random);
  });

  it('should produce a parseable archive for an empty entry list', () => {
    const outPath = join(tmpDir, 'out.zip');
    writeZip([], outPath);
    const buf = readFileSync(outPath);
    // Just the End Of Central Directory record, with zero entries.
    expect(buf.readUInt32LE(0)).toBe(0x06054b50);
    expect(buf.readUInt16LE(10)).toBe(0);
  });
});

describe('greengrass build-artifact.ts', () => {
  let tmpDir: string;
  let scriptsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'greengrass-build-artifact-'));
    scriptsDir = mkdtempSync(
      join(import.meta.dirname, '.tmp-greengrass-build-artifact-'),
    );
    writeFileSync(
      join(scriptsDir, 'recipe-utils.mjs'),
      transpileTemplate('recipe-utils.ts.template'),
    );
    writeFileSync(
      join(scriptsDir, 'zip-writer.mjs'),
      transpileTemplate('zip-writer.ts.template'),
    );
    writeFileSync(
      join(scriptsDir, 'build-artifact.mjs'),
      transpileTemplate('build-artifact.ts.template')
        .replaceAll('./recipe-utils.js', './recipe-utils.mjs')
        .replaceAll('./zip-writer.js', './zip-writer.mjs'),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(scriptsDir, { recursive: true, force: true });
  });

  it('should exclude staging __pycache__ files and .lock entries', () => {
    const projectRoot = join(tmpDir, 'project');
    const componentDir = join(projectRoot, 'greengrass', 'my-component');
    const distDir = join(tmpDir, 'dist');
    const vendorDir = join(distDir, 'vendor');
    mkdirSync(join(componentDir, '__pycache__'), { recursive: true });
    mkdirSync(join(vendorDir, '__pycache__'), { recursive: true });
    writeFileSync(join(componentDir, 'main.py'), 'print("hello")\n');
    writeFileSync(
      join(componentDir, 'recipe.yaml'),
      [
        'ComponentName: com.example.MyComponent',
        'ComponentVersion: 1.0.0',
        'Manifests:',
        '  - Artifacts:',
        '      - Uri: s3://bucket/my-component.zip',
        '        Unarchive: ZIP',
        '    Lifecycle:',
        '      Run: python3 {artifacts:decompressedPath}/my-component/main.py',
        '',
      ].join('\n'),
    );
    writeFileSync(join(componentDir, '.lock'), '');
    writeFileSync(
      join(componentDir, '__pycache__', 'main.pyc'),
      'source-cache',
    );
    writeFileSync(join(vendorDir, 'dependency.py'), 'VERSION = "1.0"\n');
    writeFileSync(join(vendorDir, 'requirements.txt'), 'dependency==1.0\n');
    writeFileSync(join(vendorDir, '.lock'), '');
    writeFileSync(
      join(vendorDir, '__pycache__', 'dependency.pyc'),
      'staging-cache',
    );

    const result = spawnSync(
      process.execPath,
      [
        join(scriptsDir, 'build-artifact.mjs'),
        projectRoot,
        'my-component',
        distDir,
      ],
      { encoding: 'utf-8' },
    );

    expect(result.status, result.stderr).toBe(0);
    const entries = readZipEntries(
      readFileSync(
        join(
          distDir,
          'greengrass-build',
          'artifacts',
          'com.example.MyComponent',
          '1.0.0',
          'my-component.zip',
        ),
      ),
    );
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual(['main.py', 'dependency.py']);
    expect(names).not.toContain('__pycache__/dependency.pyc');
  });
});
