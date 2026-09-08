import type { InterceptorReport } from './pageInterceptors';

export type CoveoRequestFamily =
  | 'search'
  | 'query-suggest'
  | 'analytics'
  | 'recommendation'
  | 'rga-stream'
  | 'answer-api'
  | 'agent'
  | 'other';

export interface CapturedHeader {
  name: string;
  value: string;
}

export type ResponseBodyState = 'pending' | 'ready' | 'unavailable' | 'error';

export interface CapturedExchange {
  id: string;
  startedAt: string;
  durationMs: number;
  method: string;
  url: string;
  family: CoveoRequestFamily;
  status: number;
  statusText: string;
  requestHeaders: CapturedHeader[];
  responseHeaders: CapturedHeader[];
  requestBody: string | null;
  responseBody: string | null;
  responseBodyState: ResponseBodyState;
  responseMimeType: string | null;
  bodyError: string | null;
  query: string | null;
  pipeline: string | null;
  eventClass: string | null;
  eventType: string | null;
  eventValue: string | null;
  replayOf: string | null;
}

export interface ReplayEnvelope {
  method: string;
  url: string;
  headers: CapturedHeader[];
  body: string | null;
  family: CoveoRequestFamily;
}

export interface ReplayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  credentials?: RequestCredentials;
}

export interface CaptureSnapshot {
  exchanges: CapturedExchange[];
  preserveLog: boolean;
  interceptors?: InterceptorReport;
}

export interface CoveoDevtoolsBridge {
  getSnapshot(): CaptureSnapshot;
  subscribe(listener: (snapshot: CaptureSnapshot) => void): () => void;
  clear(): void;
  setPreserveLog(value: boolean): void;
  replay(captureId: string): Promise<void>;
}

declare global {
  interface Window {
    __COVEO_DEVTOOLS_BRIDGE__?: CoveoDevtoolsBridge;
  }
}