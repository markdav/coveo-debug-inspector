import { jsonrepair } from 'jsonrepair';
import type { ParseOutcome } from '../model/types';

/**
 * Tolerant JSON parser for captured Coveo debug responses.
 *
 * Captured files are frequently malformed (truncated arrays, a missing `:`,
 * clipped strings) because they were copied out of browser devtools. We try, in
 * order:
 *   1. native JSON.parse            -> method 'native'
 *   2. jsonrepair then JSON.parse   -> method 'repaired'
 *   3. section salvage (best effort)-> method 'salvaged'
 * and always report what happened so the UI can show partial results.
 */
export function parseJsonTolerant(text: string): ParseOutcome<Record<string, unknown>> {
  const errors: string[] = [];
  const notes: string[] = [];
  const trimmed = text.trim();

  if (!trimmed) {
    return { value: null, ok: false, method: 'failed', errors: ['Empty input.'], notes };
  }

  // 1. Native.
  try {
    return { value: JSON.parse(trimmed), ok: true, method: 'native', errors, notes };
  } catch (e) {
    errors.push(`Native parse failed: ${(e as Error).message}`);
  }

  // 2. Repair.
  try {
    const repaired = jsonrepair(trimmed);
    const value = JSON.parse(repaired) as Record<string, unknown>;
    notes.push('Input was malformed and automatically repaired before parsing.');
    return { value, ok: true, method: 'repaired', errors, notes };
  } catch (e) {
    errors.push(`Repair parse failed: ${(e as Error).message}`);
  }

  // 3. Salvage: pull known top-level keys by bracket-matching so a single
  //    corrupt section (e.g. termsToHighlight) can't blank the whole view.
  const salvaged = salvageTopLevel(trimmed);
  if (Object.keys(salvaged).length > 0) {
    notes.push(
      `Input could not be fully parsed; salvaged ${Object.keys(salvaged).length} top-level field(s).`,
    );
    return { value: salvaged, ok: true, method: 'salvaged', errors, notes };
  }

  return { value: null, ok: false, method: 'failed', errors, notes };
}

/** Keys worth salvaging individually when the whole document won't parse. */
const SALVAGE_KEYS = [
  'totalCount',
  'totalCountFiltered',
  'duration',
  'indexDuration',
  'requestDuration',
  'searchUid',
  'pipeline',
  'apiVersion',
  'warnings',
  'basicExpression',
  'advancedExpression',
  'constantExpression',
  'disjunctionExpression',
  'mandatoryExpression',
  'userIdentities',
  'rankingExpressions',
  'executionReport',
  'index',
  'indexRegion',
  'results',
  'extendedResults',
];

/**
 * Best-effort extraction of top-level values from a malformed object string.
 *
 * Strategy: locate each known key, sort by position, and treat the value as the
 * span between the end of this key's colon and the start of the NEXT known key
 * (or EOF). Each span is trimmed of trailing separators and parsed with a repair
 * fallback. This is resilient to corruption *inside* a value (e.g. an unbalanced
 * quote in the results array) because it does not rely on global bracket
 * balance — jsonrepair fixes the truncated/odd bits within the isolated span.
 */
export function salvageTopLevel(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Ordered positions of the keys we care about.
  const found: { key: string; keyIdx: number; valStart: number }[] = [];
  for (const key of SALVAGE_KEYS) {
    const keyIdx = text.indexOf(`"${key}"`);
    if (keyIdx === -1) continue;
    // Position just after the colon following the key.
    let i = keyIdx + key.length + 2;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== ':') continue;
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) continue;
    found.push({ key, keyIdx, valStart: i });
  }
  found.sort((a, b) => a.valStart - b.valStart);

  for (let idx = 0; idx < found.length; idx++) {
    const { key, valStart } = found[idx];
    const nextKeyIdx = idx + 1 < found.length ? found[idx + 1].keyIdx : text.length;

    // Prefer a clean bracket-matched slice when it succeeds and fits the span.
    let slice: string | undefined;
    const cleanEnd = matchValueEnd(text, valStart);
    if (cleanEnd !== -1 && cleanEnd <= nextKeyIdx) {
      slice = text.slice(valStart, cleanEnd);
    } else {
      slice = trimSpanTail(text.slice(valStart, nextKeyIdx));
    }

    const parsed = tryParseValue(slice);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
}

/**
 * Trim the tail of a between-keys span: drop trailing whitespace, a trailing
 * comma (separator to the next key), and any trailing object/array closers that
 * belong to the enclosing root object rather than this value.
 */
function trimSpanTail(span: string): string {
  let s = span.replace(/\s+$/, '');
  // Remove a single trailing comma separating this value from the next key.
  if (s.endsWith(',')) s = s.slice(0, -1).replace(/\s+$/, '');
  // If this is the last key, the span may include the root's closing brace.
  // Repair handles balance, but strip an obvious trailing lone '}'.
  return s;
}

function tryParseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(jsonrepair(raw));
    } catch {
      return undefined;
    }
  }
}

/**
 * Find the value text for a top-level key. Only matches keys that appear to be
 * at object top-level by requiring the `"key" :` token; returns the substring
 * covering the value (object, array, string, number, bool, or null).
 */
export function extractValueForKey(text: string, key: string): string | undefined {
  const keyToken = `"${key}"`;
  let searchFrom = 0;
  // Prefer a top-level occurrence: the first one at the shallowest depth.
  // Simpler heuristic: scan all occurrences, pick the one whose colon is
  // followed by a value we can bracket-match to completion.
  while (searchFrom < text.length) {
    const idx = text.indexOf(keyToken, searchFrom);
    if (idx === -1) return undefined;
    searchFrom = idx + keyToken.length;

    // Expect a colon (allowing whitespace) after the key.
    let i = searchFrom;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== ':') continue;
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) continue;

    const end = matchValueEnd(text, i);
    if (end === -1) continue;
    return text.slice(i, end);
  }
  return undefined;
}

/**
 * Given the index of the first char of a JSON value, return the index just past
 * its end, using bracket/quote matching. Returns -1 if it can't be matched.
 */
export function matchValueEnd(text: string, start: number): number {
  const ch = text[start];
  if (ch === '{' || ch === '[') return matchBracket(text, start);
  if (ch === '"') return matchString(text, start);
  // primitive: number / bool / null — read until a terminator.
  let i = start;
  while (i < text.length && !/[,}\]\s]/.test(text[i])) i++;
  return i > start ? i : -1;
}

function matchBracket(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1; // unbalanced (truncated)
}

function matchString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '"') return i + 1;
  }
  return -1;
}
