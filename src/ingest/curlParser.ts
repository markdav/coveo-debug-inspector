import type { ParsedRequest, ParseOutcome, RequestBody, RequestFacet } from '../model/types';
import { parseJsonTolerant } from './jsonTolerant';

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-api-key'];

/**
 * Parse a captured request. Accepts either:
 *   - a full `curl '...' -H '...' --data-raw '...'` command, or
 *   - a bare JSON request body.
 * Any Authorization/cookie header value is redacted immediately and never kept.
 */
export function parseRequest(text: string): ParseOutcome<ParsedRequest> {
  const errors: string[] = [];
  const notes: string[] = [];
  const trimmed = text.trim();

  if (!trimmed) {
    return { value: null, ok: false, method: 'failed', errors: ['Empty request input.'], notes };
  }

  // Bare JSON body?
  if (trimmed.startsWith('{')) {
    const bodyOutcome = parseJsonTolerant(trimmed);
    const body = bodyOutcome.value ? normalizeBody(bodyOutcome.value) : null;
    return {
      value: {
        url: null,
        organizationId: null,
        headers: {},
        authorizationRedacted: false,
        body,
        rawBody: bodyOutcome.value ? JSON.stringify(bodyOutcome.value, null, 2) : trimmed,
      },
      ok: bodyOutcome.ok,
      method: bodyOutcome.method,
      errors: [...errors, ...bodyOutcome.errors],
      notes: [...notes, ...bodyOutcome.notes],
    };
  }

  // curl command.
  const url = extractCurlUrl(trimmed);
  const organizationId = url ? new URL(safeUrl(url)).searchParams.get('organizationId') : null;
  const { headers, redacted } = extractHeaders(trimmed);
  if (redacted) notes.push('Authorization/sensitive header value redacted on ingest.');

  const dataRaw = extractDataRaw(trimmed);
  let body: RequestBody | null = null;
  let rawBody: string | null = null;
  let method: ParseOutcome<ParsedRequest>['method'] = 'native';

  if (dataRaw) {
    const bodyOutcome = parseJsonTolerant(dataRaw);
    method = bodyOutcome.method;
    errors.push(...bodyOutcome.errors);
    notes.push(...bodyOutcome.notes);
    if (bodyOutcome.value) {
      body = normalizeBody(bodyOutcome.value);
      rawBody = JSON.stringify(bodyOutcome.value, null, 2);
    } else {
      rawBody = dataRaw;
    }
  } else {
    notes.push('No --data-raw / --data body found in the curl command.');
  }

  return {
    value: { url, organizationId, headers, authorizationRedacted: redacted, body, rawBody },
    ok: true,
    method,
    errors,
    notes,
  };
}

function safeUrl(u: string): string {
  try {
    return new URL(u).toString();
  } catch {
    return 'https://invalid.local/';
  }
}

export function extractCurlUrl(text: string): string | null {
  // The URL may be positional or behind `--url`, with flags in any order before it.
  const tokens = text.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  for (const token of tokens) {
    const value = token.replace(/^['"]/, '').replace(/['"]$/, '');
    if (/^https?:\/\//i.test(value)) return value;
  }
  return null;
}

export function extractHeaders(text: string): { headers: Record<string, string>; redacted: boolean } {
  const headers: Record<string, string> = {};
  let redacted = false;
  // -H 'Name: value'  (and double-quoted variant)
  const re = /-H\s+(?:'([^']*)'|"([^"]*)")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2] ?? '';
    const ci = raw.indexOf(':');
    if (ci === -1) continue;
    const name = raw.slice(0, ci).trim();
    const value = raw.slice(ci + 1).trim();
    if (SENSITIVE_HEADERS.includes(name.toLowerCase())) {
      headers[name] = '***redacted***';
      redacted = true;
    } else {
      headers[name] = value;
    }
  }
  return { headers, redacted };
}

/** Extract the --data-raw / --data / --data-binary payload. */
export function extractDataRaw(text: string): string | null {
  const flags = ['--data-raw', '--data-binary', '--data', '-d'];
  for (const flag of flags) {
    // flag 'PAYLOAD' with single quotes (payload may contain escaped content)
    const single = new RegExp(`${flag}\\s+'`).exec(text);
    if (single) {
      const startQuote = single.index + single[0].length - 1;
      const end = findClosingQuote(text, startQuote, "'");
      if (end !== -1) return text.slice(startQuote + 1, end);
    }
    const dbl = new RegExp(`${flag}\\s+"`).exec(text);
    if (dbl) {
      const startQuote = dbl.index + dbl[0].length - 1;
      const end = findClosingQuote(text, startQuote, '"');
      if (end !== -1) return text.slice(startQuote + 1, end);
    }
  }
  return null;
}

/** Find the matching closing quote, honouring backslash escapes. */
function findClosingQuote(text: string, openIdx: number, quote: string): number {
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

function normalizeBody(raw: Record<string, unknown>): RequestBody {
  const knownKeys = new Set([
    'q',
    'pipeline',
    'searchHub',
    'tab',
    'locale',
    'debug',
    'enableQuerySyntax',
    'numberOfResults',
    'context',
    'aq',
    'cq',
    'sortCriteria',
    'pipelineRuleParameters',
    'facets',
    'actionsHistory',
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!knownKeys.has(k)) extras[k] = v;

  const facets: RequestFacet[] = Array.isArray(raw.facets)
    ? (raw.facets as Record<string, unknown>[]).map((f) => ({
        facetId: str(f.facetId),
        field: str(f.field),
        type: str(f.type),
      }))
    : [];

  return {
    q: str(raw.q),
    pipeline: str(raw.pipeline),
    searchHub: str(raw.searchHub),
    tab: str(raw.tab),
    locale: str(raw.locale),
    debug: bool(raw.debug),
    enableQuerySyntax: bool(raw.enableQuerySyntax),
    numberOfResults: num(raw.numberOfResults),
    context: (raw.context as Record<string, unknown>) ?? null,
    aq: str(raw.aq),
    cq: str(raw.cq),
    sortCriteria: str(raw.sortCriteria),
    pipelineRuleParameters: (raw.pipelineRuleParameters as Record<string, unknown>) ?? null,
    facets,
    actionsHistory: Array.isArray(raw.actionsHistory)
      ? (raw.actionsHistory as RequestBody['actionsHistory'])
      : [],
    extras,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
