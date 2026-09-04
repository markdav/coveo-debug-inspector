const FORM_MIME = 'application/x-www-form-urlencoded';

function isFormEncoded(body: string, contentType: string | null): boolean {
  if ((contentType ?? '').toLowerCase().includes(FORM_MIME)) return true;
  const trimmed = body.trim();
  return !trimmed.startsWith('{') && /^[^=&\s]+=/.test(trimmed);
}

/** Coveo's JS Search UI posts form-encoded bodies; Atomic/Headless post JSON. */
export function enableDebugInSearchBody(body: string, contentType: string | null): string {
  if (isFormEncoded(body, contentType)) {
    const params = new URLSearchParams(body);
    params.set('debug', 'true');
    return params.toString();
  }
  const parsed = JSON.parse(body) as Record<string, unknown>;
  parsed.debug = true;
  return JSON.stringify(parsed);
}

export function readSearchBodyLabels(
  body: string | null,
  contentType: string | null = null,
): { query: string | null; pipeline: string | null } {
  if (!body) return { query: null, pipeline: null };
  if (isFormEncoded(body, contentType)) {
    const params = new URLSearchParams(body);
    return { query: params.get('q'), pipeline: params.get('pipeline') };
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      query: typeof parsed.q === 'string' ? parsed.q : null,
      pipeline: typeof parsed.pipeline === 'string' ? parsed.pipeline : null,
    };
  } catch {
    return { query: null, pipeline: null };
  }
}
