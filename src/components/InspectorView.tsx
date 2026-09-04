import { useSession } from '../state/store';
import { FindingsPanel, OverviewPanel, ExpressionPanel } from './panels';
import {
  ExecutionPanel,
  RankingPanel,
  MLPanel,
  WarningsPanel,
  RawJsonPanel,
} from './panels2';
import { ResultsPanel } from './ResultsPanel';

const NAV = [
  ['findings', 'Findings'],
  ['overview', 'Overview'],
  ['results', 'Results'],
  ['expressions', 'Expressions'],
  ['ranking', 'Ranking'],
  ['ml', 'RGA / ML'],
  ['execution', 'Execution'],
  ['warnings', 'Warnings'],
  ['raw', 'Raw data'],
] as const;

function ParseBanner() {
  const { session } = useSession();
  if (!session) return null;
  const parse = session.parse.response;
  if (parse.method === 'native') {
    return <div className="notice ok">Response parsed cleanly. {noteLine(parse.notes)}</div>;
  }
  const label =
    parse.method === 'repaired'
      ? 'repaired'
      : parse.method === 'salvaged'
        ? 'salvaged section-by-section'
        : 'failed';
  return (
    <div className={`notice ${parse.ok ? 'warn' : 'err'}`}>
      Response was {label} (the capture had corruption artifacts). Some fields may be partial.{' '}
      {parse.errors.slice(0, 2).join(' ')} {noteLine(parse.notes)}
    </div>
  );
}

function noteLine(notes: string[]): string {
  return notes.length ? notes.join(' ') : '';
}

export function InspectorView({ showRawData = true }: { showRawData?: boolean }) {
  const nav = showRawData ? NAV : NAV.filter(([id]) => id !== 'raw');
  return (
    <div className="layout">
      <nav className="sidebar">
        {nav.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>
      <main className="content">
        <ParseBanner />
        <FindingsPanel />
        <OverviewPanel />
        <ResultsPanel />
        <ExpressionPanel />
        <RankingPanel />
        <MLPanel />
        <ExecutionPanel />
        <WarningsPanel />
        {showRawData && <RawJsonPanel />}
      </main>
    </div>
  );
}