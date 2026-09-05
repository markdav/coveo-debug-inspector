import type {
  DebugSession,
  Expressions,
  MlModels,
  Overview,
  ParsedRequest,
  QueryRankingExpression,
  RankingModel,
  ResultDoc,
  UserIdentity,
} from '../model/types';
import { parseJsonTolerant } from './jsonTolerant';
import { parseRequest } from './curlParser';
import { parseExpressionTree, parsePartialMatch } from './expressionParser';
import { parseExecutionReport, parseRankingInfo, parseSemanticFunction } from './reportParser';
import { analyze } from '../analysis/heuristics';

/**
 * Build a normalized DebugSession from raw response text and optional request
 * text. Parsing is tolerant: a malformed response still yields whatever could
 * be salvaged, and the request is optional.
 */
export function buildSession(responseText: string, requestText?: string): DebugSession {
  const respOutcome = parseJsonTolerant(responseText);
  const resp = (respOutcome.value ?? {}) as Record<string, unknown>;

  const requestOutcome = requestText && requestText.trim() ? parseRequest(requestText) : null;
  const request: ParsedRequest | null = requestOutcome?.value ?? null;

  const overview = buildOverview(resp, request);
  const expressions = buildExpressions(resp, request);
  const ranking = buildRanking(resp);
  const results = buildResults(resp, ranking);
  const ml = buildMl(resp, request);
  const warnings = Array.isArray(resp.warnings) ? (resp.warnings as string[]) : [];
  const executionTree = parseExecutionReport(resp.executionReport);

  const session: DebugSession = {
    request,
    overview,
    expressions,
    executionTree,
    ranking,
    results,
    ml,
    warnings,
    findings: [],
    parse: {
      response: {
        ok: respOutcome.ok,
        method: respOutcome.method,
        errors: respOutcome.errors,
        notes: respOutcome.notes,
      },
      request: {
        ok: requestOutcome?.ok ?? true,
        method: requestOutcome?.method ?? 'native',
        errors: requestOutcome?.errors ?? [],
        notes: requestOutcome?.notes ?? [],
      },
    },
  };

  session.findings = analyze(session);
  return session;
}

function buildOverview(resp: Record<string, unknown>, request: ParsedRequest | null): Overview {
  const identities: UserIdentity[] = Array.isArray(resp.userIdentities)
    ? (resp.userIdentities as Record<string, unknown>[]).map((u) => ({
        name: pick(u, ['name']),
        provider: pick(u, ['provider']),
        type: pick(u, ['type']),
      }))
    : [];
  return {
    searchUid: str(resp.searchUid),
    pipeline: str(resp.pipeline),
    apiVersion: numv(resp.apiVersion),
    totalCount: numv(resp.totalCount),
    totalCountFiltered: numv(resp.totalCountFiltered),
    duration: numv(resp.duration),
    indexDuration: numv(resp.indexDuration),
    requestDuration: numv(resp.requestDuration),
    index: str(resp.index),
    indexRegion: str(resp.indexRegion),
    userIdentities: identities,
    context: request?.body?.context ?? null,
  };
}

function buildExpressions(resp: Record<string, unknown>, request: ParsedRequest | null): Expressions {
  const basicRaw = str(resp.basicExpression);
  return {
    rawQuery: request?.body?.q ?? null,
    basicRaw,
    partialMatch: parsePartialMatch(basicRaw),
    advancedRaw: str(resp.advancedExpression),
    constantRaw: str(resp.constantExpression),
    disjunctionRaw: str(resp.disjunctionExpression),
    mandatoryRaw: str(resp.mandatoryExpression),
    advancedTree: parseExpressionTree(str(resp.advancedExpression)),
    constantTree: parseExpressionTree(str(resp.constantExpression)),
  };
}

function buildRanking(resp: Record<string, unknown>): RankingModel {
  const expressions: QueryRankingExpression[] = Array.isArray(resp.rankingExpressions)
    ? (resp.rankingExpressions as Record<string, unknown>[]).map(toRankingExpression)
    : [];
  const artExpressions = findArtExpressions(resp.executionReport);

  // Semantic function may appear in rankingExpressions or inside the execution
  // report's rankingFunctions. Search both.
  let semantic = null;
  for (const e of expressions) {
    const s = parseSemanticFunction(e.expression);
    if (s) {
      semantic = s;
      break;
    }
  }
  if (!semantic) {
    const fromReport = findSemanticInReport(resp.executionReport);
    if (fromReport) semantic = fromReport;
  }

  return { expressions, artExpressions, semantic };
}

function toRankingExpression(expression: Record<string, unknown>): QueryRankingExpression {
  return {
    expression: str(expression.expression) ?? '',
    modifier: numv(expression.modifier) ?? 0,
    isConstant: expression.isConstant === true,
    applyToEveryResult: expression.applyToEveryResult === true,
  };
}

function findArtExpressions(report: unknown): QueryRankingExpression[] {
  if (!report || typeof report !== 'object') return [];
  if (Array.isArray(report)) return report.flatMap(findArtExpressions);

  const node = report as Record<string, unknown>;
  const own =
    node.name === 'EvaluatingTopClicks' && Array.isArray(node.topResults)
      ? (node.topResults as Record<string, unknown>[]).map(toRankingExpression)
      : [];
  return [...own, ...Object.values(node).flatMap(findArtExpressions)];
}

function findSemanticInReport(report: unknown): ReturnType<typeof parseSemanticFunction> {
  const text = safeStringify(report);
  const m = text.match(/var min_cosine[\s\S]{0,600}?score\\n\}/);
  if (m) return parseSemanticFunction(m[0].replace(/\\n/g, '\n'));
  // fallback: any occurrence of min_cosine assignment
  if (/min_cosine/.test(text)) return parseSemanticFunction(text.replace(/\\n/g, '\n'));
  return null;
}

function buildResults(resp: Record<string, unknown>, ranking: RankingModel): ResultDoc[] {
  const arr = Array.isArray(resp.results) ? (resp.results as Record<string, unknown>[]) : [];
  return arr.map((r, i) => {
    const raw = (r.raw as Record<string, unknown>) ?? {};
    const rankingInfo = parseRankingInfo(str(r.rankingInfo));
    // JSON payloads label ART directly; legacy text needs the execution report.
    const declaredArt = rankingInfo?.qre
      .filter((entry) => entry.ruleType === 'automatic_relevance_tuning' && entry.score > 0)
      .reduce((total, entry) => total + entry.score, 0) ?? 0;
    const artExpressions = new Set(
      ranking.artExpressions
        .map((expression) => permanentIdFromExpression(expression.expression))
        .filter((permanentId): permanentId is string => permanentId !== null),
    );
    const inferredArt = rankingInfo?.qre.find((entry) => {
      const permanentId = permanentIdFromExpression(entry.expression);
      return entry.score > 0 && permanentId !== null && artExpressions.has(permanentId);
    })?.score ?? null;
    const artBoost = declaredArt > 0 ? declaredArt : inferredArt;
    const explicitlyRecommended =
      boolish(r.is_recommended) ||
      boolish(raw.is_recommended) ||
      boolish(raw.isrecommended);
    return {
      rank: i + 1,
      title: str(r.title),
      uri: str(r.uri),
      clickUri: str(r.clickUri),
      score: numv(r.score),
      percentScore: numv(r.percentScore),
      absentTerms: Array.isArray(r.absentTerms) ? (r.absentTerms as string[]) : [],
      excerpt: str(r.excerpt),
      contenttype: str(raw.contenttype),
      source: str(raw.source) ?? str(raw.syssource),
      isRecommended: explicitlyRecommended || artBoost !== null,
      artBoost,
      rankingInfo,
      raw,
    };
  });
}

function buildMl(resp: Record<string, unknown>, request: ParsedRequest | null): MlModels {
  const ext = (resp.extendedResults as Record<string, unknown>) ?? {};
  const id = str(ext.generativeQuestionAnsweringId);
  const rule = request?.body?.pipelineRuleParameters as Record<string, unknown> | undefined;
  const genqaConfig =
    (rule?.mlGenerativeQuestionAnswering as Record<string, unknown>) ?? null;
  return {
    rgaTriggered: Boolean(id),
    generativeQuestionAnsweringId: id,
    genqaConfig,
    notes: [],
  };
}

/* --------------------------------------------------------------- utilities */

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function numv(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
function boolish(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === 'string' && ['true', '1', 'yes'].includes(v.toLowerCase()));
}
function permanentIdFromExpression(expression: string): string | null {
  return expression.match(/@permanentid\s*={1,2}\s*["']?([^"'()\s]+)/i)?.[1].toLowerCase() ?? null;
}
function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) if (typeof obj[k] === 'string') return obj[k] as string;
  return null;
}
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
