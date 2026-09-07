export interface AnalyticsLabels {
  eventClass: string | null;
  eventType: string | null;
  eventValue: string | null;
}

const TYPE_KEYS = ['eventType', 'actionCause', 'type'];
const VALUE_KEYS = ['eventValue', 'queryText', 'documentTitle', 'contentIdValue', 'searchQueryUid'];

/** The trailing path segment names the event: /rest/v15/analytics/custom, /click, /search, /view. */
export function readAnalyticsEventClass(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter(Boolean);
  let last = segments.pop();
  // Event Protocol posts to /events/v1, where the tail is the protocol version.
  if (last && /^v\d+$/i.test(last)) last = segments.pop();
  return last ? `/${last.toLowerCase()}` : null;
}

export function readAnalyticsLabels(rawUrl: string, body: string | null): AnalyticsLabels {
  const eventClass = readAnalyticsEventClass(rawUrl);
  const events = parseAnalyticsPayload(body);
  const first = events[0];
  if (!first) return { eventClass, eventType: null, eventValue: null };

  const meta = isRecord(first.meta) ? first.meta : null;
  let eventType = readString(first, TYPE_KEYS) ?? (meta ? readString(meta, ['type']) : null);
  if (eventType && events.length > 1) eventType = `${eventType} (+${events.length - 1} more)`;

  return { eventClass, eventType, eventValue: readString(first, VALUE_KEYS) };
}

function parseAnalyticsPayload(body: string | null): Record<string, unknown>[] {
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  return isRecord(parsed) ? [parsed] : [];
}

function readString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
