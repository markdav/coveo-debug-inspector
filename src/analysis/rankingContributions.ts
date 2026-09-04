import type { ResultDoc } from '../model/types';

export type ContributionKey =
  | 'terms'
  | 'title'
  | 'adjacency'
  | 'static'
  | 'custom'
  | 'rules'
  | 'art'
  | 'semantic'
  | 'residual';

export interface ScoreContribution {
  key: ContributionKey;
  label: string;
  value: number;
}

export interface ResultInfluence {
  result: ResultDoc;
  available: boolean;
  contributions: ScoreContribution[];
  organicLexical: number;
  semantic: number;
  rules: number;
  art: number;
  parsedTotal: number;
  residual: number;
}

const labels: Record<ContributionKey, string> = {
  terms: 'Terms',
  title: 'Title',
  adjacency: 'Adjacency',
  static: 'Date / quality / source',
  custom: 'Custom',
  rules: 'Rules',
  art: 'ART',
  semantic: 'Semantic',
  residual: 'Unexplained',
};

export function rankingWeight(result: ResultDoc, name: string): number {
  return result.rankingInfo?.weights[name] ?? 0;
}

/** Term-matching signals that a JSON payload reports as document weights. */
const JSON_TERM_WEIGHTS = ['TFIDF', 'Summary', 'Formatted', 'Relation', 'Concept', 'Casing', 'URI'];

export function termRelevance(result: ResultDoc): number {
  const info = result.rankingInfo;
  if (!info) return 0;
  // JSON payloads already fold per-term weights into the document weights.
  if (info.format === 'json') {
    return JSON_TERM_WEIGHTS.reduce((total, name) => total + (info.weights[name] ?? 0), 0);
  }
  return info.terms.reduce(
    (total, term) => total + Object.values(term.weights).reduce((sum, value) => sum + value, 0),
    0,
  );
}

export function lexicalContribution(result: ResultDoc): number {
  return termRelevance(result) + rankingWeight(result, 'Title') + rankingWeight(result, 'Adjacency');
}

export function semanticContribution(result: ResultDoc): number {
  return result.rankingInfo?.rankingFunctions ?? 0;
}

export function ruleContribution(result: ResultDoc): number {
  return rankingWeight(result, 'QRE') + rankingWeight(result, 'Custom');
}

export function decomposeResult(result: ResultDoc): ResultInfluence {
  if (!result.rankingInfo || result.score == null) {
    return {
      result,
      available: false,
      contributions: [],
      organicLexical: 0,
      semantic: 0,
      rules: 0,
      art: 0,
      parsedTotal: 0,
      residual: 0,
    };
  }

  const qre = rankingWeight(result, 'QRE');
  const art = result.artBoost == null ? 0 : Math.sign(qre || result.artBoost) * Math.min(Math.abs(result.artBoost), Math.abs(qre));
  const rules = qre - art;
  const values: Omit<ScoreContribution, 'label'>[] = [
    { key: 'terms', value: termRelevance(result) },
    { key: 'title', value: rankingWeight(result, 'Title') },
    { key: 'adjacency', value: rankingWeight(result, 'Adjacency') },
    {
      key: 'static',
      value:
        rankingWeight(result, 'Date') +
        rankingWeight(result, 'Quality') +
        rankingWeight(result, 'Source'),
    },
    { key: 'custom', value: rankingWeight(result, 'Custom') + rankingWeight(result, 'Field boosting') },
    { key: 'rules', value: rules },
    { key: 'art', value: art },
    { key: 'semantic', value: semanticContribution(result) + rankingWeight(result, 'Reranker') },
  ];
  const parsedTotal = values.reduce((total, contribution) => total + contribution.value, 0);
  const residual = result.score - parsedTotal;
  const contributions: ScoreContribution[] = [
    ...values.map((contribution) => ({ ...contribution, label: labels[contribution.key] })),
    { key: 'residual', label: labels.residual, value: residual },
  ];

  return {
    result,
    available: true,
    contributions,
    organicLexical:
      valueFor(contributions, 'terms') +
      valueFor(contributions, 'title') +
      valueFor(contributions, 'adjacency'),
    semantic: valueFor(contributions, 'semantic'),
    rules: valueFor(contributions, 'rules') + valueFor(contributions, 'custom'),
    art,
    parsedTotal,
    residual,
  };
}

export function valueFor(contributions: ScoreContribution[], key: ContributionKey): number {
  return contributions.find((contribution) => contribution.key === key)?.value ?? 0;
}

export function formatScore(value: number | null | undefined): string {
  return value == null ? '—' : value.toLocaleString();
}