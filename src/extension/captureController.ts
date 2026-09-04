import { CaptureLog } from './captureLog';
import {
  adaptHarEntry,
  decodeResponseBody,
  replayFingerprint,
  type HarEntryLike,
} from './harAdapter';
import {
  buildDebugReplay,
  createReadReplayResultExpression,
  createReplayExpression,
  type PageReplayResult,
} from './replay';
import type {
  CaptureSnapshot,
  CoveoDevtoolsBridge,
  ReplayEnvelope,
} from './types';

const REPLAY_POLL_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

export class CaptureController {
  private readonly log = new CaptureLog();
  private readonly listeners = new Set<(snapshot: CaptureSnapshot) => void>();
  private readonly replayEnvelopes = new Map<string, ReplayEnvelope>();
  private readonly pendingReplays = new Map<string, Array<{ captureId: string; replayToken: string }>>();
  private readonly replayTokens = new Map<string, string>();
  private readonly replayResults = new Map<string, PageReplayResult>();

  readonly bridge: CoveoDevtoolsBridge = {
    getSnapshot: () => this.log.getSnapshot(),
    subscribe: (listener) => {
      this.listeners.add(listener);
      listener(this.log.getSnapshot());
      return () => this.listeners.delete(listener);
    },
    clear: () => {
      this.clear();
      this.emit();
    },
    setPreserveLog: (value) => {
      this.log.setPreserveLog(value);
      this.emit();
    },
    replay: (captureId) => this.replay(captureId),
  };

  start(): void {
    chrome.devtools.network.onRequestFinished.addListener((request) => this.captureFinished(request));
    chrome.devtools.network.onNavigated.addListener(() => {
      if (!this.log.handleNavigation()) return;
      this.replayEnvelopes.clear();
      this.pendingReplays.clear();
      this.replayTokens.clear();
      this.replayResults.clear();
      this.emit();
    });
    chrome.devtools.network.getHAR((har) => {
      for (const entry of har.entries) this.captureEntry(entry, 'unavailable');
      this.emit();
    });
  }

  private captureFinished(request: chrome.devtools.network.Request): void {
    const captureId = this.captureEntry(request, 'pending');
    if (!captureId) return;

    request.getContent((content, encoding) => {
      if (!content && this.deferToReplayBody(captureId)) return;
      try {
        this.log.update(captureId, {
          responseBody: decodeResponseBody(content, encoding),
          responseBodyState: 'ready',
          bodyError: null,
        });
      } catch (error) {
        this.log.update(captureId, {
          responseBody: null,
          responseBodyState: 'error',
          bodyError: error instanceof Error ? error.message : String(error),
        });
      }
      this.emit();
    });
  }

  private captureEntry(
    entry: HarEntryLike,
    responseBodyState: 'pending' | 'unavailable',
  ): string | null {
    const adapted = adaptHarEntry(entry, responseBodyState);
    if (!adapted) return null;

    const existing = this.log
      .getSnapshot()
      .exchanges.find((exchange) => exchange.id === adapted.exchange.id);
    if (existing) {
      const bodyUpdate =
        responseBodyState === 'unavailable'
          ? {
              responseBody: existing.responseBody,
              responseBodyState: existing.responseBodyState,
              bodyError: existing.bodyError,
            }
          : {};
      this.log.update(adapted.exchange.id, {
        ...adapted.exchange,
        ...bodyUpdate,
        replayOf: existing.replayOf,
      });
    } else {
      const replayKey = replayFingerprint(
        adapted.replay.method,
        adapted.replay.url,
        adapted.replay.body,
      );
      const pendingReplay = this.consumePendingReplay(replayKey);
      adapted.exchange.replayOf = pendingReplay?.captureId ?? null;
      if (pendingReplay) this.replayTokens.set(adapted.exchange.id, pendingReplay.replayToken);
      this.log.add(adapted.exchange);
    }

    if (canReplay(adapted.replay)) {
      this.replayEnvelopes.set(adapted.exchange.id, adapted.replay);
    }
    this.pruneReplayEnvelopes();
    this.emit();
    return adapted.exchange.id;
  }

  private replay(captureId: string): Promise<void> {
    const envelope = this.replayEnvelopes.get(captureId);
    if (!envelope) return Promise.reject(new Error('This capture cannot be replayed.'));

    const request = buildDebugReplay(envelope);
    const key = replayFingerprint(request.method, request.url, request.body);
    const replayToken = crypto.randomUUID();
    const pending = this.pendingReplays.get(key) ?? [];
    this.pendingReplays.set(key, [...pending, { captureId, replayToken }]);

    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        this.removePendingReplay(key, captureId);
        reject(new Error(message));
      };

      chrome.devtools.inspectedWindow.eval<{ launched?: boolean }>(
        createReplayExpression(request, replayToken),
        (result, exceptionInfo) => {
          if (exceptionInfo?.isError || exceptionInfo?.isException) {
            fail(exceptionInfo.description || exceptionInfo.value || 'Replay evaluation failed.');
            return;
          }
          if (!result?.launched) {
            fail('Replay did not launch in the inspected page.');
            return;
          }
          this.pollReplayResult(replayToken, 0, resolve, fail);
        },
      );
    });
  }

  // The replay runs as a page fetch, so its outcome is polled rather than returned by eval.
  private pollReplayResult(
    replayToken: string,
    attempt: number,
    onSuccess: () => void,
    onError: (message: string) => void,
  ): void {
    chrome.devtools.inspectedWindow.eval<PageReplayResult | null>(
      createReadReplayResultExpression(replayToken),
      (result, exceptionInfo) => {
        if (exceptionInfo?.isError || exceptionInfo?.isException) {
          onError(exceptionInfo.description || exceptionInfo.value || 'Could not read the replay result.');
          return;
        }
        if (!result?.done) {
          if (attempt >= REPLAY_POLL_DELAYS_MS.length) {
            onError('Timed out waiting for the replay response.');
            return;
          }
          setTimeout(
            () => this.pollReplayResult(replayToken, attempt + 1, onSuccess, onError),
            REPLAY_POLL_DELAYS_MS[attempt],
          );
          return;
        }

        this.replayResults.set(replayToken, result);
        this.applyReplayResult(replayToken);
        if (result.error) onError(result.error);
        else onSuccess();
      },
    );
  }

  private applyReplayResult(replayToken: string): void {
    const result = this.replayResults.get(replayToken);
    if (!result) return;
    const captureId = [...this.replayTokens].find(([, token]) => token === replayToken)?.[0];
    if (!captureId) return;

    if (typeof result.body === 'string') {
      this.log.update(captureId, {
        responseBody: result.body,
        responseBodyState: 'ready',
        bodyError: null,
      });
    } else if (result.error) {
      this.log.update(captureId, {
        responseBody: null,
        responseBodyState: 'error',
        bodyError: result.error,
      });
    }
    this.replayResults.delete(replayToken);
    this.replayTokens.delete(captureId);
    this.emit();
  }

  // DevTools often reports an empty body for a replay it did not initiate.
  private deferToReplayBody(captureId: string): boolean {
    const replayToken = this.replayTokens.get(captureId);
    if (replayToken) {
      this.log.update(captureId, { responseBodyState: 'pending' });
      this.applyReplayResult(replayToken);
      this.emit();
      return true;
    }
    const existing = this.log.getSnapshot().exchanges.find((exchange) => exchange.id === captureId);
    return Boolean(existing?.responseBody);
  }

  private consumePendingReplay(key: string): { captureId: string; replayToken: string } | null {
    const pending = this.pendingReplays.get(key);
    if (!pending?.length) return null;
    const [replay, ...rest] = pending;
    if (rest.length) this.pendingReplays.set(key, rest);
    else this.pendingReplays.delete(key);
    return replay;
  }

  private removePendingReplay(key: string, captureId: string): void {
    const pending = this.pendingReplays.get(key)?.filter((replay) => replay.captureId !== captureId) ?? [];
    if (pending.length) this.pendingReplays.set(key, pending);
    else this.pendingReplays.delete(key);
  }

  private clear(): void {
    this.log.clear();
    this.replayEnvelopes.clear();
    this.pendingReplays.clear();
    this.replayTokens.clear();
    this.replayResults.clear();
  }

  private pruneReplayEnvelopes(): void {
    const activeIds = new Set(this.log.getSnapshot().exchanges.map(({ id }) => id));
    for (const id of this.replayEnvelopes.keys()) {
      if (!activeIds.has(id)) this.replayEnvelopes.delete(id);
    }
  }

  private emit(): void {
    const snapshot = this.log.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function canReplay(envelope: ReplayEnvelope): boolean {
  return envelope.family === 'search' && envelope.method.toUpperCase() === 'POST' && Boolean(envelope.body);
}