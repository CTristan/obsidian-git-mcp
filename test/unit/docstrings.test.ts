import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const checker = resolve(import.meta.dirname, '../../scripts/check-docstrings.mjs');
const roots: string[] = [];

interface CheckerReport {
  documented: number;
  missing: Array<{ file: string; line: number; name: string }>;
  percentage: number;
  total: number;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'obsidian-git-mcp-docstrings-'));
  roots.push(root);
  await writeFile(
    resolve(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2023',
        module: 'nodenext',
        moduleResolution: 'nodenext',
      },
      include: ['src'],
    }),
  );
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = resolve(root, path);
    await mkdir(resolve(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, contents);
  }
  return root;
}

async function check(
  root: string,
  threshold: number,
): Promise<{ report: CheckerReport; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    checker,
    '--root',
    root,
    '--threshold',
    String(threshold),
    '--json',
  ]);
  return { report: JSON.parse(stdout) as CheckerReport, stderr };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('docstring coverage checker', () => {
  it('counts implementation declarations while excluding callback and type-only syntax', async () => {
    const root = await fixture({
      'src/sample.ts': [
        '/** Documents a function. */',
        'export function documented(): void {}',
        '',
        '// An ordinary comment does not count.',
        'function ordinary(): void {}',
        '',
        '/** Documents the overload group. */',
        'function overloaded(value: string): string;',
        'function overloaded(value: number): string;',
        'function overloaded(value: string | number): string { return String(value); }',
        '',
        'class Example {',
        '  /** Creates the example. */',
        '  constructor() {}',
        '  /** Runs the example. */',
        '  run(): void {}',
        '  /** Reads the value. */',
        '  get value(): number { return 1; }',
        '  /** Writes the value. */',
        '  set value(_next: number) {}',
        '}',
        '',
        'const object = {',
        '  /** Closes the object. */',
        '  close(): void {},',
        '};',
        '',
        '/** Runs at module scope. */',
        'const moduleCallable = (): void => {};',
        '',
        'function withNestedCallbacks(): void {',
        '  const nested = (): void => {};',
        '  [1].map((value) => value + 1);',
        '}',
        '',
        'interface Contract { run(): void; }',
        'type Callable = () => void;',
        'void object;',
        'void moduleCallable;',
      ].join('\n'),
      'src/types.d.ts': '/** Type declaration. */\nexport declare function declared(): void;\n',
      'src/sample.test.ts': 'function testHelper(): void {}\n',
      'src/__tests__/nested.ts': 'function nestedTestHelper(): void {}\n',
    });

    const { report } = await check(root, 0);

    expect(report).toMatchObject({ documented: 8, total: 10, percentage: 80 });
    expect(report.missing).toEqual([
      { file: 'src/sample.ts', kind: 'function', line: 5, name: 'ordinary' },
      {
        file: 'src/sample.ts',
        kind: 'function',
        line: 31,
        name: 'withNestedCallbacks',
      },
    ]);
  });

  it('compares the exact ratio instead of the displayed percentage', async () => {
    const root = await fixture({
      'src/sample.ts': [
        '/** One. */ function one(): void {}',
        '/** Two. */ function two(): void {}',
        '/** Three. */ function three(): void {}',
        '/** Four. */ function four(): void {}',
        'function five(): void {}',
      ].join('\n'),
    });

    await expect(check(root, 80)).resolves.toMatchObject({
      report: { documented: 4, total: 5, percentage: 80 },
    });
    await expect(check(root, 80.01)).rejects.toMatchObject({ code: 1 });
  });

  it('passes an empty source tree with 100 percent coverage', async () => {
    const root = await fixture({});

    await expect(check(root, 100)).resolves.toMatchObject({
      report: { documented: 0, missing: [], percentage: 100, total: 0 },
    });
  });

  it('counts eligible source files excluded from the TypeScript project', async () => {
    const root = await fixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'es2023',
          module: 'nodenext',
          moduleResolution: 'nodenext',
        },
        files: ['src/included.ts'],
      }),
      'src/included.ts': '/** Included. */\nexport function included(): void {}\n',
      'src/excluded.ts': 'export function excluded(): void {}\n',
    });

    await expect(check(root, 0)).resolves.toMatchObject({
      report: {
        documented: 1,
        missing: [
          { file: 'src/excluded.ts', kind: 'function', line: 1, name: 'excluded' },
        ],
        percentage: 50,
        total: 2,
      },
    });
  });

  it('fails closed when TypeScript cannot parse a source file', async () => {
    const root = await fixture({
      'src/broken.ts': 'export function broken(: void {}\n',
    });

    await expect(check(root, 0)).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringMatching(/parse source files:[\s\S]*src[/\\]broken\.ts/i),
    });
  });

  it('rejects an invalid threshold before scanning source files', async () => {
    const root = await fixture({
      'src/broken.ts': 'export function broken(: void {}\n',
    });

    await expect(check(root, 101)).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringMatching(/threshold.*between 0 and 100/i),
    });
  });
});
