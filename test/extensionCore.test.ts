import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureLog } from '../src/extension/captureLog';
import { CaptureController } from '../src/extension/captureController';
import { classifyCoveoRequest } from '../src/extension/classifyCoveoRequest';
import { parseAnswerStream } from '../src/extension/answerStream';
import { readAnalyticsLabels } from '../src/extension/analyticsEvent';
import {
  createInterceptorProbeExpression,
  describeInterceptors,
  NO_INTERCEPTORS,
} from '../src/extension/pageInterceptors';
import { adaptHarEntry, decodeResponseBody, redactUrlCredentials, type HarEntryLike } from '../src/extension/harAdapter';
import {
  buildDebugReplay,
  createReadReplayResultExpression,
  createReplayExpression,
} from '../src/extension/replay';
import type { CapturedExchange, ReplayEnvelope } from '../src/extension/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Coveo request classification', () => {
  it.each([
    ['https://acme.org.coveo.com/rest/search/v2', 'search'],
    ['https://platform.cloud.coveo.com/rest/search/v2/querySuggest', 'query-suggest'],
    ['https://analytics.cloud.coveo.com/rest/ua/v15/analytics/search', 'analytics'],
    ['https://acme.org.coveo.com/rest/search/v2/recommend', 'recommendation'],
    ['https://platform.cloud.coveo.com/rest/organizations/acme', 'other'],
    // Proxied through the page's own origin (e.g. the Salesforce Coveo package).
    [
      'https://help.example.com/services/apexrest/coveo/analytics/rest/search/v2?organizationId=acme',
      'search',
    ],
    ['https://help.example.com/coveo/rest/search/v2', 'search'],
    ['https://help.example.com/services/apexrest/coveo/rest/ua/v15/analytics/click', 'analytics'],
    // Generative answering: three distinct architectures.
    [
      'https://acme.org.coveo.com/rest/organizations/acme/machinelearning/streaming/0b88324c-1bac-4d44-b65f-5811435ff0cb',
      'rga-stream',
    ],
    ['https://acme.org.coveo.com/rest/organizations/acme/answer/v1/configs/cfg-1/generate', 'answer-api'],
    [
      'https://acme.org.coveo.com/rest/organizations/acme/insight/v1/configs/ins-1/answer/cfg-1/generate',
      'answer-api',
    ],
    [
      'https://acme.org.coveo.com/api/preview/organizations/acme/agents/709fb9e8-8bab-4733-9d58-c9bc07e2bb47/follow-up',
      'agent',
    ],
  ])('classifies %s as %s', (url, family) => {
    expect(classifyCoveoRequest(url)).toBe(family);
  });

  it('excludes unrelated and malformed URLs', () => {
    expect(classifyCoveoRequest('https://example.com/rest/search/v2')).toBeNull();
    expect(classifyCoveoRequest('https://static.cloud.coveo.com/searchui/widget.js')).toBeNull();
    expect(classifyCoveoRequest('not a url')).toBeNull();
  });

  it.each([
    'https://docs.coveo.com/en/assets/js/atomic/coveo.analytics.js',
    'https://docs.coveo.com/en/assets/js/recommendations.mjs',
    'https://acme.org.coveo.com/rest/search/v2/index.js.map',
    'https://static.cloud.coveo.com/atomic/v3/themes/coveo.css',
  ])('ignores the static asset %s', (url) => {
    expect(classifyCoveoRequest(url)).toBeNull();
  });
});

describe('HAR adaptation', () => {
  it('redacts sensitive display headers but preserves a private replay envelope', () => {
    const adapted = adaptHarEntry({
      startedDateTime: '2026-09-03T12:00:00.000Z',
      time: 42,
      request: {
        method: 'POST',
        url: 'https://acme.org.coveo.com/rest/search/v2?organizationId=acme',
        headers: [
          { name: 'Authorization', value: 'Bearer secret' },
          { name: 'Content-Type', value: 'application/json' },
        ],
        postData: { text: JSON.stringify({ q: 'power supply', pipeline: 'support' }) },
      },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [{ name: 'Set-Cookie', value: 'session=secret' }],
        content: { mimeType: 'application/json' },
      },
    });

    expect(adapted?.exchange).toMatchObject({
      family: 'search',
      query: 'power supply',
      pipeline: 'support',
      status: 200,
      responseBodyState: 'pending',
    });
    expect(adapted?.exchange.requestHeaders[0].value).toBe('***redacted***');
    expect(adapted?.exchange.responseHeaders[0].value).toBe('***redacted***');
    expect(adapted?.replay.headers[0].value).toBe('Bearer secret');
  });

  it('decodes UTF-8 base64 response bodies', () => {
    const original = JSON.stringify({ title: 'Café' });
    const encoded = Buffer.from(original, 'utf8').toString('base64');
    expect(decodeResponseBody(encoded, 'base64')).toBe(original);
  });

  it('reads query and pipeline labels from a form-encoded search body', () => {
    const adapted = adaptHarEntry({
      startedDateTime: '2026-09-04T13:15:25.149Z',
      time: 120,
      request: {
        method: 'POST',
        url: 'https://platform.cloud.coveo.com/rest/search/v2',
        headers: [
          { name: 'Content-Type', value: 'application/x-www-form-urlencoded; charset=UTF-8' },
        ],
        postData: { text: 'q=setting%20up%20a%20scratch%20org&pipeline=Help_Pipeline' },
      },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [],
        content: { mimeType: 'application/json' },
      },
    });

    expect(adapted?.exchange).toMatchObject({
      family: 'search',
      query: 'setting up a scratch org',
      pipeline: 'Help_Pipeline',
    });
  });

  it('redacts credential query params for display but replays the real URL', () => {
    const url = 'https://platform.cloud.coveo.com/rest/search/v2?access_token=jwt.secret.value&isGuestUser=true';
    const adapted = adaptHarEntry({
      startedDateTime: '2026-09-04T13:15:25.149Z',
      time: 120,
      request: {
        method: 'POST',
        url,
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        postData: { text: '{"q":"scratch org"}' },
      },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [],
        content: { mimeType: 'application/json' },
      },
    });

    expect(adapted?.exchange.url).toBe(
      'https://platform.cloud.coveo.com/rest/search/v2?access_token=***redacted***&isGuestUser=true',
    );
    expect(adapted?.replay.url).toBe(url);
  });

  it('leaves URLs without credentials untouched', () => {
    expect(redactUrlCredentials('https://acme.org.coveo.com/rest/search/v2?organizationId=acme')).toBe(
      'https://acme.org.coveo.com/rest/search/v2?organizationId=acme',
    );
    expect(redactUrlCredentials('not a url')).toBe('not a url');
  });
});

describe('analytics event labels', () => {
  it('reads the event class from the endpoint and the type and value from a custom event', () => {
    expect(
      readAnalyticsLabels(
        'https://analytics.cloud.coveo.com/rest/ua/v15/analytics/custom?visitor=abc',
        JSON.stringify({ eventType: 'getMoreResults', eventValue: 'showMore', language: 'en' }),
      ),
    ).toEqual({ eventClass: '/custom', eventType: 'getMoreResults', eventValue: 'showMore' });
  });

  it('falls back to actionCause and queryText for search events', () => {
    expect(
      readAnalyticsLabels(
        'https://analytics.cloud.coveo.com/rest/v15/analytics/search',
        JSON.stringify({ actionCause: 'searchboxSubmit', queryText: 'dl380 firmware' }),
      ),
    ).toEqual({ eventClass: '/search', eventType: 'searchboxSubmit', eventValue: 'dl380 firmware' });
  });

  it('names the event from Event Protocol batches and counts the extras', () => {
    expect(
      readAnalyticsLabels(
        'https://acme.org.coveo.com/rest/organizations/acme/events/v1',
        JSON.stringify([{ meta: { type: 'ec.productClick' } }, { meta: { type: 'Search' } }]),
      ),
    ).toEqual({ eventClass: '/events', eventType: 'ec.productClick (+1 more)', eventValue: null });
  });

  it('keeps the event class when the body cannot be parsed', () => {
    expect(
      readAnalyticsLabels('https://analytics.cloud.coveo.com/rest/v15/analytics/click', 'not json'),
    ).toEqual({ eventClass: '/click', eventType: null, eventValue: null });
  });

  it('labels analytics captures on the exchange', () => {
    const adapted = adaptHarEntry({
      startedDateTime: '2026-09-07T14:49:28.364Z',
      time: 30,
      request: {
        method: 'POST',
        url: 'https://analytics.cloud.coveo.com/rest/v15/analytics/click',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        postData: { text: '{"actionCause":"documentOpen","documentTitle":"DL380 setup"}' },
      },
      response: { status: 200, statusText: 'OK', headers: [], content: { mimeType: 'application/json' } },
    });

    expect(adapted?.exchange.family).toBe('analytics');
    expect(adapted?.exchange.eventClass).toBe('/click');
    expect(adapted?.exchange.eventType).toBe('documentOpen');
    expect(adapted?.exchange.eventValue).toBe('DL380 setup');
  });
});

describe('generative answer streams', () => {
  const rgaFrame = (payloadType: string, payload: unknown, finishReason: string | null = null) =>
    `event:message\ndata:${JSON.stringify({
      payloadType,
      payload: JSON.stringify(payload),
      finishReason,
      errorMessage: null,
      statusCode: null,
    })}\nretry:10000\n`;

  it('reassembles an RGA stream, its header and its citations', () => {
    const body = [
      rgaFrame('genqa.headerMessageType', { answerStyle: 'default', contentFormat: 'text/markdown' }),
      rgaFrame('genqa.messageType', { textDelta: '## Replacing a power supply in', padding: '123' }),
      rgaFrame('genqa.messageType', { textDelta: ' a server\n\nFollow these steps.', padding: '12' }),
      rgaFrame('genqa.citationsType', {
        citations: [
          {
            id: '42.54450$file://doc-1-54:0',
            title: ' Removing and Replacing the Power Supply',
            uri: 'file://doc-1/',
            clickUri: 'file://doc-1/',
            permanentid: '196d3f78468710ff752fd38798424e365de103c2a2179dfb896ffe32e919',
            text: 'Ensure the slot latches are open.',
            source: 'kb-articles',
            fields: { doclocale: 'en_US', docid: 'doc-1' },
          },
        ],
      }),
      rgaFrame('genqa.endOfStreamType', { answerGenerated: true }, 'COMPLETED'),
    ].join('\n');

    const stream = parseAnswerStream(body);

    expect(stream?.kind).toBe('rga');
    expect(stream?.contentFormat).toBe('text/markdown');
    expect(stream?.answerStyle).toBe('default');
    expect(stream?.answer).toBe('## Replacing a power supply in a server\n\nFollow these steps.');
    expect(stream?.answerGenerated).toBe(true);
    expect(stream?.finishReason).toBe('COMPLETED');
    expect(stream?.complete).toBe(true);
    expect(stream?.citations).toHaveLength(1);
    expect(stream?.citations[0]).toMatchObject({
      title: 'Removing and Replacing the Power Supply',
      source: 'kb-articles',
      fields: { docid: 'doc-1', doclocale: 'en_US' },
    });
  });

  it('flags a stream that completed without generating an answer', () => {
    const body = [
      rgaFrame('genqa.messageType', { textDelta: '' }),
      rgaFrame('genqa.endOfStreamType', { answerGenerated: false }, 'COMPLETED'),
    ].join('\n');

    expect(parseAnswerStream(body)?.answerGenerated).toBe(false);
  });

  it('reads agent steps, the rewritten tool query, and citations', () => {
    const frame = (value: unknown) => `data:${JSON.stringify(value)}\n\n`;
    const body = [
      frame({ type: 'STEP_STARTED', timestamp: 1000, stepName: 'Searching' }),
      frame({ type: 'TOOL_CALL_START', timestamp: 1000, toolCallId: 't1', toolCallName: 'search' }),
      frame({ type: 'TOOL_CALL_ARGS', timestamp: 1000, toolCallId: 't1', delta: '{"q":"power supply latches"}' }),
      frame({ type: 'TOOL_CALL_END', timestamp: 1900, toolCallId: 't1' }),
      frame({ type: 'STEP_FINISHED', timestamp: 1900, stepName: 'Searching' }),
      frame({ type: 'TEXT_MESSAGE_CHUNK', timestamp: 2000, delta: '## Step 2' }),
      frame({ type: 'TEXT_MESSAGE_CHUNK', timestamp: 2100, delta: ': Remove the module' }),
      frame({
        type: 'CUSTOM',
        timestamp: 2200,
        name: 'citations',
        value: { citations: [{ id: 'c1', title: 'Power supply', permanentid: 'abc', source: 'kb-articles' }] },
      }),
      frame({ type: 'RUN_FINISHED', timestamp: 2300, result: { completionReason: 'ANSWERED' } }),
    ].join('');

    const stream = parseAnswerStream(body);

    expect(stream?.kind).toBe('agent');
    expect(stream?.answer).toBe('## Step 2: Remove the module');
    expect(stream?.completionReason).toBe('ANSWERED');
    expect(stream?.answerGenerated).toBe(true);
    expect(stream?.steps).toHaveLength(1);
    expect(stream?.steps[0]).toMatchObject({ name: 'Searching', startedAt: 1000, finishedAt: 1900 });
    expect(stream?.steps[0].toolCalls[0]).toEqual({
      name: 'search',
      args: '{"q":"power supply latches"}',
    });
    expect(stream?.citations[0]?.permanentid).toBe('abc');
  });

  it('returns null when the body carries no SSE frames', () => {
    expect(parseAnswerStream('{"results":[]}')).toBeNull();
    expect(parseAnswerStream(null)).toBeNull();
  });

  it('keeps repeated agent step names separate and reads the header frame', () => {
    // Shape taken from a real follow-up run: Thinking and Searching each occur twice.
    const body = [
      'data:{"type":"RUN_STARTED","timestamp":1000,"threadId":"conv_abc","runId":"conv_abc_0002"}',
      '',
      'data:{"type":"CUSTOM","timestamp":1001,"name":"header","value":{"conversationId":"conv_abc","contentFormat":"text/markdown","followUpEnabled":true,"conversationToken":"secret"}}',
      '',
      'data:{"type":"STEP_STARTED","timestamp":1100,"stepName":"Thinking"}',
      '',
      'data:{"type":"STEP_FINISHED","timestamp":1600,"stepName":"Thinking"}',
      '',
      'data:{"type":"STEP_STARTED","timestamp":1700,"stepName":"Searching"}',
      '',
      'data:{"type":"TOOL_CALL_START","timestamp":1700,"toolCallId":"t1","toolCallName":"search"}',
      '',
      'data:{"type":"TOOL_CALL_ARGS","timestamp":1700,"toolCallId":"t1","delta":"{\\"q\\":\\"first rewrite\\"}"}',
      '',
      'data:{"type":"STEP_FINISHED","timestamp":1900,"stepName":"Searching"}',
      '',
      'data:{"type":"STEP_STARTED","timestamp":2000,"stepName":"Thinking"}',
      '',
      ':keepalive',
      '',
      'data:{"type":"STEP_FINISHED","timestamp":17000,"stepName":"Thinking"}',
      '',
      'data:{"type":"STEP_STARTED","timestamp":17100,"stepName":"Searching"}',
      '',
      'data:{"type":"TOOL_CALL_START","timestamp":17100,"toolCallId":"t2","toolCallName":"search"}',
      '',
      'data:{"type":"TOOL_CALL_ARGS","timestamp":17100,"toolCallId":"t2","delta":"{\\"q\\":\\"second rewrite\\"}"}',
      '',
    ].join('\n');

    const stream = parseAnswerStream(body);

    expect(stream?.conversationId).toBe('conv_abc');
    expect(stream?.runId).toBe('conv_abc_0002');
    expect(stream?.contentFormat).toBe('text/markdown');
    expect(stream?.followUpEnabled).toBe(true);
    expect(stream?.steps.map((step) => step.name)).toEqual([
      'Thinking',
      'Searching',
      'Thinking',
      'Searching',
    ]);
    // The second Thinking step must keep its own timings, not merge with the first.
    expect(stream?.steps[2]).toMatchObject({ startedAt: 2000, finishedAt: 17000 });
    expect(stream?.steps[1].toolCalls[0].args).toBe('{"q":"first rewrite"}');
    expect(stream?.steps[3].toolCalls[0].args).toBe('{"q":"second rewrite"}');
    // No RUN_FINISHED: the capture ended while the stream was still open.
    expect(stream?.complete).toBe(false);
    expect(stream?.steps[3].finishedAt).toBeNull();
    expect(stream?.durationMs).toBe(16100);
  });
});

describe('capture log', () => {
  it('deduplicates, caps entries, and respects preserve log on navigation', () => {
    const log = new CaptureLog(2);
    log.add(exchange('one'));
    expect(log.add(exchange('one'))).toBe(false);
    log.add(exchange('two'));
    log.add(exchange('three'));
    expect(log.getSnapshot().exchanges.map(({ id }) => id)).toEqual(['two', 'three']);

    log.setPreserveLog(true);
    expect(log.handleNavigation()).toBe(false);
    expect(log.getSnapshot().exchanges).toHaveLength(2);
    log.setPreserveLog(false);
    expect(log.handleNavigation()).toBe(true);
    expect(log.getSnapshot().exchanges).toHaveLength(0);
  });
});

describe('Search debug replay', () => {
  it('sets debug in JSON while preserving authorization and dropping browser-controlled headers', () => {
    const replay = buildDebugReplay({
      method: 'POST',
      url: 'https://acme.org.coveo.com/rest/search/v2',
      family: 'search',
      body: JSON.stringify({ q: 'power supply', debug: false }),
      headers: [
        { name: 'Authorization', value: 'Bearer secret' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Cookie', value: 'session=secret' },
        { name: 'Origin', value: 'https://support.example.com' },
        { name: 'Sec-Fetch-Mode', value: 'cors' },
      ],
    });

    expect(JSON.parse(replay.body)).toEqual({ q: 'power supply', debug: true });
    expect(replay.headers.Authorization).toBe('Bearer secret');
    expect(replay.headers.Cookie).toBeUndefined();
    expect(replay.headers.Origin).toBeUndefined();
    expect(replay.headers['Sec-Fetch-Mode']).toBeUndefined();
  });

  it('rejects replay for non-search requests', () => {
    const envelope: ReplayEnvelope = {
      method: 'POST',
      url: 'https://analytics.cloud.coveo.com/rest/ua',
      family: 'analytics',
      headers: [],
      body: '{}',
    };
    expect(() => buildDebugReplay(envelope)).toThrow('Only Search requests');
  });

  it('sets debug in a form-encoded body without converting it to JSON', () => {
    const replay = buildDebugReplay({
      method: 'POST',
      url: 'https://platform.cloud.coveo.com/rest/search/v2',
      family: 'search',
      body: 'q=setting%20up%20a%20scratch%20org&searchHub=Community&debug=false',
      headers: [
        { name: 'Content-Type', value: 'application/x-www-form-urlencoded; charset=UTF-8' },
      ],
    });

    const params = new URLSearchParams(replay.body);
    expect(params.get('debug')).toBe('true');
    expect(params.get('q')).toBe('setting up a scratch org');
    expect(params.get('searchHub')).toBe('Community');
    expect(replay.headers['Content-Type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
  });

  it('consumes the response body in the inspected-page expression', async () => {
    const replay = {
      method: 'POST',
      url: 'https://acme.org.coveo.com/rest/search/v2',
      headers: { 'Content-Type': 'application/json' },
      body: '{"debug":true}',
    };
    const replayToken = 'test-replay-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{"results":[]}'),
    }));
    vi.stubGlobal('__COVEO_DEBUG_REPLAY_RESULTS__', undefined);

    const execute = <Result>(expression: string): Result =>
      Function(`return ${expression}`)() as Result;
    expect(execute(createReplayExpression(replay, replayToken))).toEqual({ launched: true });
    await vi.waitFor(() => {
      expect((globalThis as typeof globalThis & {
        __COVEO_DEBUG_REPLAY_RESULTS__: Record<string, { done: boolean }>;
      }).__COVEO_DEBUG_REPLAY_RESULTS__[replayToken].done).toBe(true);
    });

    expect(execute(createReadReplayResultExpression(replayToken))).toEqual({
      done: true,
      ok: true,
      status: 200,
      body: '{"results":[]}',
    });
  });
});

describe('DevTools capture controller', () => {
  it('keeps a live response body when a metadata-only HAR backfill arrives later', () => {
    let finishedListener: ((request: chrome.devtools.network.Request) => void) | undefined;
    let contentCallback: ((content: string, encoding: string) => void) | undefined;
    let harCallback: ((har: { entries: HarEntryLike[] }) => void) | undefined;
    const entry = controllerEntry('2026-09-03T12:00:00.000Z', '{"q":"power"}', (callback) => {
      contentCallback = callback;
    });

    vi.stubGlobal('chrome', {
      devtools: {
        network: {
          onRequestFinished: { addListener: (listener: typeof finishedListener) => (finishedListener = listener) },
          onNavigated: { addListener: vi.fn() },
          getHAR: (callback: typeof harCallback) => (harCallback = callback),
        },
        inspectedWindow: { eval: vi.fn() },
      },
    });

    const controller = new CaptureController();
    controller.start();
    finishedListener?.(entry as unknown as chrome.devtools.network.Request);
    contentCallback?.('{"results":[]}', '');
    harCallback?.({ entries: [entry] });

    expect(controller.bridge.getSnapshot().exchanges[0]).toMatchObject({
      responseBody: '{"results":[]}',
      responseBodyState: 'ready',
    });
  });

  it('labels a captured debug replay and recovers its response body', async () => {
    let finishedListener: ((request: chrome.devtools.network.Request) => void) | undefined;
    const evalCallbacks: Array<
      (
          result: { launched?: boolean; done?: boolean; body?: string; error?: string },
          exceptionInfo?: chrome.devtools.inspectedWindow.EvaluationExceptionInfo,
        ) => void
    > = [];
    vi.stubGlobal('chrome', {
      devtools: {
        network: {
          onRequestFinished: { addListener: (listener: typeof finishedListener) => (finishedListener = listener) },
          onNavigated: { addListener: vi.fn() },
          getHAR: vi.fn(),
        },
        inspectedWindow: {
          eval: (
            expression: string,
            callback: (typeof evalCallbacks)[number],
          ) => {
            if (expression === createInterceptorProbeExpression()) {
              return (callback as (result: unknown) => void)(NO_INTERCEPTORS);
            }
            evalCallbacks.push(callback);
          },
        },
      },
    });

    const controller = new CaptureController();
    controller.start();
    const original = controllerEntry(
      '2026-09-03T12:00:00.000Z',
      '{"q":"power","debug":false}',
      () => undefined,
    );
    finishedListener?.(original as unknown as chrome.devtools.network.Request);
    const originalId = controller.bridge.getSnapshot().exchanges[0].id;

    const replayPromise = controller.bridge.replay(originalId);
    evalCallbacks.shift()?.({ launched: true });
    const replay = controllerEntry(
      '2026-09-03T12:00:01.000Z',
      '{"q":"power","debug":true}',
      (callback) => callback('', ''),
    );
    finishedListener?.(replay as unknown as chrome.devtools.network.Request);
    evalCallbacks.shift()?.({ done: true, body: '{"results":[{"title":"Recovered"}]}' });
    await replayPromise;

    expect(controller.bridge.getSnapshot().exchanges[1]).toMatchObject({
      replayOf: originalId,
      responseBody: '{"results":[{"title":"Recovered"}]}',
      responseBodyState: 'ready',
      bodyError: null,
    });
  });

  it('rejects the replay when the page fetch fails', async () => {
    const evalCallbacks: Array<(result: { launched?: boolean; done?: boolean; error?: string }) => void> = [];
    vi.stubGlobal('chrome', {
      devtools: {
        network: {
          onRequestFinished: { addListener: vi.fn() },
          onNavigated: { addListener: vi.fn() },
          getHAR: (callback: (har: { entries: HarEntryLike[] }) => void) =>
            callback({
              entries: [
                controllerEntry('2026-09-03T12:00:00.000Z', '{"q":"power"}', () => undefined),
              ],
            }),
        },
        inspectedWindow: {
          eval: (expression: string, callback: (typeof evalCallbacks)[number]) => {
            if (expression === createInterceptorProbeExpression()) {
              return (callback as (result: unknown) => void)(NO_INTERCEPTORS);
            }
            evalCallbacks.push(callback);
          },
        },
      },
    });

    const controller = new CaptureController();
    controller.start();
    const originalId = controller.bridge.getSnapshot().exchanges[0].id;

    const replayPromise = controller.bridge.replay(originalId);
    evalCallbacks.shift()?.({ launched: true });
    evalCallbacks.shift()?.({ done: true, error: 'Failed to fetch' });

    await expect(replayPromise).rejects.toThrow('Failed to fetch');
  });

  it('reports a page whose fetch has been replaced by an interceptor', () => {
    vi.stubGlobal('chrome', {
      devtools: {
        network: {
          onRequestFinished: { addListener: vi.fn() },
          onNavigated: { addListener: vi.fn() },
          getHAR: vi.fn(),
        },
        inspectedWindow: {
          eval: (
            expression: string,
            callback: (result: { fetchWrapped: boolean; xhrWrapped: boolean }) => void,
          ) => {
            if (expression === createInterceptorProbeExpression()) {
              callback({ fetchWrapped: true, xhrWrapped: false });
            }
          },
        },
      },
    });

    const controller = new CaptureController();
    controller.start();

    expect(controller.bridge.getSnapshot().interceptors).toEqual({
      fetchWrapped: true,
      xhrWrapped: false,
    });
  });
});

describe('interceptor reporting', () => {
  it('names the replaced globals', () => {
    expect(describeInterceptors({ fetchWrapped: true, xhrWrapped: false })).toBe(
      'window.fetch has been replaced on this page',
    );
    expect(describeInterceptors({ fetchWrapped: true, xhrWrapped: true })).toBe(
      'window.fetch and XMLHttpRequest have been replaced on this page',
    );
  });

  it('stays silent when nothing is wrapped', () => {
    expect(describeInterceptors(NO_INTERCEPTORS)).toBeNull();
    expect(describeInterceptors(undefined)).toBeNull();
  });

  it('detects a wrapped fetch when the probe runs against a page scope', () => {
    const probe = (scope: unknown) =>
      new Function('globalThis', `return (${createInterceptorProbeExpression()})`)(scope) as {
        fetchWrapped: boolean;
      };

    // Node's own fetch is not native code, so a genuinely native function stands in for it.
    expect(probe({ fetch: Math.max }).fetchWrapped).toBe(false);
    expect(probe({ fetch: () => Promise.resolve() }).fetchWrapped).toBe(true);
  });
});

function exchange(id: string): CapturedExchange {
  return {
    id,
    startedAt: '2026-09-03T12:00:00.000Z',
    durationMs: 1,
    method: 'POST',
    url: `https://acme.org.coveo.com/rest/search/v2?id=${id}`,
    family: 'search',
    status: 200,
    statusText: 'OK',
    requestHeaders: [],
    responseHeaders: [],
    requestBody: '{}',
    responseBody: null,
    responseBodyState: 'pending',
    responseMimeType: 'application/json',
    bodyError: null,
    query: null,
    pipeline: null,
    eventClass: null,
    eventType: null,
    eventValue: null,
    replayOf: null,
  };
}

function controllerEntry(
  startedDateTime: string,
  body: string,
  getContent: (callback: (content: string, encoding: string) => void) => void,
): HarEntryLike & { getContent: typeof getContent } {
  return {
    startedDateTime,
    time: 15,
    request: {
      method: 'POST',
      url: 'https://acme.org.coveo.com/rest/search/v2',
      headers: [
        { name: 'Authorization', value: 'Bearer secret' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      postData: { text: body },
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [],
      content: { mimeType: 'application/json' },
    },
    getContent,
  };
}