import type { ExprNode, ResultDoc } from '../model/types';
import { useSession } from '../state/store';
import { findExpected } from '../analysis/heuristics';
import { Panel, KV, Chips, SeverityBadge, fmtMs, fmtNum } from './common';

export function FindingsPanel() {
  const { session, expected, setExpected } = useSession();
  if (!session) return null;
  const findings = session.findings;
  const match = expected ? findExpected(session.results, expected) : null;
  return (
    <Panel id="findings" title="Findings" hint={`${findings.length} detected`}>
      <div style={{ marginBottom: 12 }}>
        <label className="muted" style={{ fontSize: 12, marginRight: 8 }}>
          Expected / target doc (permanentid, uri, or title substring):
        </label>
        <input
          className="text"
          defaultValue={expected?.needle ?? ''}
          placeholder="e.g. reset admin password  or  a permanentid"
          onKeyDown={(e) => {
            if (e.key === 'Enter') setExpected((e.target as HTMLInputElement).value);
          }}
          onBlur={(e) => setExpected(e.target.value)}
        />
        {expected && <ExpectedDocStatus match={match} />}
      </div>
      {findings.length === 0 && <p className="muted">No heuristic findings.</p>}
      {findings.map((f) => (
        <div className={`finding ${f.severity}`} key={f.id}>
          <h3>
            <SeverityBadge severity={f.severity} /> {f.title}
          </h3>
          <p>{f.explanation}</p>
          {f.evidence.length > 0 && (
            <div className="evidence">
              {f.evidence.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
        </div>
      ))}
    </Panel>
  );
}

function ExpectedDocStatus({ match }: { match: ResultDoc | null }) {
  if (!match) {
    return (
      <div className="muted expected-status">
        No result on this page matches that text. Targeted checks need the document to be in the
        returned results.
      </div>
    );
  }
  return (
    <div className="muted expected-status">
      Matched #{match.rank} {match.title ?? match.uri ?? ''}
      {match.rankingInfo
        ? ''
        : ' — this capture has no ranking information, so semantic-gate checks are skipped. Replay with debug to enable them.'}
    </div>
  );
}

export function OverviewPanel() {
  const { session } = useSession();
  if (!session) return null;
  const o = session.overview;
  const b = session.request?.body;
  return (
    <Panel id="overview" title="Overview">
      <KV
        pairs={[
          ['Query (q)', <span className="mono">{b?.q ?? session.expressions.rawQuery}</span>],
          ['Pipeline', o.pipeline],
          ['Search hub', b?.searchHub],
          ['Tab', b?.tab],
          ['Locale', b?.locale],
          ['Total results', fmtNum(o.totalCount)],
          ['Returned', fmtNum(session.results.length)],
          ['Duration', fmtMs(o.duration)],
          ['Index duration', fmtMs(o.indexDuration)],
          ['Request duration', fmtMs(o.requestDuration)],
          ['Index / region', [o.index, o.indexRegion].filter(Boolean).join(' / ') || null],
          ['Search UID', <span className="mono">{o.searchUid}</span>],
          [
            'User identities',
            <Chips items={o.userIdentities.map((u) => [u.name, u.type].filter(Boolean).join(' · '))} />,
          ],
        ]}
      />
      {o.context && Object.keys(o.context).length > 0 && (
        <>
          <div className="muted" style={{ margin: '12px 0 4px' }}>
            Context (permission-relevant)
          </div>
          <Chips items={Object.entries(o.context).map(([k, v]) => `${k}=${JSON.stringify(v)}`)} muted />
        </>
      )}
    </Panel>
  );
}

function TreeNode({ node }: { node: ExprNode }) {
  if (node.kind === 'leaf') return <div className="leaf">{node.text}</div>;
  const label = node.kind.toUpperCase();
  return (
    <div className="node">
      <span className={node.kind === 'not' ? 'not' : 'op'}>{label}</span>
      {node.children?.map((c, i) => (
        <TreeNode key={i} node={c} />
      ))}
    </div>
  );
}

export function ExpressionPanel() {
  const { session } = useSession();
  if (!session) return null;
  const e = session.expressions;
  const pm = e.partialMatch;
  return (
    <Panel id="expressions" title="Query expressions" hint="how the query was expanded">
      <KV
        pairs={[
          ['Raw q', <span className="mono">{e.rawQuery}</span>],
          ['Basic expression', <span className="mono">{e.basicRaw}</span>],
        ]}
      />
      {pm && (
        <div style={{ marginTop: 10 }}>
          <div className="muted">
            Partial match — keywords ({pm.keywords.length}), threshold{' '}
            <b className="mono">{pm.match ?? '—'}</b>
          </div>
          <Chips items={pm.keywords} />
          {pm.stopWords.length > 0 && (
            <>
              <div className="muted" style={{ marginTop: 6 }}>
                Stop words removed
              </div>
              <Chips items={pm.stopWords} muted />
            </>
          )}
        </div>
      )}
      {(e.advancedTree || e.advancedRaw) && (
        <div style={{ marginTop: 12 }}>
          <div className="muted">Advanced expression (aq / filters)</div>
          {e.advancedTree ? (
            <div className="tree">
              <TreeNode node={e.advancedTree} />
            </div>
          ) : (
            <div className="mono">{e.advancedRaw}</div>
          )}
        </div>
      )}
      {e.constantRaw && (
        <div style={{ marginTop: 12 }}>
          <div className="muted">Constant expression (cq — cached filters)</div>
          {e.constantTree ? (
            <div className="tree">
              <TreeNode node={e.constantTree} />
            </div>
          ) : (
            <div className="mono">{e.constantRaw}</div>
          )}
        </div>
      )}
      {e.disjunctionRaw && (
        <div style={{ marginTop: 12 }}>
          <div className="muted">Disjunction expression (ML-injected candidates)</div>
          <div className="mono" style={{ wordBreak: 'break-word' }}>
            {e.disjunctionRaw}
          </div>
        </div>
      )}
    </Panel>
  );
}
