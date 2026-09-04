import type { ExecNode, RankingInfo, SemanticFunction } from '../model/types';

/**
 * Parse a per-result `rankingInfo` debug payload. Coveo emits either the legacy
 * text form ("Document weights:\nTitle: 345; …") or, on API v2, a JSON object.
 */
export function parseRankingInfo(raw: string | null | undefined): RankingInfo | null {
  if (!raw) return null;
  if (raw.trimStart().startsWith('{')) return parseJsonRankingInfo(raw);

  const weights: Record<string, number> = {};
  // The "Document weights:" section contains `Name: number;` pairs. Split only
  // on a newline-preceded "QRE:" so the inline "QRE: 0;" weight is preserved
  // while the trailing "\nQRE:\nExpression…" detail section is dropped.
  const weightsSection = raw.split(/\nQRE:/i)[0] ?? raw;
  const pairRe = /([A-Za-z][A-Za-z ]*?):\s*(-?\d+(?:\.\d+)?)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(weightsSection)) !== null) {
    const name = m[1].trim();
    weights[name] = Number(m[2]);
  }

  const rankingFunctions =
    'Ranking functions' in weights ? weights['Ranking functions'] : null;

  const parseScoredExpressions = (section: string): { expression: string; score: number }[] => {
    const entries: { expression: string; score: number }[] = [];
    const expressionRe = /Expression:\s*([\s\S]*?)\s*Score:\s*(-?\d+(?:\.\d+)?)(?=\n|$)/g;
    let entry: RegExpExecArray | null;
    while ((entry = expressionRe.exec(section)) !== null) {
      entries.push({ expression: entry[1].trim(), score: Number(entry[2]) });
    }
    return entries;
  };

  const qreSection = raw.match(/\nQRE:\s*\n([\s\S]*?)(?=\nRanking Functions:|\nTerms weights:|$)/i)?.[1] ?? '';
  const rankingFunctionSection =
    raw.match(/\nRanking Functions:\s*\n([\s\S]*?)(?=\nTerms weights:|$)/i)?.[1] ?? '';
  const qre = parseScoredExpressions(qreSection);
  const rankingFunctionDetails = parseScoredExpressions(rankingFunctionSection);

  const terms: RankingInfo['terms'] = [];
  const termsSection = raw.match(/\nTerms weights:\s*\n([\s\S]*?)(?=\nTotal weight:|$)/i)?.[1] ?? '';
  const termRe = /^([^:\n]+):\s*([^\n]*);\s*\n([^\n]*)/gm;
  let termMatch: RegExpExecArray | null;
  while ((termMatch = termRe.exec(termsSection)) !== null) {
    const termWeights: Record<string, number> = {};
    const weightRe = /([A-Za-z][A-Za-z ]*?):\s*(-?\d+(?:\.\d+)?)\s*;/g;
    let weightMatch: RegExpExecArray | null;
    while ((weightMatch = weightRe.exec(termMatch[3])) !== null) {
      termWeights[weightMatch[1].trim()] = Number(weightMatch[2]);
    }
    terms.push({ term: termMatch[1].trim(), matches: termMatch[2].trim(), weights: termWeights });
  }

  return { format: 'text', weights, rankingFunctions, qre, rankingFunctionDetails, terms, raw };
}

/** Canonical names so both payload formats expose the same weight keys. */
const JSON_WEIGHT_LABELS: Record<string, string> = {
  adjacency: 'Adjacency',
  casing: 'Casing',
  concept: 'Concept',
  custom: 'Custom',
  date: 'Date',
  fieldBoosting: 'Field boosting',
  formatted: 'Formatted',
  frequency: 'Frequency',
  quality: 'Quality',
  queryRankingExpressions: 'QRE',
  rankingFunctions: 'Ranking functions',
  relation: 'Relation',
  reranker: 'Reranker',
  source: 'Source',
  summary: 'Summary',
  tfidf: 'TFIDF',
  title: 'Title',
  uri: 'URI',
};

function parseJsonRankingInfo(raw: string): RankingInfo | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const weights = weightRecord(parsed.documentWeights);
  const termsWeights = Array.isArray(parsed.termsWeights) ? parsed.termsWeights : [];
  const terms = termsWeights.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const variants = Object.entries((record.term ?? {}) as Record<string, unknown>)
      .map(([name, detail]) => ({
        name,
        correlation: Number((detail as Record<string, unknown>)?.correlation ?? 0),
      }))
      .sort((a, b) => b.correlation - a.correlation)
      .map(({ name }) => name);
    return {
      term: variants[0] ?? '(unknown)',
      matches: variants.join(', '),
      weights: weightRecord(record.weightInfo),
    };
  });

  return {
    format: 'json',
    weights,
    rankingFunctions: weights['Ranking functions'] ?? null,
    qre: scoredExpressions(parsed.queryRankingExpressions),
    rankingFunctionDetails: scoredExpressions(parsed.rankingFunctions),
    terms,
    raw,
  };
}

function weightRecord(source: unknown): Record<string, number> {
  if (!source || typeof source !== 'object') return {};
  const weights: Record<string, number> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value !== 'number') continue;
    weights[JSON_WEIGHT_LABELS[key] ?? humanizeKey(key)] = value;
  }
  return weights;
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function scoredExpressions(source: unknown): { expression: string; score: number }[] {
  if (!Array.isArray(source)) return [];
  return source
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => typeof entry.expression === 'string')
    .map((entry) => ({
      expression: String(entry.expression),
      score: typeof entry.score === 'number' ? entry.score : 0,
    }));
}

/**
 * Decode a Coveo semantic (SE / dual-encoder) ranking-function expression like:
 *   var min_cosine := 0.87;
 *   var min_ranking_modifier := 100.0;
 *   var max_ranking_modifier := 2000.0;
 *   var cos_sim := @knn_vector_..._embeddings_vector_...;
 *   if (cos_sim >= min_cosine) { ... }
 */
export function parseSemanticFunction(expression: string): SemanticFunction | null {
  if (!/min_cosine/.test(expression)) return null;
  const numFor = (name: string): number | null => {
    const mm = expression.match(new RegExp(`${name}\\s*:=\\s*(-?\\d+(?:\\.\\d+)?)`));
    return mm ? Number(mm[1]) : null;
  };
  const vectorField =
    expression.match(/:=\s*(@knn_vector_[A-Za-z0-9_]+)/)?.[1] ?? null;
  return {
    minCosine: numFor('min_cosine'),
    minRankingModifier: numFor('min_ranking_modifier'),
    maxRankingModifier: numFor('max_ranking_modifier'),
    vectorField,
    raw: expression,
  };
}

/**
 * Normalize the nested `executionReport` object into an ExecNode tree.
 * The report is loosely typed; we defensively pull name/description/duration
 * and recurse into `children` (array) when present.
 */
export function parseExecutionReport(report: unknown): ExecNode[] {
  if (!report || typeof report !== 'object') return [];
  const root = report as Record<string, unknown>;
  const children = Array.isArray(root.children) ? root.children : [];
  // The top-level report node itself often has name "Execution report"; expose
  // its children as the timeline, but if it has meaningful fields include it.
  if (children.length > 0) {
    return children.map((c) => toExecNode(c));
  }
  return [toExecNode(root)];
}

function toExecNode(node: unknown): ExecNode {
  if (!node || typeof node !== 'object') {
    return { name: String(node), description: null, duration: null, detail: null, children: [] };
  }
  const n = node as Record<string, unknown>;
  const children = Array.isArray(n.children) ? n.children.map(toExecNode) : [];
  return {
    name: typeof n.name === 'string' ? n.name : '(unnamed)',
    description: typeof n.description === 'string' ? n.description : null,
    duration: typeof n.duration === 'number' ? n.duration : null,
    detail: summarizeResult(n.result),
    children,
  };
}

function summarizeResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.name === 'string') return r.name;
    try {
      const s = JSON.stringify(r);
      return s.length > 200 ? s.slice(0, 200) + '…' : s;
    } catch {
      return null;
    }
  }
  return String(result);
}
