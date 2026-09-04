import { useMemo, useState } from 'react';
import {
  decomposeResult,
  formatScore,
  type ContributionKey,
  type ResultInfluence,
} from '../analysis/rankingContributions';
import type { ResultDoc } from '../model/types';

interface ScoreVisualizationsProps {
  results: ResultDoc[];
  selectedRank: number | null;
  onSelectRank: (rank: number) => void;
}

const contributionOrder: ContributionKey[] = [
  'terms',
  'title',
  'adjacency',
  'static',
  'custom',
  'rules',
  'art',
  'semantic',
  'residual',
];

const chartWidth = 760;
const labelWidth = 300;
const plotWidth = 400;
const scoreX = 712;

export function ScoreVisualizations({
  results,
  selectedRank,
  onSelectRank,
}: ScoreVisualizationsProps) {
  const [limit, setLimit] = useState<10 | 25>(10);
  const influences = useMemo(
    () => [...results].sort((a, b) => a.rank - b.rank).slice(0, limit).map(decomposeResult),
    [results, limit],
  );
  const available = influences.filter((influence) => influence.available);

  return (
    <section className="score-visualizations" aria-label="Result influence visualizations">
      <header className="visualization-header">
        <div>
          <h3>Result influence</h3>
          <p>Compare the score components that moved each result.</p>
        </div>
        <div className="limit-control" aria-label="Number of charted results">
          {[10, 25].map((value) => (
            <button
              className={limit === value ? 'active' : ''}
              type="button"
              aria-pressed={limit === value}
              key={value}
              onClick={() => setLimit(value as 10 | 25)}
            >
              Top {value}
            </button>
          ))}
        </div>
      </header>

      {available.length === 0 ? (
        <div className="visualization-empty">No per-result ranking information is available to chart.</div>
      ) : (
        <div className="visualization-grid">
          <ContributionChart
            influences={available}
            selectedRank={selectedRank}
            onSelectRank={onSelectRank}
          />
        </div>
      )}
    </section>
  );
}

function ContributionChart({
  influences,
  selectedRank,
  onSelectRank,
}: {
  influences: ResultInfluence[];
  selectedRank: number | null;
  onSelectRank: (rank: number) => void;
}) {
  const positiveMax = Math.max(
    1,
    ...influences.map((influence) =>
      influence.contributions.reduce((sum, contribution) => sum + Math.max(0, contribution.value), 0),
    ),
  );
  const negativeMax = Math.max(
    0,
    ...influences.map((influence) =>
      Math.abs(influence.contributions.reduce((sum, contribution) => sum + Math.min(0, contribution.value), 0)),
    ),
  );
  const scaleMax = positiveMax + negativeMax;
  const zeroX = labelWidth + (negativeMax / scaleMax) * plotWidth;
  const scale = plotWidth / scaleMax;
  const rowHeight = 23;
  const height = 24 + influences.length * rowHeight;

  return (
    <section className="visualization contribution-visualization">
      <div className="visualization-title">
        <h4>Score contributions</h4>
        <span>Signed components reconcile to total score</span>
      </div>
      <ContributionLegend influences={influences} />
      <div className="contribution-scroll">
        <svg
          className="contribution-chart"
          viewBox={`0 0 ${chartWidth} ${height}`}
          role="img"
          aria-label="Stacked score contributions by result rank"
        >
          <line className="chart-zero" x1={zeroX} x2={zeroX} y1={14} y2={height - 3} />
          <text className="axis-label" x={zeroX} y={10} textAnchor="middle">0</text>
          {influences.map((influence, index) => {
            const y = 20 + index * rowHeight;
            let positiveCursor = zeroX;
            let negativeCursor = zeroX;
            const selected = selectedRank === influence.result.rank;
            const summary = influenceSummary(influence);
            return (
              <g
                className={`chart-result ${selected ? 'selected' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={summary}
                key={influence.result.rank}
                onClick={() => onSelectRank(influence.result.rank)}
                onKeyDown={(event) => activateWithKeyboard(event, () => onSelectRank(influence.result.rank))}
              >
                <title>{summary}</title>
                <rect className="chart-hit-area" x={0} y={y - 13} width={chartWidth} height={rowHeight - 1} />
                <text className="result-chart-label" x={4} y={y + 2.5}>
                  <tspan className="rank-label">#{influence.result.rank}</tspan>
                  <tspan dx={6}>{truncate(influence.result.title ?? '(untitled)', 48)}</tspan>
                </text>
                {influence.contributions.map((contribution) => {
                  if (contribution.value === 0) return null;
                  const width = Math.abs(contribution.value) * scale;
                  let x: number;
                  if (contribution.value > 0) {
                    x = positiveCursor;
                    positiveCursor += width;
                  } else {
                    negativeCursor -= width;
                    x = negativeCursor;
                  }
                  return (
                    <rect
                      className={`contribution-segment contribution-${contribution.key}`}
                      x={x}
                      y={y - 7.5}
                      width={Math.max(width, 0.75)}
                      height={12}
                      key={contribution.key}
                    >
                      <title>{contribution.label}: {formatSigned(contribution.value)}</title>
                    </rect>
                  );
                })}
                <text className="chart-score" x={scoreX} y={y + 2.5}>{formatScore(influence.result.score)}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

function ContributionLegend({ influences }: { influences: ResultInfluence[] }) {
  const present = new Set(
    influences.flatMap((influence) =>
      influence.contributions.filter((contribution) => contribution.value !== 0).map((contribution) => contribution.key),
    ),
  );
  return (
    <div className="contribution-legend" aria-label="Contribution legend">
      {contributionOrder.filter((key) => present.has(key)).map((key) => (
        <span key={key}><i className={`contribution-${key}`} />{labelFor(influences, key)}</span>
      ))}
    </div>
  );
}

function influenceSummary(influence: ResultInfluence): string {
  const parts = influence.contributions
    .filter((contribution) => contribution.value !== 0)
    .map((contribution) => `${contribution.label} ${formatSigned(contribution.value)}`)
    .join(', ');
  return `Result ${influence.result.rank}: ${influence.result.title ?? 'untitled'}. Total ${formatScore(influence.result.score)}. ${parts}`;
}

function labelFor(influences: ResultInfluence[], key: ContributionKey): string {
  return influences.flatMap((influence) => influence.contributions).find((part) => part.key === key)?.label ?? key;
}

function activateWithKeyboard(event: React.KeyboardEvent, activate: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate();
  }
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${formatScore(value)}`;
}