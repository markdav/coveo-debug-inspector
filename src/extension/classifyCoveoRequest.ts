import type { CoveoRequestFamily } from './types';

const COVEO_HOST_SUFFIXES = ['.coveo.com', '.coveo.cloud'];

// Coveo hosts also serve the UI bundles, whose paths can look like API paths (coveo.analytics.js).
const STATIC_ASSET_PATH =
  /\.(m?js|cjs|css|map|html?|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|wasm|txt|xml)$/;

export function classifyCoveoRequest(rawUrl: string): CoveoRequestFamily | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (STATIC_ASSET_PATH.test(path)) return null;
  const isCoveoHost =
    host === 'coveo.com' ||
    host === 'coveo.cloud' ||
    COVEO_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));

  // Proxied deployments (Salesforce, Sitecore, custom gateways) tunnel the Coveo
  // REST API through the page's own origin, so classify on the `/rest/...` tail.
  const restIndex = path.lastIndexOf('/rest/');
  const target = restIndex === -1 ? path : path.slice(restIndex);

  if (!isCoveoHost) {
    // Only a literal `coveo` path segment is a strong enough signal on a foreign host.
    if (restIndex === -1 || !/(^|\/)coveo(\/|$)/.test(path)) return null;
  }

  if (target.includes('querysuggest')) return 'query-suggest';
  if (target.includes('recommend')) return 'recommendation';
  // Search API RGA: the last path segment is the search response's
  // extendedResults.generativeQuestionAnsweringId.
  if (target.includes('/machinelearning/streaming/')) return 'rga-stream';
  // Answer API (CRGA), plus the Insight panel variant.
  if (/\/answer\/v1\/configs\/[^/]+\/generate/.test(target)) return 'answer-api';
  if (/\/insight\/v1\/configs\/[^/]+\/answer\/[^/]+\/generate/.test(target)) return 'answer-api';
  // Agent API lives under /api/preview, so it is matched on the full path.
  if (/\/agents\/[^/]+(\/|$)/.test(path)) return 'agent';
  // Checked before analytics: a proxy path may itself contain "analytics".
  if (target === '/rest/search' || target.startsWith('/rest/search/')) return 'search';
  if (host.startsWith('analytics.') || /\/analytics(\/|$)/.test(target) || target.includes('/rest/ua')) {
    return 'analytics';
  }
  return target === '/rest' || target.startsWith('/rest/') ? 'other' : null;
}