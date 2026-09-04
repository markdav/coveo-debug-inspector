import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatScore,
  lexicalContribution,
  ruleContribution,
  semanticContribution,
} from '../analysis/rankingContributions';
import type { ResultDoc } from '../model/types';
import { useSession } from '../state/store';
import { Panel } from './common';
import { ScoreVisualizations } from './ScoreVisualizations';

type SortKey = 'rank' | 'percentScore' | 'score' | 'lexical' | 'rf' | 'boost' | 'title';

function rf(d: ResultDoc): number {
  return semanticContribution(d);
}

function lexical(d: ResultDoc): number {
  return lexicalContribution(d);
}

function boost(d: ResultDoc): number {
  return ruleContribution(d);
}

export function ResultsPanel() {
  const { session, expected } = useSession();
  const [sort, setSort] = useState<SortKey>('rank');
  const [asc, setAsc] = useState(true);
  const [onlyBelowGate, setOnlyBelowGate] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [selectedRank, setSelectedRank] = useState<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(new Set());
    setSelectedRank(null);
  }, [session?.results]);

  const rows = useMemo(() => {
    let r = session?.results ?? [];
    if (onlyBelowGate) r = r.filter((d) => rf(d) === 0);
    const dir = asc ? 1 : -1;
    return [...r].sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sort) {
        case 'title':
          av = a.title ?? '';
          bv = b.title ?? '';
          break;
        case 'percentScore':
          av = a.percentScore ?? -1;
          bv = b.percentScore ?? -1;
          break;
        case 'score':
          av = a.score ?? -1;
          bv = b.score ?? -1;
          break;
        case 'rf':
          av = rf(a);
          bv = rf(b);
          break;
        case 'lexical':
          av = lexical(a);
          bv = lexical(b);
          break;
        case 'boost':
          av = boost(a);
          bv = boost(b);
          break;
        default:
          av = a.rank;
          bv = b.rank;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [session, sort, asc, onlyBelowGate]);

  const chartResults = useMemo(() => {
    const results = session?.results ?? [];
    return onlyBelowGate ? results.filter((result) => rf(result) === 0) : results;
  }, [session?.results, onlyBelowGate]);

  if (!session) return null;

  const needle = expected?.needle?.toLowerCase();
  function matchesExpected(d: ResultDoc): boolean {
    if (!needle) return false;
    return [d.uri, d.title, JSON.stringify(d.raw['permanentid'] ?? '')]
      .filter(Boolean)
      .some((v) => (v as string).toLowerCase().includes(needle));
  }

  function head(key: SortKey, label: string) {
    return (
      <th
        onClick={() => {
          if (sort === key) setAsc((a) => !a);
          else {
            setSort(key);
            setAsc(key === 'rank' || key === 'title');
          }
        }}
      >
        {label}
        {sort === key ? (asc ? ' ▲' : ' ▼') : ''}
      </th>
    );
  }

  function selectResult(rank: number) {
    setSelectedRank(rank);
    setExpanded((current) => new Set(current).add(rank));
    requestAnimationFrame(() => {
      tableRef.current
        ?.querySelector<HTMLElement>(`[data-result-rank="${rank}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  return (
    <Panel id="results" title="Results" hint={`${session.results.length} returned`}>
      <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={onlyBelowGate}
          onChange={(e) => setOnlyBelowGate(e.target.checked)}
        />{' '}
        Only show docs below the semantic gate (Ranking functions = 0)
      </label>
      <ScoreVisualizations
        results={chartResults}
        selectedRank={selectedRank}
        onSelectRank={selectResult}
      />
      <div ref={tableRef} style={{ overflowX: 'auto' }}>
        <table className="results">
          <thead>
            <tr>
              <th className="expand-heading"><span className="sr-only">Details</span></th>
              {head('rank', '#')}
              {head('title', 'Title')}
              {head('score', 'Score')}
              <th>Terms</th>
              {head('lexical', 'Lexical')}
              {head('rf', 'Semantic / RF')}
              {head('boost', 'Rule boost')}
              <th>ART</th>
              <th>Source / type</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const hit = matchesExpected(d);
              const rfv = rf(d);
              const isExpanded = expanded.has(d.rank);
              const queryTermCount = session.expressions.partialMatch?.keywords.length ?? 0;
              const matchedTermCount = Math.max(0, queryTermCount - d.absentTerms.length);
              return (
                <Fragment key={d.rank}>
                  <tr
                    className={`result-row${isExpanded ? ' expanded' : ''}${selectedRank === d.rank ? ' selected' : ''}`}
                    data-result-rank={d.rank}
                    style={hit ? { outline: '2px solid var(--accent)' } : undefined}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest('a, button, input, details, summary')) return;
                      setSelectedRank(d.rank);
                    }}
                  >
                    <td>
                      <button
                        className="expand-result"
                        type="button"
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ranking details for ${d.title ?? `result ${d.rank}`}`}
                        title={`${isExpanded ? 'Collapse' : 'Expand'} ranking details`}
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(d.rank)) next.delete(d.rank);
                            else next.add(d.rank);
                            return next;
                          })
                        }
                      >
                        {isExpanded ? '−' : '+'}
                      </button>
                    </td>
                    <td className="num">{d.rank}</td>
                    <td>
                      {hit && <span className="badge info" style={{ marginRight: 6 }}>target</span>}
                      {d.clickUri || d.uri ? (
                        <a href={d.clickUri ?? d.uri ?? '#'} target="_blank" rel="noreferrer">
                          {d.title ?? '(untitled)'}
                        </a>
                      ) : (
                        d.title ?? '(untitled)'
                      )}
                    </td>
                    <td className="num score-cell">
                      {formatScore(d.score)}
                      <span>{d.percentScore != null ? `${d.percentScore.toFixed(1)}%` : ''}</span>
                    </td>
                    <td className="num terms-cell">
                      {queryTermCount > 0 ? `${matchedTermCount}/${queryTermCount}` : d.rankingInfo?.terms.length || '—'}
                      {d.absentTerms.length > 0 && <span title={d.absentTerms.join(', ')}>−{d.absentTerms.length}</span>}
                    </td>
                    <td className="num">{d.rankingInfo ? formatScore(lexical(d)) : '—'}</td>
                    <td className={`num ${rfv > 0 ? 'rfpos' : 'rf0'}`}>{d.rankingInfo ? formatScore(rfv) : '—'}</td>
                    <td className={`num ${boost(d) > 0 ? 'boost-pos' : ''}`}>
                      {d.rankingInfo ? formatScore(boost(d)) : '—'}
                    </td>
                    <td>
                      {d.isRecommended ? (
                        <span className="badge art">
                          {d.artBoost != null ? `+${formatScore(d.artBoost)}` : 'yes'}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="source-cell">
                      {d.source ?? '—'}
                      {d.contenttype && <span>{d.contenttype}</span>}
                    </td>
                  </tr>
                  {isExpanded && <ResultRankingDetail result={d} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ResultRankingDetail({ result }: { result: ResultDoc }) {
  const info = result.rankingInfo;
  const termWeightNames = info
    ? Array.from(new Set(info.terms.flatMap((term) => Object.keys(term.weights))))
    : [];

  return (
    <tr className="ranking-detail-row">
      <td colSpan={10}>
        <div className="ranking-detail">
          {!info ? (
            <div className="notice warn">No ranking information was returned for this result.</div>
          ) : (
            <>
              <section>
                <h3>Score composition</h3>
                <dl className="score-components">
                  {Object.entries(info.weights).map(([name, value]) => (
                    <Fragment key={name}>
                      <dt>{name}</dt>
                      <dd className={value > 0 ? 'positive' : ''}>{formatScore(value)}</dd>
                    </Fragment>
                  ))}
                  <dt>Total score</dt>
                  <dd>{formatScore(result.score)}</dd>
                </dl>
                <details>
                  <summary>Raw ranking information</summary>
                  <pre>{info.raw}</pre>
                </details>
              </section>

              <section className="term-detail">
                <h3>Term relevance</h3>
                {info.terms.length > 0 ? (
                  <div className="detail-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Term</th>
                          <th>Matched variants</th>
                          {termWeightNames.map((name) => <th key={name}>{name}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {info.terms.map((term) => (
                          <tr key={term.term}>
                            <td className="term-name">{term.term}</td>
                            <td className="matches">{term.matches}</td>
                            {termWeightNames.map((name) => (
                              <td className="num" key={name}>{formatScore(term.weights[name] ?? 0)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="muted">No per-term weights returned.</div>}
                {result.absentTerms.length > 0 && (
                  <div className="absent-detail"><strong>Absent:</strong> {result.absentTerms.join(', ')}</div>
                )}
              </section>

              <section>
                <h3>Boosts and ranking functions</h3>
                <ScoredExpressions label="Query ranking expressions / rules" entries={info.qre} />
                <ScoredExpressions label="Ranking functions / semantic" entries={info.rankingFunctionDetails} />
                <div className="art-status">
                  <strong>ART top-click boost:</strong>{' '}
                  {result.artBoost != null ? `+${formatScore(result.artBoost)}` : result.isRecommended ? 'yes' : 'none'}
                </div>
              </section>
            </>
          )}

          <section className="result-metadata">
            <h3>Metadata</h3>
            {result.excerpt && <p className="result-excerpt">{result.excerpt}</p>}
            <dl className="metadata-grid">
              {metadataEntries(result).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <details>
              <summary>Raw result metadata</summary>
              <pre>{JSON.stringify(result.raw, null, 2)}</pre>
            </details>
          </section>
        </div>
      </td>
    </tr>
  );
}

function formatMetaValue(value: unknown): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Coveo mirrors many fields as `sys*`; drop the twin when it adds nothing. */
function metadataEntries(result: ResultDoc): [string, string][] {
  const raw: Record<string, unknown> =
    result.uri && !('uri' in result.raw) ? { uri: result.uri, ...result.raw } : result.raw;
  return Object.keys(raw)
    .filter((key) => {
      if (!key.startsWith('sys')) return true;
      const twin = key.slice(3);
      return !(twin in raw) || formatMetaValue(raw[twin]) !== formatMetaValue(raw[key]);
    })
    .sort((a, b) => a.localeCompare(b))
    .map((key) => [key, formatMetaValue(raw[key])]);
}

function ScoredExpressions({
  label,
  entries,
}: {
  label: string;
  entries: { expression: string; score: number }[];
}) {
  return (
    <div className="scored-expressions">
      <h4>{label}</h4>
      {entries.length > 0 ? entries.map((entry, index) => (
        <div className="scored-expression" key={`${entry.expression}-${index}`}>
          <code>{entry.expression}</code>
          <strong className={entry.score > 0 ? 'positive' : ''}>{formatScore(entry.score)}</strong>
        </div>
      )) : <div className="muted">None returned.</div>}
    </div>
  );
}
