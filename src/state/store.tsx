import React, { createContext, useContext, useMemo, useState } from 'react';
import type { DebugSession, ExpectedDoc } from '../model/types';
import { buildSession } from '../ingest/buildSession';
import { analyze } from '../analysis/heuristics';

interface SessionState {
  session: DebugSession | null;
  expected: ExpectedDoc | null;
  error: string | null;
  load: (responseText: string, requestText?: string) => void;
  setExpected: (needle: string) => void;
  reset: () => void;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({
  children,
  initialSession = null,
}: {
  children: React.ReactNode;
  initialSession?: DebugSession | null;
}) {
  const [session, setSession] = useState<DebugSession | null>(initialSession);
  const [expected, setExpectedDoc] = useState<ExpectedDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = useMemo<SessionState>(
    () => ({
      session,
      expected,
      error,
      load(responseText: string, requestText?: string) {
        try {
          const s = buildSession(responseText, requestText);
          if (!s.parse.response.ok && s.results.length === 0 && s.overview.totalCount == null) {
            setError('Could not parse the response — it may not be a Coveo search response.');
          } else {
            setError(null);
          }
          setSession(s);
        } catch (e) {
          setError((e as Error).message);
          setSession(null);
        }
      },
      setExpected(needle: string) {
        const trimmed = needle.trim();
        const exp = trimmed ? { needle: trimmed } : null;
        setExpectedDoc(exp);
        // Re-run analysis with the expected doc for targeted findings.
        setSession((prev) => (prev ? { ...prev, findings: analyze(prev, exp ?? undefined) } : prev));
      },
      reset() {
        setSession(null);
        setExpectedDoc(null);
        setError(null);
      },
    }),
    [session, expected, error],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
