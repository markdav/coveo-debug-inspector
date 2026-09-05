import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseJsonTolerant, extractValueForKey, matchValueEnd } from '../src/ingest/jsonTolerant';
import { parseRequest, extractDataRaw, extractHeaders, extractCurlUrl } from '../src/ingest/curlParser';
import { parsePartialMatch, parseExpressionTree } from '../src/ingest/expressionParser';
import { parseRankingInfo, parseSemanticFunction } from '../src/ingest/reportParser';
import { buildSession } from '../src/ingest/buildSession';
import { analyze } from '../src/analysis/heuristics';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => resolve(here, '../src/fixtures', name);
const read = (name: string) => readFileSync(fx(name), 'utf8');

describe('tolerant JSON parser', () => {
  it('parses clean JSON natively', () => {
    const out = parseJsonTolerant('{"a":1,"b":[1,2]}');
    expect(out.ok).toBe(true);
    expect(out.method).toBe('native');
    expect((out.value as any).b).toEqual([1, 2]);
  });

  it('repairs trailing-comma style errors', () => {
    const out = parseJsonTolerant('{"a":1,}');
    expect(out.ok).toBe(true);
    expect(['repaired', 'native']).toContain(out.method);
    expect((out.value as any).a).toBe(1);
  });

  it('salvages top-level fields from a corrupted real capture (v1)', () => {
    const out = parseJsonTolerant(read('v1-response-corrupted.json.txt'));
    expect(out.ok).toBe(true);
    // v1 has a broken termsToHighlight; we should still recover core fields.
    const v = out.value as any;
    expect(v.totalCount).toBe(14154);
    expect(Array.isArray(v.results)).toBe(true);
    expect(v.results.length).toBeGreaterThan(0);
  });

  it('parses the v3 capture (also corrupted) and recovers results', () => {
    const out = parseJsonTolerant(read('v3-response.json.txt'));
    expect(out.ok).toBe(true);
    const v = out.value as any;
    expect(v.totalCount).toBe(1040);
    expect(v.results.length).toBeGreaterThanOrEqual(10);
  });
});

describe('value extraction helpers', () => {
  it('matches bracketed values', () => {
    const s = '{"x": [1, [2, 3], {"y": 4}] }';
    const end = matchValueEnd(s, s.indexOf('['));
    expect(s.slice(s.indexOf('['), end)).toBe('[1, [2, 3], {"y": 4}]');
  });

  it('extracts a top-level key value', () => {
    const s = '{ "totalCount" : 42, "other": 1 }';
    expect(extractValueForKey(s, 'totalCount')).toBe('42');
  });
});

describe('curl parser', () => {
  it('extracts data-raw and redacts Authorization from the v3 request', () => {
    const text = read('v3-request.curl.txt');
    const headers = extractHeaders(text);
    expect(headers.redacted).toBe(true);
    expect(headers.headers['Authorization']).toBe('***redacted***');
    expect(extractDataRaw(text)).toBeTruthy();
  });

  it('parses the request body fields', () => {
    const out = parseRequest(read('v3-request.curl.txt'));
    expect(out.ok).toBe(true);
    expect(out.value?.authorizationRedacted).toBe(true);
    expect(out.value?.body?.q).toContain('power supply');
    expect(out.value?.body?.pipeline).toBe('support-search-pipeline');
    expect(out.value?.body?.tab).toBe('All');
  });

  it('finds the URL whether it is positional or behind --url', () => {
    expect(extractCurlUrl("curl 'https://acme.org.coveo.com/rest/search/v2' \\\n  -H 'Accept: */*'")).toBe(
      'https://acme.org.coveo.com/rest/search/v2',
    );
    expect(
      extractCurlUrl(
        "curl --url 'https://acme.org.coveo.com/rest/search/v2?organizationId=acme' \\\n" +
          "  -H 'Origin: https://support.example.com'",
      ),
    ).toBe('https://acme.org.coveo.com/rest/search/v2?organizationId=acme');
    expect(extractCurlUrl('curl -X POST https://acme.org.coveo.com/rest/search/v2')).toBe(
      'https://acme.org.coveo.com/rest/search/v2',
    );
    expect(extractCurlUrl('curl --compressed')).toBeNull();
  });

  it('recovers organizationId from a --url style command', () => {
    const out = parseRequest(
      "curl --url 'https://acme.org.coveo.com/rest/search/v2?organizationId=acmedemo1234' \\\n" +
        "  -H 'Content-Type: application/json' \\\n" +
        '  --data-raw \'{"q":"scratch org"}\'',
    );
    expect(out.value?.organizationId).toBe('acmedemo1234');
    expect(out.value?.body?.q).toBe('scratch org');
  });
});

describe('expression parsers', () => {
  it('parses PartialMatch keywords and threshold', () => {
    const basic =
      'PartialMatch(keywords=KeywordExpressionPartialMatchAtom(replace) ' +
      'KeywordExpressionPartialMatchAtom(power); match=75%; pick=Unspecified(); stopWords=;)';
    const pm = parsePartialMatch(basic);
    expect(pm?.match).toBe('75%');
    expect(pm?.keywords).toEqual(['replace', 'power']);
  });

  it('builds a boolean tree with OR/NOT and value lists', () => {
    const tree = parseExpressionTree('@a==1 OR (@b==2 NOT @c==(x,y))');
    expect(tree?.kind).toBe('or');
    // second branch is an AND of a leaf and a NOT
    expect(tree?.children?.length).toBe(2);
  });
});

describe('ranking info + semantic function', () => {
  it('parses document weights including Ranking functions', () => {
    const raw =
      'Document weights:\nTitle: 345; Quality: 0; Date: 165; Adjacency: 897; ' +
      'Source: 0; Custom: 0; QRE: 400; Ranking functions: 526; \n' +
      'QRE:\nExpression: "@source==docs" Score: 400\n' +
      'Ranking Functions:\nExpression: "semantic function" Score: 526\n\n' +
      'Terms weights:\npower: 100, 14; powered: 38, 24; \n' +
      'Title: 130; Concept: 10; Summary: 49; Frequency: 164; \n\nTotal weight: 2500';
    const info = parseRankingInfo(raw);
    expect(info?.weights['Title']).toBe(345);
    expect(info?.rankingFunctions).toBe(526);
    expect(info?.qre).toEqual([
      { expression: '"@source==docs"', score: 400, origin: null, ruleId: null, ruleType: null },
    ]);
    expect(info?.rankingFunctionDetails).toEqual([
      { expression: '"semantic function"', score: 526, origin: null, ruleId: null, ruleType: null },
    ]);
    expect(info?.terms[0]).toMatchObject({
      term: 'power',
      matches: '100, 14; powered: 38, 24',
      weights: { Title: 130, Concept: 10, Summary: 49, Frequency: 164 },
    });
  });

  it('decodes a semantic ranking function', () => {
    const expr =
      'var min_cosine := 0.87;\nvar min_ranking_modifier := 100.0;\n' +
      'var max_ranking_modifier := 2000.0;\nvar cos_sim := @knn_vector_abc_embeddings_vector_x;\n' +
      'if (cos_sim >= min_cosine) { }';
    const sem = parseSemanticFunction(expr);
    expect(sem?.minCosine).toBe(0.87);
    expect(sem?.maxRankingModifier).toBe(2000);
    expect(sem?.vectorField).toContain('knn_vector');
  });
});

describe('end-to-end session build (v3)', () => {
  const session = buildSession(read('v3-response.json.txt'), read('v3-request.curl.txt'));

  it('produces overview + results + ranking', () => {
    expect(session.overview.totalCount).toBe(1040);
    expect(session.results.length).toBeGreaterThanOrEqual(10);
    expect(session.ranking.semantic?.minCosine).toBe(0.87);
    expect(session.request?.authorizationRedacted).toBe(true);
  });

  it('flags RGA as triggered (id present)', () => {
    expect(session.ml.rgaTriggered).toBe(true);
    expect(session.ml.generativeQuestionAnsweringId).toBeTruthy();
  });

  it('detects semantic-gate starvation for the expected power-supply doc', () => {
    const findings = analyze(session, { needle: 'Power supply replacement' });
    const hit = findings.find((f) => f.id === 'semantic-gate-starves-expected');
    expect(hit).toBeTruthy();
    expect(hit?.severity).toBe('critical');
  });

  it('detects folding misconfiguration from the API warning', () => {
    const f = session.findings.find((x) => x.id === 'folding-misconfig');
    expect(f).toBeTruthy();
  });
});

describe('result recommendation flags', () => {
  it('derives ART from a positive nonconstant permanent-ID QRE', () => {
    const session = buildSession(JSON.stringify({
      rankingExpressions: [
        { expression: '@source==docs', modifier: 50, isConstant: true },
        { expression: '@permanentid=art-document', modifier: 250, isConstant: false },
        { expression: '@permanentid=custom-document', modifier: 500, isConstant: false },
      ],
      executionReport: {
        children: [{
          name: 'EvaluatingTopClicks',
          topResults: [{ expression: '@permanentid=art-document', modifier: 250, isConstant: false }],
        }],
      },
      results: [
        {
          title: 'ART result',
          rankingInfo: 'Document weights:\nQRE: 250; \nQRE:\nExpression: "@permanentid=art-document" Score: 250',
          raw: { permanentid: 'art-document' },
        },
        {
          title: 'Unapplied ART candidate',
          rankingInfo: 'Document weights:\nQRE: 0; \nQRE:\nExpression: "@permanentid=art-document" Score: 0',
          raw: {},
        },
        {
          title: 'Custom nonconstant QRE',
          rankingInfo: 'Document weights:\nQRE: 500; \nQRE:\nExpression: "@permanentid=custom-document" Score: 500',
          raw: {},
        },
        { title: 'Explicit recommendation', raw: { is_recommended: 'true' } },
        { title: 'Recommendation result', isRecommendation: true, raw: {} },
      ],
    }));

    expect(session.ranking.artExpressions).toHaveLength(1);
    expect(session.results.map((result) => result.isRecommended)).toEqual([true, false, false, true, false]);
    expect(session.results.map((result) => result.artBoost)).toEqual([250, null, null, null, null]);
  });

  it('does not label an ART candidate unless its QRE was applied', () => {
    const session = buildSession(read('v3-response.json.txt'), read('v3-request.curl.txt'));
    const candidate = session.results.find(
      (result) => result.raw.permanentid === '873a9446957e979b6a99ea211c499c3b0435bbd6f21b8c788f173ae7c348',
    );

    expect(candidate?.rankingInfo?.weights.QRE).toBe(0);
    expect(candidate?.isRecommended).toBe(false);
  });
});
