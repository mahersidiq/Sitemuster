import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listFiles, readRepoFile } from '../support/repo';

/**
 * Scans React Native screens/components for hardcoded user-facing copy using the TypeScript
 * compiler API: JSX text with letters, and string literals passed to user-facing props.
 */
const USER_FACING_PROPS = new Set([
  'title',
  'label',
  'placeholder',
  'accessibilityLabel',
  'accessibilityHint',
  'headerTitle',
  'tabBarLabel',
  'text',
  'body',
]);

const SOURCES = listFiles(
  ['app', 'src'],
  (path) => path.endsWith('.tsx') && !path.endsWith('.test.tsx'),
);

function findHardcodedCopy(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readRepoFile(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && /\p{L}/u.test(node.getText())) {
      findings.push(`${path}: JSX text "${node.getText().trim()}"`);
    }
    if (
      ts.isJsxAttribute(node) &&
      USER_FACING_PROPS.has(node.name.getText()) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      /\p{L}/u.test(node.initializer.text)
    ) {
      findings.push(`${path}: ${node.name.getText()}="${node.initializer.text}"`);
    }
    if (
      ts.isPropertyAssignment(node) &&
      ['title', 'headerTitle', 'tabBarLabel'].includes(node.name.getText()) &&
      ts.isStringLiteral(node.initializer) &&
      /\p{L}/u.test(node.initializer.text)
    ) {
      findings.push(`${path}: option ${node.name.getText()}: "${node.initializer.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

describe('no hardcoded user-facing copy', () => {
  it('scans every screen and component', () => {
    expect(SOURCES.length).toBeGreaterThan(15);
  });

  it('finds no JSX text or user-facing string props outside the dictionaries', () => {
    expect(SOURCES.flatMap(findHardcodedCopy)).toEqual([]);
  });

  it('detects violations (scanner self-test)', () => {
    const sample = ts.createSourceFile(
      'sample.tsx',
      'const x = <Text title="Hello">Welcome back</Text>;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const texts: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node) && /\p{L}/u.test(node.getText())) texts.push(node.getText());
      ts.forEachChild(node, visit);
    };
    visit(sample);
    expect(texts).toEqual(['Welcome back']);
  });
});
