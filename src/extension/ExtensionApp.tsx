import { Fragment, useEffect, useState } from 'react';
import { buildSession } from '../ingest/buildSession';
import { SessionProvider } from '../state/store';
import { InspectorView } from '../components/InspectorView';
import { parseAnswerStream } from './answerStream';
import type {
  CapturedExchange,
  CapturedHeader,
  CaptureSnapshot,
  CoveoDevtoolsBridge,
  CoveoRequestFamily,
} from './types';

const EMPTY_SNAPSHOT: CaptureSnapshot = { exchanges: [], preserveLog: false };
const FAMILY_OPTIONS: Array<{ value: CoveoRequestFamily | 'all'; label: string }> = [
  { value: 'all', label: 'All Coveo' },
  { value: 'search', label: 'Search' },
  { value: 'query-suggest', label: 'Suggestions' },
  { value: 'rga-stream', label: 'RGA stream' },
  { value: 'answer-api', label: 'Answer API' },
  { value: 'agent', label: 'Agent' },
  { value: 'analytics', label: 'Analytics' },
  { value: 'recommendation', label: 'Recommendations' },
  { value: 'other', label: 'Other' },
];

const GENERATIVE_FAMILIES = new Set<CoveoRequestFamily>(['rga-stream', 'answer-api', 'agent']);

export function ExtensionApp() {
  const { bridge, snapshot } = useCaptureBridge();
  const [family, setFamily] = useState<CoveoRequestFamily | 'all'>('all');
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = snapshot.exchanges
    .filter((exchange) => family === 'all' || exchange.family === family)
    .filter((exchange) => matchesFilter(exchange, filter))
    .reverse();
  const selected = snapshot.exchanges.find(({ id }) => id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && snapshot.exchanges.some(({ id }) => id === selectedId)) return;
    setSelectedId(snapshot.exchanges[snapshot.exchanges.length - 1]?.id ?? null);
  }, [selectedId, snapshot.exchanges]);

  return (
    <div className="extension-app">
      <header className="extension-toolbar">
        <h1>Inspect Coveo</h1>
        <span className={`capture-status ${bridge ? 'active' : ''}`}>
          {bridge ? 'Recording' : 'Connecting'}
        </span>
        <select
          aria-label="Request family"
          value={family}
          onChange={(event) => setFamily(event.target.value as CoveoRequestFamily | 'all')}
        >
          {FAMILY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          className="request-filter"
          aria-label="Filter requests"
          placeholder="Filter URL, query, pipeline"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <label className="preserve-toggle">
          <input
            type="checkbox"
            checked={snapshot.preserveLog}
            disabled={!bridge}
            onChange={(event) => bridge?.setPreserveLog(event.target.checked)}
          />
          Preserve log
        </label>
        <button className="ghost compact" disabled={!bridge} onClick={() => bridge?.clear()}>
          Clear
        </button>
      </header>

      <div className="extension-workspace">
        <aside className="request-list" aria-label="Captured Coveo requests">
          <div className="request-list-heading">
            <strong>{filtered.length}</strong> of {snapshot.exchanges.length} requests
          </div>
          {filtered.length === 0 ? (
            <div className="extension-empty">
              {snapshot.exchanges.length
                ? 'No requests match the current filters.'
                : 'Reload or use the inspected page to capture Coveo traffic.'}
            </div>
          ) : (
            filtered.map((exchange) => (
              <RequestListItem
                key={exchange.id}
                exchange={exchange}
                selected={exchange.id === selectedId}
                onSelect={() => setSelectedId(exchange.id)}
              />
            ))
          )}
        </aside>
        <section className="request-detail">
          {selected ? (
            <RequestDetail key={selected.id} exchange={selected} bridge={bridge} />
          ) : (
            <div className="extension-empty detail-empty">Select a captured request to inspect it.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function RequestListItem({
  exchange,
  selected,
  onSelect,
}: {
  exchange: CapturedExchange;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`request-item${selected ? ' selected' : ''}`} onClick={onSelect}>
      <span className="request-item-topline">
        <span className={`family-badge ${exchange.family}`}>{familyLabel(exchange.family)}</span>
        <span className={exchange.status >= 400 ? 'status-error' : 'status-ok'}>{exchange.status}</span>
        <span>{formatTime(exchange.startedAt)}</span>
        {exchange.replayOf && <span className="replay-badge">Replay</span>}
      </span>
      <strong>{exchange.query || endpointLabel(exchange.url)}</strong>
      <span className="request-item-meta">
        {exchange.method} · {exchange.pipeline || endpointLabel(exchange.url)} · {Math.round(exchange.durationMs)} ms
      </span>
    </button>
  );
}

function RequestDetail({
  exchange,
  bridge,
}: {
  exchange: CapturedExchange;
  bridge: CoveoDevtoolsBridge | null;
}) {
  const [tab, setTab] = useState<'summary' | 'request' | 'response' | 'analysis' | 'answer'>('summary');
  const [replayState, setReplayState] = useState<'idle' | 'running' | 'done'>('idle');
  const [replayError, setReplayError] = useState<string | null>(null);
  const canReplay =
    exchange.family === 'search' &&
    exchange.method.toUpperCase() === 'POST' &&
    Boolean(exchange.requestBody) &&
    Boolean(bridge);
  const canAnalyze = exchange.family === 'search' && exchange.responseBodyState === 'ready';
  const isGenerative = GENERATIVE_FAMILIES.has(exchange.family);
  const canReadAnswer = isGenerative && exchange.responseBodyState === 'ready';

  async function replay() {
    if (!bridge) return;
    setReplayState('running');
    setReplayError(null);
    try {
      await bridge.replay(exchange.id);
      setReplayState('done');
    } catch (error) {
      setReplayState('idle');
      setReplayError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <header className="detail-header">
        <div>
          <div className="detail-title">
            <span className={`family-badge ${exchange.family}`}>{familyLabel(exchange.family)}</span>
            <strong>{exchange.method}</strong>
            <span className={exchange.status >= 400 ? 'status-error' : 'status-ok'}>
              {exchange.status} {exchange.statusText}
            </span>
            {exchange.replayOf && <span className="replay-badge">Replay</span>}
          </div>
          <div className="detail-url">{exchange.url}</div>
        </div>
        <button disabled={!canReplay || replayState === 'running'} onClick={replay}>
          {replayState === 'running' ? 'Replaying…' : replayState === 'done' ? 'Replay sent' : 'Replay with debug'}
        </button>
      </header>
      {replayError && <div className="notice err detail-notice">Replay failed: {replayError}</div>}
      <nav className="detail-tabs" aria-label="Request detail views">
        {(['summary', 'request', 'response'] as const).map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
            {capitalize(name)}
          </button>
        ))}
        {exchange.family === 'search' && (
          <button
            className={tab === 'analysis' ? 'active' : ''}
            disabled={!canAnalyze}
            onClick={() => setTab('analysis')}
          >
            Debug analysis
          </button>
        )}
        {isGenerative && (
          <button
            className={tab === 'answer' ? 'active' : ''}
            disabled={!canReadAnswer}
            onClick={() => setTab('answer')}
          >
            Answer
          </button>
        )}
      </nav>
      <div className={`detail-body${tab === 'analysis' ? ' analysis-body' : ''}`}>
        {tab === 'summary' && <SummaryView exchange={exchange} />}
        {tab === 'request' && (
          <PayloadView headers={exchange.requestHeaders} body={exchange.requestBody} empty="No request body captured." />
        )}
        {tab === 'response' && <ResponseView exchange={exchange} />}
        {tab === 'analysis' && <SearchAnalysis exchange={exchange} />}
        {tab === 'answer' && <AnswerView exchange={exchange} />}
      </div>
    </>
  );
}

function SummaryView({ exchange }: { exchange: CapturedExchange }) {
  return (
    <dl className="capture-summary">
      <dt>Started</dt>
      <dd>{new Date(exchange.startedAt).toLocaleString()}</dd>
      <dt>Duration</dt>
      <dd>{exchange.durationMs.toFixed(1)} ms</dd>
      <dt>Family</dt>
      <dd>{familyLabel(exchange.family)}</dd>
      <dt>Query</dt>
      <dd>{exchange.query ?? '—'}</dd>
      <dt>Pipeline</dt>
      <dd>{exchange.pipeline ?? '—'}</dd>
      <dt>Response type</dt>
      <dd>{exchange.responseMimeType ?? 'Unknown'}</dd>
      <dt>Capture</dt>
      <dd>{exchange.replayOf ? `Replay of ${exchange.replayOf}` : 'Original page request'}</dd>
    </dl>
  );
}

function PayloadView({
  headers,
  body,
  empty,
}: {
  headers: CapturedHeader[];
  body: string | null;
  empty: string;
}) {
  return (
    <div className="payload-view">
      <h2>Headers</h2>
      <HeadersView headers={headers} />
      <h2>Body</h2>
      {body == null ? <p className="muted">{empty}</p> : <pre className="json-viewer">{prettyJson(body)}</pre>}
    </div>
  );
}

function ResponseView({ exchange }: { exchange: CapturedExchange }) {
  const message =
    exchange.responseBodyState === 'pending'
      ? 'Response body is still loading.'
      : exchange.responseBodyState === 'unavailable'
        ? 'Response body is unavailable for a request completed before DevTools capture began.'
        : exchange.bodyError ?? 'Response body unavailable.';
  return (
    <PayloadView
      headers={exchange.responseHeaders}
      body={exchange.responseBody}
      empty={message}
    />
  );
}

function HeadersView({ headers }: { headers: CapturedHeader[] }) {
  if (!headers.length) return <p className="muted">No headers captured.</p>;
  return (
    <dl className="headers-list">
      {headers.map((header, index) => (
        <div key={`${header.name}-${index}`}>
          <dt>{header.name}</dt>
          <dd>{header.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SearchAnalysis({ exchange }: { exchange: CapturedExchange }) {
  if (!exchange.responseBody) return <p className="muted">No Search response body is available.</p>;
  try {
    const session = buildSession(exchange.responseBody, exchange.requestBody ?? undefined);
    return (
      <div className="extension-analysis">
        <SessionProvider initialSession={session}>
          {/* The panel's own Request/Response tabs already show the raw payloads. */}
          <InspectorView showRawData={false} />
        </SessionProvider>
      </div>
    );
  } catch (error) {
    return <div className="notice err">Unable to analyze response: {error instanceof Error ? error.message : String(error)}</div>;
  }
}

function AnswerView({ exchange }: { exchange: CapturedExchange }) {
  const stream = parseAnswerStream(exchange.responseBody);
  if (!stream) {
    return <p className="muted">No answer stream frames were found in this response.</p>;
  }

  const generated = stream.answerGenerated;
  return (
    <div className="answer-view">
      {generated === false && (
        <div className="notice warn">
          The stream completed without generating an answer
          {stream.completionReason ? ` (${stream.completionReason})` : ''}. The model declined to
          answer — usually because the retrieved passages did not support one.
        </div>
      )}      {stream.error && <div className="notice err">Stream error: {stream.error}</div>}
      {!stream.complete && (
        <div className="notice warn">
          The capture ends before the stream's terminating frame, so this view may be partial. The
          stream was probably still open when the body was read.
        </div>
      )}

      <dl className="capture-summary">
        <dt>Answer generated</dt>
        <dd>{generated == null ? '—' : generated ? 'Yes' : 'No'}</dd>
        <dt>Content format</dt>
        <dd>{stream.contentFormat ?? '—'}</dd>
        <dt>Answer style</dt>
        <dd>{stream.answerStyle ?? '—'}</dd>
        <dt>Finish reason</dt>
        <dd>{stream.finishReason ?? stream.completionReason ?? '—'}</dd>
        {stream.conversationId && (
          <>
            <dt>Conversation</dt>
            <dd>{stream.conversationId}</dd>
          </>
        )}
        {stream.runId && (
          <>
            <dt>Run</dt>
            <dd>{stream.runId}</dd>
          </>
        )}
        {stream.followUpEnabled != null && (
          <>
            <dt>Follow-up enabled</dt>
            <dd>{stream.followUpEnabled ? 'Yes' : 'No'}</dd>
          </>
        )}
        {stream.durationMs != null && (
          <>
            <dt>Run duration</dt>
            <dd>{(stream.durationMs / 1000).toFixed(1)} s</dd>
          </>
        )}
        <dt>Frames</dt>
        <dd>{stream.frameCount}</dd>
      </dl>

      {stream.steps.length > 0 && (
        <>
          <h2>Steps</h2>
          <ol className="answer-steps">
            {stream.steps.map((step, index) => (
              <li key={`${step.name}-${index}`}>
                <strong>{step.name}</strong>
                <span className="muted">
                  {step.startedAt != null && step.finishedAt != null
                    ? ` ${step.finishedAt - step.startedAt} ms`
                    : ' in progress'}
                </span>
                {step.toolCalls.map((call, index) => (
                  <div className="answer-tool-call" key={`${call.name}-${index}`}>
                    <code>{call.name}</code> {call.args}
                  </div>
                ))}
              </li>
            ))}
          </ol>
        </>
      )}

      <h2>Answer</h2>
      {stream.answer ? (
        <pre className="answer-text">{stream.answer}</pre>
      ) : (
        <p className="muted">The stream carried no answer text.</p>
      )}

      <h2>Citations ({stream.citations.length})</h2>
      {stream.citations.length === 0 ? (
        <p className="muted">No citations were returned.</p>
      ) : (
        <ol className="answer-citations">
          {stream.citations.map((citation, index) => (
            <li key={citation.id ?? index}>
              <div className="answer-citation-title">{citation.title ?? '(untitled)'}</div>
              <dl className="capture-summary">
                <dt>Permanent ID</dt>
                <dd>{citation.permanentid ?? '—'}</dd>
                <dt>Source</dt>
                <dd>{citation.source ?? '—'}</dd>
                {citation.filetype && (
                  <>
                    <dt>File type</dt>
                    <dd>{citation.filetype}</dd>
                  </>
                )}
                <dt>URI</dt>
                <dd>{citation.uri ?? '—'}</dd>
                {Object.entries(citation.fields).map(([key, value]) => (
                  <Fragment key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </Fragment>
                ))}
              </dl>
              {citation.text && (
                <details>
                  <summary>Cited passage</summary>
                  <pre>{citation.text}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function useCaptureBridge(): {
  bridge: CoveoDevtoolsBridge | null;
  snapshot: CaptureSnapshot;
} {
  const [bridge, setBridge] = useState<CoveoDevtoolsBridge | null>(
    () => window.__COVEO_DEVTOOLS_BRIDGE__ ?? null,
  );
  const [snapshot, setSnapshot] = useState<CaptureSnapshot>(
    () => window.__COVEO_DEVTOOLS_BRIDGE__?.getSnapshot() ?? EMPTY_SNAPSHOT,
  );

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    const connect = () => {
      unsubscribe?.();
      const nextBridge = window.__COVEO_DEVTOOLS_BRIDGE__;
      if (!nextBridge) return;
      setBridge(nextBridge);
      unsubscribe = nextBridge.subscribe(setSnapshot);
    };
    connect();
    window.addEventListener('coveo-bridge-ready', connect);
    return () => {
      unsubscribe?.();
      window.removeEventListener('coveo-bridge-ready', connect);
    };
  }, []);

  return { bridge, snapshot };
}

function matchesFilter(exchange: CapturedExchange, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return [exchange.url, exchange.query, exchange.pipeline, exchange.method, exchange.statusText]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle));
}

function familyLabel(family: CoveoRequestFamily): string {
  const labels: Record<CoveoRequestFamily, string> = {
    search: 'Search',
    'query-suggest': 'Suggest',
    analytics: 'Analytics',
    recommendation: 'Recommend',
    'rga-stream': 'RGA',
    'answer-api': 'Answer',
    agent: 'Agent',
    other: 'Other',
  };
  return labels[family];
}

function endpointLabel(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour12: false });
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}