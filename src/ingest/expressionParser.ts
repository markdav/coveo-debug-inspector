import type { ExprNode, PartialMatchInfo } from '../model/types';

/**
 * Parse the `basicExpression` PartialMatch wrapper, e.g.:
 *   PartialMatch(keywords=KeywordExpressionPartialMatchAtom(replace) ...;
 *                match=75%; pick=Unspecified(); stopWords=; ...)
 */
export function parsePartialMatch(basic: string | null): PartialMatchInfo | null {
  if (!basic) return null;
  if (!basic.includes('PartialMatch')) return null;

  const keywords = [...basic.matchAll(/KeywordExpressionPartialMatchAtom\(([^)]*)\)/g)].map(
    (m) => m[1],
  );
  const match = basic.match(/match=([0-9]+%)/)?.[1] ?? null;
  const stopWordsRaw = basic.match(/stopWords=([^;]*)/)?.[1]?.trim() ?? '';
  const stopWords = stopWordsRaw ? stopWordsRaw.split(/\s+/).filter(Boolean) : [];

  return { keywords, match, stopWords, raw: basic };
}

/**
 * Parse a Coveo advanced/constant expression string into a display tree.
 *
 * The grammar is space-separated implicit-AND clauses, with explicit `OR`,
 * parenthesised groups, and `NOT` prefixes. Leaves are field predicates like
 * `@source==knowledge-base`. This is a pragmatic parser aimed at readable
 * rendering, not a perfectly faithful Coveo query compiler.
 */
export function parseExpressionTree(expr: string | null): ExprNode | null {
  if (!expr || !expr.trim()) return null;
  const tokens = tokenize(expr);
  let pos = 0;

  function parseOr(): ExprNode {
    const parts: ExprNode[] = [parseAnd()];
    while (tokens[pos] === 'OR') {
      pos++;
      parts.push(parseAnd());
    }
    return parts.length === 1 ? parts[0] : { kind: 'or', children: parts };
  }

  function parseAnd(): ExprNode {
    const parts: ExprNode[] = [];
    while (pos < tokens.length && tokens[pos] !== 'OR' && tokens[pos] !== ')') {
      parts.push(parseUnary());
    }
    if (parts.length === 0) return { kind: 'leaf', text: '' };
    return parts.length === 1 ? parts[0] : { kind: 'and', children: parts };
  }

  function parseUnary(): ExprNode {
    if (tokens[pos] === 'NOT') {
      pos++;
      return { kind: 'not', children: [parseUnary()] };
    }
    if (tokens[pos] === '(') {
      pos++;
      const inner = parseOr();
      if (tokens[pos] === ')') pos++;
      return inner;
    }
    const text = tokens[pos] ?? '';
    pos++;
    return { kind: 'leaf', text };
  }

  const tree = parseOr();
  return tree;
}

/** Tokenize into: '(', ')', 'OR', 'NOT', and clause atoms. */
export function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  let depthInParens = 0; // used only to avoid splitting inside (...) value lists
  let buf = '';

  const flush = () => {
    if (buf.trim()) tokens.push(buf.trim());
    buf = '';
  };

  while (i < expr.length) {
    const c = expr[i];
    if (c === '(' && depthInParens === 0 && isGroupParen(expr, i)) {
      flush();
      tokens.push('(');
      i++;
      continue;
    }
    if (c === ')' && depthInParens === 0) {
      flush();
      tokens.push(')');
      i++;
      continue;
    }
    if (c === '"') {
      // consume quoted string wholesale
      buf += c;
      i++;
      while (i < expr.length && expr[i] !== '"') {
        buf += expr[i];
        i++;
      }
      if (i < expr.length) {
        buf += expr[i];
        i++;
      }
      continue;
    }
    if (c === '(') {
      depthInParens++;
      buf += c;
      i++;
      continue;
    }
    if (c === ')' && depthInParens > 0) {
      depthInParens--;
      buf += c;
      i++;
      continue;
    }
    if (/\s/.test(c) && depthInParens === 0) {
      // Word boundary — check for OR / NOT keywords.
      flush();
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flush();

  // Post-process: split standalone OR/NOT keywords that got attached as atoms.
  return tokens.flatMap((t) => (t === 'OR' || t === 'NOT' ? [t] : normalizeKeywords(t)));
}

/** Determine whether a `(` at position i opens a boolean group vs a value list. */
function isGroupParen(expr: string, i: number): boolean {
  // A value list looks like `==(` or `=(` immediately before the paren.
  const prev = expr.slice(Math.max(0, i - 2), i);
  return !/=$|==$|<>$/.test(prev) && expr[i - 1] !== '=';
}

/** Keep atoms intact; OR/NOT are handled at tokenize level. */
function normalizeKeywords(atom: string): string[] {
  return [atom];
}
