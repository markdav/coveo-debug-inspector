import type { ReplayEnvelope, ReplayRequest } from './types';
import { enableDebugInSearchBody } from './searchBody';

const FORBIDDEN_REPLAY_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'origin',
  'referer',
  'transfer-encoding',
  'user-agent',
]);

// Browser-generated headers that become author headers on replay and would force a CORS preflight
// the original request never made. DevTools' "Disable cache" adds cache-control/pragma, for example.
const PREFLIGHT_FORCING_HEADERS = new Set([
  'accept-encoding',
  'cache-control',
  'dnt',
  'if-modified-since',
  'if-none-match',
  'pragma',
  'priority',
  'te',
  'upgrade-insecure-requests',
]);

function isReplayableHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith(':')) return false; // HTTP/2 pseudo-headers appear in DevTools captures.
  if (lowerName.startsWith('sec-')) return false;
  if (lowerName.startsWith('proxy-')) return false;
  return !FORBIDDEN_REPLAY_HEADERS.has(lowerName) && !PREFLIGHT_FORCING_HEADERS.has(lowerName);
}

export function buildDebugReplay(envelope: ReplayEnvelope): ReplayRequest {
  if (envelope.family !== 'search') throw new Error('Only Search requests can be replayed.');
  if (envelope.method.toUpperCase() !== 'POST') throw new Error('Only POST Search requests can be replayed.');
  if (!envelope.body) throw new Error('The captured request has no body.');

  const contentType =
    envelope.headers.find(({ name }) => name.toLowerCase() === 'content-type')?.value ?? null;

  let body: string;
  try {
    body = enableDebugInSearchBody(envelope.body, contentType);
  } catch {
    throw new Error('The captured Search request body is neither JSON nor form-encoded.');
  }

  const headers: Record<string, string> = {};
  for (const { name, value } of envelope.headers) {
    if (!isReplayableHeader(name)) continue;
    headers[name] = value;
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  // `include` on an endpoint that answers `Access-Control-Allow-Origin: *` fails CORS outright.
  const sentCookies = envelope.headers.some(({ name }) => name.toLowerCase() === 'cookie');

  return {
    method: 'POST',
    url: envelope.url,
    headers,
    body,
    credentials: sentCookies ? 'include' : 'omit',
  };
}

export function createReplayExpression(request: ReplayRequest, replayToken: string = crypto.randomUUID()): string {
  const requestJson = JSON.stringify(request);
  return `(${launchReplay.toString()})(${requestJson},${JSON.stringify(replayToken)})`;
}

export function createReadReplayResultExpression(replayToken: string): string {
  return `(${readReplayResult.toString()})(${JSON.stringify(replayToken)})`;
}

export interface PageReplayResult {
  done: boolean;
  ok?: boolean;
  status?: number;
  body?: string;
  error?: string;
}

function launchReplay(request: ReplayRequest, replayToken: string): { launched: true } {
  const replayResults = ((globalThis as Record<string, unknown>).__COVEO_DEBUG_REPLAY_RESULTS__ ??=
    Object.create(null)) as Record<string, PageReplayResult>;
  replayResults[replayToken] = { done: false };
  globalThis.setTimeout(() => delete replayResults[replayToken], 60_000);

  void fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    credentials: request.credentials ?? 'omit',
  })
    .then(async (response) => {
      replayResults[replayToken] = {
        done: true,
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
    })
    .catch((error: unknown) => {
      replayResults[replayToken] = {
        done: true,
        error: error instanceof Error ? error.message : String(error),
      };
    });

  return { launched: true };
}

function readReplayResult(replayToken: string): PageReplayResult | null {
  const replayResults = (globalThis as Record<string, unknown>).__COVEO_DEBUG_REPLAY_RESULTS__ as
    | Record<string, PageReplayResult>
    | undefined;
  const result = replayResults?.[replayToken] ?? null;
  if (result?.done && replayResults) delete replayResults[replayToken];
  return result;
}