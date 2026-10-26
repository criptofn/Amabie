import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const sourceRoot = path.resolve(import.meta.dirname, '../../src');

test('verification infrastructure never depends on CLI commands or the compatibility facade', () => {
  const graph = new Map<string, string[]>();
  for (const entry of fs.readdirSync(sourceRoot, { recursive: true })) {
    const file = path.join(sourceRoot, String(entry));
    if (!file.endsWith('.ts')) continue;
    const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(ts.isImportDeclaration).filter(statement => {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) return false;
      const bindings = clause?.namedBindings;
      return !bindings || !ts.isNamedImports(bindings) || bindings.elements.some(element => !element.isTypeOnly);
    }).map(statement => (statement.moduleSpecifier as ts.StringLiteral).text)
      .filter(specifier => specifier.startsWith('.'))
      .map(specifier => path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')));
    if (path.basename(file) !== 'onboarding.ts') {
      assert.ok(imports.every(dependency => path.basename(dependency) !== 'onboarding.ts'),
        `${path.relative(sourceRoot, file)} must import the owning module directly`);
    }
    graph.set(file, imports);
  }
  for (const module of ['local-files', 'local-config', 'execution-environment', 'git-state',
    'check-runner', 'change-signals', 'proof-obligations', 'regression-proof', 'task-state', 'verification-evidence']) {
    const seen = new Set<string>();
    const visit = (file: string, chain: string[]): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const name = path.basename(file, '.ts');
      assert.ok(!name.endsWith('-command') && name !== 'status-commands' && name !== 'onboarding', chain.join(' -> '));
      for (const dependency of graph.get(file) ?? []) visit(dependency, [...chain, path.basename(dependency)]);
    };
    visit(path.join(sourceRoot, `${module}.ts`), [module]);
  }
});
