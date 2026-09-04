import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decomposeResult,
  lexicalContribution,
  valueFor,
} from '../src/analysis/rankingContributions';
import { buildSession } from '../src/ingest/buildSession';
import { parseRankingInfo } from '../src/ingest/reportParser';
import type { RankingInfo, ResultDoc } from '../src/model/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(here, '../src/fixtures', name), 'utf8');

function result(overrides: Partial<ResultDoc> = {}, weights: Record<string, number> = {}): ResultDoc {
  const rankingInfo: RankingInfo = {
    format: 'text',
    weights,
    rankingFunctions: weights['Ranking functions'] ?? 0,
    qre: [],
    rankingFunctionDetails: [],
    terms: [],
    raw: '',
  };
  return {
    rank: 1,
    title: 'Result',
    uri: null,
    clickUri: null,
    score: 0,
    percentScore: null,
    absentTerms: [],
    excerpt: null,
    contenttype: null,
    source: null,
    isRecommended: false,
    artBoost: null,
    rankingInfo,
    raw: {},
    ...overrides,
  };
}

describe('ranking contribution decomposition', () => {
  it('reconciles terms, document weights, rules, ART, semantic, and residual', () => {
    const document = result(
      {
        score: 1000,
        artBoost: 100,
        rankingInfo: {
          format: 'text',
          weights: {
            Title: 50,
            Adjacency: 100,
            Date: 20,
            Quality: 10,
            Source: -5,
            Custom: 15,
            QRE: 140,
            'Ranking functions': 200,
          },
          rankingFunctions: 200,
          qre: [],
          rankingFunctionDetails: [],
          terms: [{ term: 'power', matches: '100, 1', weights: { Title: 30, Frequency: 200 } }],
          raw: '',
        },
      },
    );

    const influence = decomposeResult(document);
    expect(influence.organicLexical).toBe(380);
    expect(influence.rules).toBe(55);
    expect(influence.art).toBe(100);
    expect(influence.semantic).toBe(200);
    expect(influence.residual).toBe(240);
    expect(influence.contributions.reduce((sum, part) => sum + part.value, 0)).toBe(1000);
  });

  it('preserves negative demotions and caps ART at the QRE total', () => {
    const influence = decomposeResult(result({ score: -45, artBoost: 250 }, { QRE: -45 }));
    expect(valueFor(influence.contributions, 'art')).toBe(-45);
    expect(valueFor(influence.contributions, 'rules')).toBe(0);
    expect(influence.residual).toBe(0);
  });

  it('returns unavailable when score details are missing', () => {
    const influence = decomposeResult(result({ score: null, rankingInfo: null }));
    expect(influence.available).toBe(false);
    expect(influence.contributions).toEqual([]);
  });

  it('fully attributes an API v2 JSON rankingInfo payload', () => {
    const rankingInfo = parseRankingInfo(
      JSON.stringify({
        documentWeights: {
          adjacency: 1019,
          casing: 0,
          concept: 43,
          custom: 0,
          date: 987,
          fieldBoosting: 0,
          formatted: 101,
          quality: 0,
          queryRankingExpressions: 1460,
          rankingFunctions: 2118,
          relation: 123,
          reranker: 0,
          source: 0,
          summary: 265,
          tfidf: 989,
          title: 993,
          uri: 0,
        },
        queryRankingExpressions: [{ expression: '@permanentid=f126', score: 1460 }],
        rankingFunctions: [{ expression: 'var min_cosine := 0.8;', score: 2118 }],
        termsWeights: [
          {
            term: { archived: { correlation: 100 }, archives: { correlation: 6.27 } },
            weightInfo: { frequency: 255, title: 138, summary: 52 },
          },
        ],
        totalWeight: 8098,
      }),
    );

    expect(rankingInfo?.format).toBe('json');
    expect(rankingInfo?.rankingFunctions).toBe(2118);
    expect(rankingInfo?.terms[0]).toMatchObject({ term: 'archived', matches: 'archived, archives' });

    const influence = decomposeResult(result({ score: 8098, rankingInfo }));
    expect(valueFor(influence.contributions, 'terms')).toBe(1521);
    expect(valueFor(influence.contributions, 'title')).toBe(993);
    expect(valueFor(influence.contributions, 'adjacency')).toBe(1019);
    expect(valueFor(influence.contributions, 'rules')).toBe(1460);
    expect(valueFor(influence.contributions, 'semantic')).toBe(2118);
    expect(influence.residual).toBe(0);
  });

  it('fully reconciles the first real v3 result', () => {
    const session = buildSession(fixture('v3-response.json.txt'), fixture('v3-request.curl.txt'));
    const influence = decomposeResult(session.results[0]);

    expect(lexicalContribution(session.results[0])).toBe(3625);
    expect(influence.semantic).toBe(467);
    expect(influence.parsedTotal).toBe(4272);
    expect(influence.residual).toBe(0);
  });
});