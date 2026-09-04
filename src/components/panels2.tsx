import { useState } from 'react';
import type { ExecNode } from '../model/types';
import { useSession } from '../state/store';
import { Panel, KV, fmtMs } from './common';

function ExecTree({ node, depth }: { node: ExecNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const hasKids = node.children.length > 0;
  return (
    <div className="exec-node">
      <div>
        {hasKids && (
          <span className="muted" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
            {open ? '▾ ' : '▸ '}
          </span>
        )}
        <span className="name">{node.name}</span>
        {node.duration != null && <span className="dur">{fmtMs(node.duration)}</span>}
        {node.detail && <div className="detail">{node.detail}</div>}
      </div>
      {open && node.children.map((c, i) => <ExecTree key={i} node={c} depth={depth + 1} />)}
    </div>
  );
}

export function ExecutionPanel() {
  const { session } = useSession();
  if (!session) return null;
  if (session.executionTree.length === 0)
    return (
      <Panel id="execution" title="Execution report" defaultOpen={false}>
        <p className="muted">No execution report in this response (was debug:true set?).</p>
      </Panel>
    );
  return (
    <Panel id="execution" title="Execution report" hint="pipeline stage timeline" defaultOpen={false}>
      <div className="tree">
        {session.executionTree.map((n, i) => (
          <ExecTree key={i} node={n} depth={0} />
        ))}
      </div>
    </Panel>
  );
}

export function RankingPanel() {
  const { session } = useSession();
  if (!session) return null;
  const r = session.ranking;
  const sem = r.semantic;
  return (
    <Panel id="ranking" title="Ranking model" hint="QRE + semantic (SE) function">
      {sem ? (
        <KV
          pairs={[
            ['Semantic encoder', 'detected (dual-encoder / SE)'],
            ['min_cosine (gate)', <b className="mono">{sem.minCosine ?? '—'}</b>],
            ['min ranking modifier', <span className="mono">{sem.minRankingModifier ?? '—'}</span>],
            ['max ranking modifier', <span className="mono">{sem.maxRankingModifier ?? '—'}</span>],
            ['vector field', <span className="mono">{sem.vectorField}</span>],
          ]}
        />
      ) : (
        <p className="muted">No semantic ranking function found in the execution report.</p>
      )}
      {sem && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Only documents whose cosine similarity ≥ <b>{sem.minCosine}</b> receive a semantic boost
          ("Ranking functions" &gt; 0) and are eligible for RGA grounding. Docs at 0 are below the gate.
        </p>
      )}
      {r.expressions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted">Query ranking expressions ({r.expressions.length})</div>
          <table className="results" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>Expression</th>
                <th>Modifier</th>
                <th>Constant</th>
              </tr>
            </thead>
            <tbody>
              {r.expressions.slice(0, 40).map((x, i) => (
                <tr key={i}>
                  <td className="mono" style={{ maxWidth: 520, overflow: 'hidden' }}>
                    {x.expression}
                  </td>
                  <td className="num">{x.modifier}</td>
                  <td>{x.isConstant ? 'yes' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function MLPanel() {
  const { session } = useSession();
  if (!session) return null;
  const ml = session.ml;
  return (
    <Panel id="ml" title="RGA / Machine learning" hint={ml.rgaTriggered ? 'RGA triggered' : 'RGA not triggered'}>
      <KV
        pairs={[
          ['RGA triggered', ml.rgaTriggered ? 'yes' : 'no'],
          [
            'generativeQuestionAnsweringId',
            <span className="mono">{ml.generativeQuestionAnsweringId ?? '—'}</span>,
          ],
        ]}
      />
      {ml.genqaConfig && Object.keys(ml.genqaConfig).length > 0 && (
        <>
          <div className="muted" style={{ margin: '10px 0 4px' }}>
            genQA config (from request)
          </div>
          <pre className="json-viewer" style={{ maxHeight: 200 }}>
            {JSON.stringify(ml.genqaConfig, null, 2)}
          </pre>
        </>
      )}
      {ml.notes.length > 0 && (
        <ul className="muted" style={{ fontSize: 12 }}>
          {ml.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        The RGA answer itself streams from a separate endpoint and is not part of this response — only
        the trigger id and grounding signals are shown here.
      </p>
    </Panel>
  );
}

export function WarningsPanel() {
  const { session } = useSession();
  if (!session || session.warnings.length === 0) return null;
  return (
    <Panel id="warnings" title="Warnings" hint={`${session.warnings.length}`}>
      {session.warnings.map((w, i) => (
        <div className="notice warn" key={i}>
          {w}
        </div>
      ))}
    </Panel>
  );
}

export function RawJsonPanel() {
  const { session } = useSession();
  const [tab, setTab] = useState<'response' | 'request'>('response');
  if (!session) return null;
  const text =
    tab === 'response'
      ? JSON.stringify(
          {
            overview: session.overview,
            expressions: session.expressions,
            ranking: session.ranking,
            resultCount: session.results.length,
          },
          null,
          2,
        )
      : session.request?.rawBody ?? '(no request body captured)';
  return (
    <Panel id="raw" title="Raw / parsed data" defaultOpen={false}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button className={tab === 'response' ? '' : 'ghost'} onClick={() => setTab('response')}>
          Parsed response
        </button>
        <button className={tab === 'request' ? '' : 'ghost'} onClick={() => setTab('request')}>
          Request body
        </button>
      </div>
      <pre className="json-viewer">{text}</pre>
    </Panel>
  );
}
