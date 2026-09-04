import type { DebugSession, ExpectedDoc, Finding, ResultDoc } from '../model/types';

/**
 * Analyze a session and return Findings. This codifies the recurring Coveo
 * debugging patterns: loose partial match, semantic-gate starvation, folding
 * misconfiguration, and RGA-without-grounding.
 *
 * `expected` optionally names a doc the user expects to see (by permanentid /
 * uri / title substring), enabling targeted checks.
 */
export function analyze(session: DebugSession, expected?: ExpectedDoc): Finding[] {
  const findings: Finding[] = [];

  loosePartialMatch(session, findings);
  semanticGateStarvation(session, findings, expected);
  foldingMisconfig(session, findings);
  rgaUngrounded(session, findings, expected);
  passthroughWarnings(session, findings);

  return findings;
}

function loosePartialMatch(session: DebugSession, out: Finding[]): void {
  const pm = session.expressions.partialMatch;
  const results = session.results;
  if (!pm || results.length === 0) return;

  // Which query terms are absent from most results?
  const absentCounts = new Map<string, number>();
  for (const r of results) {
    for (const t of r.absentTerms) {
      absentCounts.set(t.toLowerCase(), (absentCounts.get(t.toLowerCase()) ?? 0) + 1);
    }
  }
  const threshold = Math.ceil(results.length * 0.6);
  const widelyAbsent = [...absentCounts.entries()]
    .filter(([, c]) => c >= threshold)
    .map(([t, c]) => `"${t}" absent from ${c}/${results.length} results`);

  if (widelyAbsent.length > 0) {
    out.push({
      id: 'loose-partial-match',
      severity: 'critical',
      title: `Partial match (${pm.match ?? '?'}) lets key terms be optional`,
      explanation:
        'One or more query terms are absent from the majority of results. With ' +
        `${pm.keywords.length} keywords and a ${pm.match ?? '?'} threshold, documents ` +
        'can qualify on product-name/other terms while the intent terms are optional. ' +
        'Consider raising the partial-match threshold or reducing keyword inflation ' +
        '(e.g. model-number splitting).',
      evidence: [`Keywords: ${pm.keywords.join(', ')}`, ...widelyAbsent],
    });
  }
}

function semanticGateStarvation(
  session: DebugSession,
  out: Finding[],
  expected?: ExpectedDoc,
): void {
  const sem = session.ranking.semantic;
  const results = session.results;
  if (!sem || results.length === 0) return;

  const withInfo = results.filter((r) => r.rankingInfo);
  if (withInfo.length === 0) return;

  const clearedGate = (r: ResultDoc) => (r.rankingInfo?.rankingFunctions ?? 0) > 0;
  const belowGate = withInfo.filter((r) => !clearedGate(r));

  // General signal: many results below the gate.
  if (belowGate.length >= Math.ceil(withInfo.length * 0.5)) {
    out.push({
      id: 'semantic-gate-general',
      severity: 'info',
      title: `Semantic gate (minCosine ${fmt(sem.minCosine)}) excludes many results`,
      explanation:
        `${belowGate.length}/${withInfo.length} results received no semantic boost ` +
        '(Ranking functions = 0), i.e. their vector similarity is below minCosine. ' +
        'That is fine for ranking, but the SE model also feeds RGA grounding — if the ' +
        'answer-bearing docs are below the gate, RGA has nothing to ground on.',
      evidence: belowGate.slice(0, 5).map((r) => `#${r.rank} ${r.title ?? r.uri ?? ''}`),
    });
  }

  // Targeted signal: the expected doc is present lexically but below the gate.
  if (expected) {
    const match = findExpected(results, expected);
    if (match && !clearedGate(match)) {
      out.push({
        id: 'semantic-gate-starves-expected',
        severity: 'critical',
        title: 'Expected document is present lexically but below the semantic gate',
        explanation:
          `The expected document appears at rank #${match.rank} on lexical weights but its ` +
          'semantic contribution is 0 (below minCosine). Because RGA grounds on the SE model’s ' +
          'passage retrieval — not the lexical top-N — this document is not available to RGA, ' +
          'which explains a missing answer even though the doc is visible. Consider lowering ' +
          'minCosine so the answer-bearing passages qualify.',
        evidence: [
          `#${match.rank} ${match.title ?? match.uri ?? ''}`,
          `minCosine=${fmt(sem.minCosine)}, this doc Ranking functions=${match.rankingInfo?.rankingFunctions ?? 0}`,
        ],
      });
    }
  }
}

function foldingMisconfig(session: DebugSession, out: Finding[]): void {
  const foldingWarning = session.warnings.find((w) => /filterField|nested queries/i.test(w));
  if (!foldingWarning) return;

  out.push({
    id: 'folding-misconfig',
    severity: 'warning',
    title: 'Folding appears misconfigured',
    explanation:
      'The API returned a folding warning. Folding requires a shared collection identifier plus ' +
      'parent/child fields; when filterField is misconfigured, related documents are not ' +
      'collapsed and duplicates consume result slots.',
    evidence: [`Warning: ${foldingWarning}`],
  });
}

function rgaUngrounded(session: DebugSession, out: Finding[], expected?: ExpectedDoc): void {
  if (!session.ml.rgaTriggered) {
    out.push({
      id: 'rga-not-triggered',
      severity: 'info',
      title: 'RGA (generated answer) did not trigger',
      explanation:
        'No generativeQuestionAnsweringId is present, so the RGA rule condition did not match ' +
        '(e.g. tab, anonymity, or the query pattern). If an answer was expected, check the ' +
        'mlGenerativeQuestionAnswering rule condition against this request.',
      evidence: [],
    });
    return;
  }
  // RGA triggered — note that the answer streams separately and isn't in this file.
  const sem = session.ranking.semantic;
  const expectedMatch = expected ? findExpected(session.results, expected) : null;
  // A capture without debug ranking info tells us nothing about the gate either way.
  const expectedBelowGate =
    expectedMatch?.rankingInfo != null && (expectedMatch.rankingInfo.rankingFunctions ?? 0) === 0;

  out.push({
    id: 'rga-triggered',
    severity: expectedBelowGate ? 'warning' : 'info',
    title: 'RGA triggered — answer is delivered by a separate stream',
    explanation:
      'A generativeQuestionAnsweringId was issued, so RGA fired. The generated answer is NOT in ' +
      'this search response — it streams from a separate endpoint keyed on that id. If you see no ' +
      'answer, verify you captured the stream.' +
      (expectedBelowGate
        ? ' Also note the expected doc is below the semantic gate (minCosine ' +
          `${fmt(sem?.minCosine ?? null)}), so RGA likely lacked grounding passages.`
        : ''),
    evidence: [`generativeQuestionAnsweringId: ${session.ml.generativeQuestionAnsweringId}`],
  });
}

function passthroughWarnings(session: DebugSession, out: Finding[]): void {
  const notable = session.warnings.filter((w) => !/filterField|nested queries/i.test(w));
  if (notable.length > 0) {
    out.push({
      id: 'api-warnings',
      severity: 'info',
      title: `${notable.length} API warning(s) returned`,
      explanation: 'The Coveo API returned warnings for this query. Review for facet/config issues.',
      evidence: notable,
    });
  }
}

/* --------------------------------------------------------------- utilities */

export function findExpected(results: ResultDoc[], expected: ExpectedDoc): ResultDoc | null {
  const needle = expected.needle.toLowerCase();
  return (
    results.find((r) =>
      [r.uri, r.title, String(r.raw.permanentid ?? '')].some(
        (f) => f && f.toLowerCase().includes(needle),
      ),
    ) ?? null
  );
}

function fmt(n: number | null): string {
  return n == null ? '?' : String(n);
}
