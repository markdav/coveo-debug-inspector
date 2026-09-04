/**
 * Normalized domain model for a parsed Coveo debug session.
 *
 * A "session" is the pairing of a captured request (curl / body) and its
 * `debug:true` search response. Everything the UI renders is derived into these
 * types by the ingestion layer so components never touch raw Coveo JSON.
 */

export type Severity = 'info' | 'warning' | 'critical';

/** Result of any tolerant parse step, so the UI can show partial success. */
export interface ParseOutcome<T> {
  value: T | null;
  ok: boolean;
  /** How the value was obtained: clean parse, repaired, or salvaged sections. */
  method: 'native' | 'repaired' | 'salvaged' | 'failed';
  errors: string[];
  /** Non-fatal notes (e.g. "Authorization header redacted"). */
  notes: string[];
}

/* ------------------------------------------------------------------ request */

export interface ParsedRequest {
  url: string | null;
  organizationId: string | null;
  /** Header names present (values redacted for anything sensitive). */
  headers: Record<string, string>;
  /** True if an Authorization header was present and stripped. */
  authorizationRedacted: boolean;
  body: RequestBody | null;
  /** Raw JSON body text (post-redaction) for the raw viewer. */
  rawBody: string | null;
}

export interface RequestBody {
  q: string | null;
  pipeline: string | null;
  searchHub: string | null;
  tab: string | null;
  locale: string | null;
  debug: boolean | null;
  enableQuerySyntax: boolean | null;
  numberOfResults: number | null;
  context: Record<string, unknown> | null;
  aq: string | null;
  cq: string | null;
  sortCriteria: string | null;
  /** genQA / dualEncoder rule parameters passed with the request. */
  pipelineRuleParameters: Record<string, unknown> | null;
  facets: RequestFacet[];
  actionsHistory: { name?: string; value?: string; time?: string }[];
  /** Anything else, kept for the raw viewer. */
  extras: Record<string, unknown>;
}

export interface RequestFacet {
  facetId: string | null;
  field: string | null;
  type: string | null;
}

/* ----------------------------------------------------------------- response */

export interface Overview {
  searchUid: string | null;
  pipeline: string | null;
  apiVersion: number | null;
  totalCount: number | null;
  totalCountFiltered: number | null;
  duration: number | null;
  indexDuration: number | null;
  requestDuration: number | null;
  index: string | null;
  indexRegion: string | null;
  userIdentities: UserIdentity[];
  /** Context echoed back / derived (user role, anonymity, etc). */
  context: Record<string, unknown> | null;
}

export interface UserIdentity {
  name: string | null;
  provider: string | null;
  type: string | null;
}

/** A boolean expression parsed into a display tree. */
export interface ExprNode {
  kind: 'and' | 'or' | 'not' | 'leaf';
  /** For leaves: the raw clause text (e.g. `@source==knowledge-base`). */
  text?: string;
  children?: ExprNode[];
}

export interface PartialMatchInfo {
  keywords: string[];
  /** e.g. "75%". */
  match: string | null;
  stopWords: string[];
  raw: string;
}

export interface Expressions {
  /** The user's raw q (from request) for reference. */
  rawQuery: string | null;
  basicRaw: string | null;
  partialMatch: PartialMatchInfo | null;
  advancedRaw: string | null;
  constantRaw: string | null;
  disjunctionRaw: string | null;
  mandatoryRaw: string | null;
  advancedTree: ExprNode | null;
  constantTree: ExprNode | null;
}

/** One node in the execution-report timeline. */
export interface ExecNode {
  name: string;
  description: string | null;
  duration: number | null;
  /** Applied rule payloads / results kept as readable strings when useful. */
  detail: string | null;
  children: ExecNode[];
}

export interface QueryRankingExpression {
  expression: string;
  modifier: number;
  isConstant: boolean;
  applyToEveryResult: boolean;
}

/** Decoded semantic (SE / dual-encoder) ranking function, if present. */
export interface SemanticFunction {
  minCosine: number | null;
  minRankingModifier: number | null;
  maxRankingModifier: number | null;
  vectorField: string | null;
  raw: string;
}

export interface RankingModel {
  expressions: QueryRankingExpression[];
  /** Top-click QREs emitted by ART's EvaluatingTopClicks stage. */
  artExpressions: QueryRankingExpression[];
  semantic: SemanticFunction | null;
}

/** Parsed per-result `rankingInfo`, from either the legacy text or API v2 JSON payload. */
export interface RankingInfo {
  /** JSON payloads fold per-term weights into `weights`; text payloads keep them separate. */
  format: 'text' | 'json';
  weights: Record<string, number>;
  /** The semantic ranking-function contribution (a.k.a. "Ranking functions"). */
  rankingFunctions: number | null;
  qre: { expression: string; score: number }[];
  rankingFunctionDetails: { expression: string; score: number }[];
  terms: {
    term: string;
    matches: string;
    weights: Record<string, number>;
  }[];
  raw: string;
}

export interface ResultDoc {
  rank: number;
  title: string | null;
  uri: string | null;
  clickUri: string | null;
  score: number | null;
  percentScore: number | null;
  absentTerms: string[];
  excerpt: string | null;
  contenttype: string | null;
  source: string | null;
  /** True when ART applied a top-click boost or Coveo explicitly marks the result recommended. */
  isRecommended: boolean;
  /** Applied ART top-click QRE score, when identifiable from ranking information. */
  artBoost: number | null;
  rankingInfo: RankingInfo | null;
  /** Full raw metadata for the detail/raw viewer. */
  raw: Record<string, unknown>;
}

export interface MlModels {
  /** True if the response carries a generativeQuestionAnsweringId. */
  rgaTriggered: boolean;
  generativeQuestionAnsweringId: string | null;
  /** genQA config from request (numberOfRankedResultsToConsider, sensitivity). */
  genqaConfig: Record<string, unknown> | null;
  /** Extra ML-related notes derived during analysis. */
  notes: string[];
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  explanation: string;
  /** Concrete evidence lines (result titles, values, warning text). */
  evidence: string[];
}

export interface DebugSession {
  request: ParsedRequest | null;
  overview: Overview;
  expressions: Expressions;
  executionTree: ExecNode[];
  ranking: RankingModel;
  results: ResultDoc[];
  ml: MlModels;
  warnings: string[];
  findings: Finding[];
  /** Parse diagnostics surfaced to the user. */
  parse: {
    response: Pick<ParseOutcome<unknown>, 'ok' | 'method' | 'errors' | 'notes'>;
    request: Pick<ParseOutcome<unknown>, 'ok' | 'method' | 'errors' | 'notes'>;
  };
}

/** Analysis input: caller may specify an expected/target doc to check for. */
export interface ExpectedDoc {
  /** Match against permanentid, uri, or title (substring, case-insensitive). */
  needle: string;
}
