import React, { useState } from 'react';
import type { Severity } from '../model/types';

export function Panel({
  id,
  title,
  hint,
  children,
  defaultOpen = true,
}: {
  id?: string;
  title: string;
  hint?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel" id={id}>
      <header onClick={() => setOpen((o) => !o)}>
        <span className="muted">{open ? '▾' : '▸'}</span>
        <h2>{title}</h2>
        {hint && <span className="hint">{hint}</span>}
      </header>
      {open && <div className="body">{children}</div>}
    </section>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge ${severity}`}>{severity}</span>;
}

export function KV({ pairs }: { pairs: [string, React.ReactNode][] }) {
  return (
    <dl className="kv">
      {pairs.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v == null || v === '' ? <span className="muted">—</span> : v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function Chips({ items, muted }: { items: (string | null | undefined)[]; muted?: boolean }) {
  const clean = items.filter((x): x is string => !!x);
  if (clean.length === 0) return <span className="muted">—</span>;
  return (
    <div className="chips">
      {clean.map((c, i) => (
        <span className={`chip${muted ? ' mut' : ''}`} key={`${c}-${i}`}>
          {c}
        </span>
      ))}
    </div>
  );
}

export function Bar({ value, max, negative }: { value: number; max: number; negative?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.round((Math.abs(value) / max) * 100)) : 0;
  return (
    <div className="barwrap">
      <div className={`bar${negative ? ' neg' : ''}`} style={{ width: `${pct}%`, minWidth: value ? 2 : 0 }} />
      <span className="mono muted">{value}</span>
    </div>
  );
}

export function fmtMs(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n} ms`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}
