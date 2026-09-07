import type {
  CapturedExchange,
  CapturedHeader,
  ReplayEnvelope,
  ResponseBodyState,
} from './types';
import { classifyCoveoRequest } from './classifyCoveoRequest';
import { readAnalyticsLabels } from './analyticsEvent';
import { readSearchBodyLabels } from './searchBody';

export interface HarEntryLike {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    headers: CapturedHeader[];
    postData?: { text?: string };
  };
  response: {
    status: number;
    statusText: string;
    headers: CapturedHeader[];
    content: { mimeType?: string };
  };
}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
]);

export function adaptHarEntry(
  entry: HarEntryLike,
  responseBodyState: ResponseBodyState = 'pending',
): { exchange: CapturedExchange; replay: ReplayEnvelope } | null {
  const family = classifyCoveoRequest(entry.request.url);
  if (!family) return null;

  const requestBody = entry.request.postData?.text ?? null;
  const requestContentType =
    entry.request.headers.find(({ name }) => name.toLowerCase() === 'content-type')?.value ?? null;
  const labels = readSearchBodyLabels(requestBody, requestContentType);
  const analytics =
    family === 'analytics'
      ? readAnalyticsLabels(entry.request.url, requestBody)
      : { eventClass: null, eventType: null, eventValue: null };
  const id = captureFingerprint(
    entry.startedDateTime,
    entry.request.method,
    entry.request.url,
    requestBody,
  );

  return {
    exchange: {
      id,
      startedAt: entry.startedDateTime,
      durationMs: entry.time,
      method: entry.request.method,
      url: redactUrlCredentials(entry.request.url),
      family,
      status: entry.response.status,
      statusText: entry.response.statusText,
      requestHeaders: redactHeaders(entry.request.headers),
      responseHeaders: redactHeaders(entry.response.headers),
      requestBody,
      responseBody: null,
      responseBodyState,
      responseMimeType: entry.response.content.mimeType ?? null,
      bodyError: null,
      query: labels.query,
      pipeline: labels.pipeline,
      eventClass: analytics.eventClass,
      eventType: analytics.eventType,
      eventValue: analytics.eventValue,
      replayOf: null,
    },
    replay: {
      method: entry.request.method,
      url: entry.request.url,
      headers: entry.request.headers.map(({ name, value }) => ({ name, value })),
      body: requestBody,
      family,
    },
  };
}

export function redactHeaders(headers: CapturedHeader[]): CapturedHeader[] {
  return headers.map(({ name, value }) => ({
    name,
    value: SENSITIVE_HEADERS.has(name.toLowerCase()) ? '***redacted***' : value,
  }));
}

const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token',
  'accesstoken',
  'api_key',
  'apikey',
  'authorization',
  'token',
]);

/** Search tokens often ride in the query string, where header redaction cannot reach them. */
export function redactUrlCredentials(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  let redacted = false;
  for (const name of [...url.searchParams.keys()]) {
    if (!SENSITIVE_QUERY_PARAMS.has(name.toLowerCase())) continue;
    url.searchParams.set(name, '***redacted***');
    redacted = true;
  }
  return redacted ? url.toString() : rawUrl;
}

export function decodeResponseBody(content: string, encoding: string): string {
  if (!encoding) return content;
  if (encoding.toLowerCase() !== 'base64') throw new Error(`Unsupported response encoding: ${encoding}`);
  const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function replayFingerprint(method: string, url: string, body: string | null): string {
  return `${method.toUpperCase()} ${url}\n${body ?? ''}`;
}

function captureFingerprint(startedAt: string, method: string, url: string, body: string | null): string {
  const source = `${startedAt}\n${replayFingerprint(method, url, body)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `capture-${(hash >>> 0).toString(16)}`;
}