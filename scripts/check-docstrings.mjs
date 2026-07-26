#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { API } from 'typescript/unstable/sync';
import {
  isArrowFunction,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isSetAccessorDeclaration,
  isVariableStatement,
} from 'typescript/unstable/ast';

const SOURCE_EXTENSION = /\.(?:[cm]?ts|tsx)$/;
const DECLARATION_EXTENSION = /\.d\.(?:[cm]?ts|tsx)$/;
const TEST_FILE = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[cm]?tsx?$)/;

function usageError(message) {
  throw new Error(message);
}

function parseThreshold(value) {
  if (!/^(?:\d+)(?:\.\d+)?$/.test(value)) {
    usageError('threshold must be a number between 0 and 100');
  }
  const [whole, fraction = ''] = value.split('.');
  const scale = 10 ** fraction.length;
  const units = Number(whole) * scale + Number(fraction || 0);
  if (!Number.isSafeInteger(units) || units < 0 || units > 100 * scale) {
    usageError('threshold must be a number between 0 and 100');
  }
  return { scale, units, value: units / scale };
}

function parseArgs(argv) {
  let root = process.cwd();
  let threshold = parseThreshold('80');
  let json = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--root' || arg === '--threshold') {
      const value = argv[++index];
      if (value === undefined) usageError(`${arg} requires a value`);
      if (arg === '--root') root = resolve(value);
      else threshold = parseThreshold(value);
      continue;
    }
    usageError(`unknown argument: ${arg}`);
  }

  return { json, root: resolve(root), threshold };
}

function sourceRelativePath(root, fileName) {
  const srcRoot = resolve(root, 'src');
  const rel = relative(srcRoot, resolve(fileName));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  const portablePath = rel.split(sep).join('/');
  if (
    !SOURCE_EXTENSION.test(portablePath) ||
    DECLARATION_EXTENSION.test(portablePath) ||
    TEST_FILE.test(portablePath)
  ) {
    return undefined;
  }
  return `src/${portablePath}`;
}

function sourceFilesUnder(root) {
  const files = [];

  function visitDirectory(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (
        directory === resolve(root, 'src') &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visitDirectory(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const file = sourceRelativePath(root, path);
      if (file !== undefined) files.push({ file, fileName: path });
    }
  }

  visitDirectory(resolve(root, 'src'));
  return files;
}

function declarationKind(node) {
  if (isFunctionDeclaration(node)) return 'function';
  if (isConstructorDeclaration(node)) return 'constructor';
  if (isMethodDeclaration(node)) return 'method';
  if (isGetAccessorDeclaration(node)) return 'get accessor';
  if (isSetAccessorDeclaration(node)) return 'set accessor';
  return undefined;
}

function declarationName(node, sourceFile) {
  if (isConstructorDeclaration(node)) return 'constructor';
  return node.name?.getText(sourceFile) ?? '<anonymous function>';
}

function siblingDeclarations(node) {
  const parent = node.parent;
  for (const key of ['statements', 'members', 'properties']) {
    const value = parent?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function hasAttachedDocstring(node) {
  return Boolean(node.jsDoc?.length);
}

function hasOverloadDocstring(node, sourceFile) {
  if (hasAttachedDocstring(node)) return true;

  const siblings = siblingDeclarations(node);
  const index = siblings.indexOf(node);
  if (index < 1) return false;

  const kind = declarationKind(node);
  const name = declarationName(node, sourceFile);
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidate = siblings[cursor];
    if (
      declarationKind(candidate) !== kind ||
      declarationName(candidate, sourceFile) !== name ||
      candidate.body
    ) {
      break;
    }
    if (hasAttachedDocstring(candidate)) return true;
  }
  return false;
}

function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function collectFileDeclarations(sourceFile, file) {
  const declarations = [];

  function add(node) {
    if (!node.body) return;
    declarations.push({
      documented: hasOverloadDocstring(node, sourceFile),
      file,
      kind: declarationKind(node),
      line: lineOf(node, sourceFile),
      name: declarationName(node, sourceFile),
    });
  }

  function visit(node) {
    if (
      isFunctionDeclaration(node) ||
      isConstructorDeclaration(node) ||
      isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)
    ) {
      add(node);
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);

  for (const statement of sourceFile.statements) {
    if (!isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (!initializer || (!isArrowFunction(initializer) && !isFunctionExpression(initializer))) {
        continue;
      }
      declarations.push({
        documented: Boolean(statement.jsDoc?.length || declaration.jsDoc?.length),
        file,
        kind: 'module callable',
        line: lineOf(declaration, sourceFile),
        name: declaration.name.getText(sourceFile),
      });
    }
  }

  return declarations;
}

function formatDiagnostic(diagnostic, root) {
  const file = diagnostic.fileName
    ? relative(root, diagnostic.fileName).split(sep).join('/')
    : '<project>';
  return `${file}: ${diagnostic.text}`;
}

function scanProject(root) {
  const api = new API({ cwd: root });
  try {
    const configPath = resolve(root, 'tsconfig.json');
    const sourceFiles = sourceFilesUnder(root);
    const snapshot = api.updateSnapshot({
      openFiles: sourceFiles.map(({ fileName }) => fileName),
      openProjects: [configPath],
    });
    const project = snapshot.getProjects().find(
      (candidate) => resolve(candidate.configFileName) === configPath,
    );
    if (!project) throw new Error(`could not load TypeScript project at ${configPath}`);

    const sourceFileNames = new Set(sourceFiles.map((entry) => resolve(entry.fileName)));
    const sourceProjects = new Set(
      sourceFiles.map(({ fileName, file }) => {
        const sourceProject = snapshot.getDefaultProjectForFile(fileName);
        if (!sourceProject) throw new Error(`could not load TypeScript project for ${file}`);
        return sourceProject;
      }),
    );
    const diagnostics = [...sourceProjects]
      .flatMap((sourceProject) => sourceProject.program.getSyntacticDiagnostics())
      .filter(
        (diagnostic) =>
          diagnostic.fileName !== undefined && sourceFileNames.has(resolve(diagnostic.fileName)),
      );
    if (diagnostics.length > 0) {
      throw new Error(
        `could not parse source files:\n${diagnostics
          .map((diagnostic) => formatDiagnostic(diagnostic, root))
          .join('\n')}`,
      );
    }

    const declarations = [];
    for (const { fileName, file } of sourceFiles) {
      const sourceProject = snapshot.getDefaultProjectForFile(fileName);
      if (!sourceProject) throw new Error(`could not load TypeScript project for ${file}`);
      const sourceFile = sourceProject.program.getSourceFile(fileName);
      if (!sourceFile) throw new Error(`could not read parsed source file ${file}`);
      declarations.push(...collectFileDeclarations(sourceFile, file));
    }
    return declarations.sort(
      (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
    );
  } finally {
    api.close();
  }
}

function reportFor(declarations) {
  const documented = declarations.filter((declaration) => declaration.documented).length;
  const total = declarations.length;
  const percentage = total === 0 ? 100 : (documented / total) * 100;
  return {
    documented,
    missing: declarations
      .filter((declaration) => !declaration.documented)
      .map(({ file, kind, line, name }) => ({ file, kind, line, name })),
    percentage,
    total,
  };
}

function printText(report, threshold) {
  process.stdout.write(
    `Docstring coverage: ${report.documented}/${report.total} (${report.percentage}%), ` +
      `required ${threshold.value}%\n`,
  );
  if (report.missing.length === 0) return;
  process.stdout.write('Missing docstrings:\n');
  for (const missing of report.missing) {
    process.stdout.write(
      `- ${missing.file}:${missing.line} ${missing.kind} \`${missing.name}\`\n`,
    );
  }
}

function passes(report, threshold) {
  if (report.total === 0) return true;
  return report.documented * 100 * threshold.scale >= report.total * threshold.units;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  const report = reportFor(scanProject(options.root));
  if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else printText(report, options.threshold);
  if (!passes(report, options.threshold)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `Docstring coverage check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
