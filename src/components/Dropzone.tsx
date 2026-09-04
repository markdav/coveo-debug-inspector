import React, { useState } from 'react';
import { useSession } from '../state/store';

const SAMPLE_HINT =
  'Paste the debug search response JSON (required) and optionally the request curl/body.';

export function Dropzone() {
  const { load, error } = useSession();
  const [drag, setDrag] = useState(false);
  const [response, setResponse] = useState('');
  const [request, setRequest] = useState('');

  function onDrop(e: React.DragEvent, target: 'response' | 'request') {
    e.preventDefault();
    setDrag(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    file.text().then((t) => (target === 'response' ? setResponse(t) : setRequest(t)));
  }

  return (
    <div
      className={`dropzone${drag ? ' drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
    >
      <h2>Coveo Debug Inspector</h2>
      <p>{SAMPLE_HINT}</p>
      <p className="muted" style={{ fontSize: 12 }}>
        Everything runs locally in your browser. No query is replayed and no data leaves this page.
        Any <code>Authorization</code> header is stripped on ingest.
      </p>

      {error && <div className="notice err">{error}</div>}

      <div className="row">
        <div onDrop={(e) => onDrop(e, 'response')} onDragOver={(e) => e.preventDefault()}>
          <label>Debug response JSON *</label>
          <textarea
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            placeholder='Drop or paste the search response (with "results", "executionReport", …)'
          />
        </div>
        <div onDrop={(e) => onDrop(e, 'request')} onDragOver={(e) => e.preventDefault()}>
          <label>Request curl / body (optional)</label>
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="Drop or paste the curl command or JSON body"
          />
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button disabled={!response.trim()} onClick={() => load(response, request || undefined)}>
          Analyze
        </button>
      </div>
    </div>
  );
}
