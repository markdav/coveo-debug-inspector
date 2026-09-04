export interface AnswerCitation {
  id: string | null;
  title: string | null;
  uri: string | null;
  clickUri: string | null;
  permanentid: string | null;
  source: string | null;
  filetype: string | null;
  text: string | null;
  fields: Record<string, unknown>;
}

export interface AnswerToolCall {
  name: string;
  args: string;
}

export interface AnswerStep {
  name: string;
  startedAt: number | null;
  finishedAt: number | null;
  toolCalls: AnswerToolCall[];
}

export interface ParsedAnswerStream {
  kind: 'rga' | 'agent';
  contentFormat: string | null;
  answerStyle: string | null;
  answer: string;
  citations: AnswerCitation[];
  answerGenerated: boolean | null;
  finishReason: string | null;
  completionReason: string | null;
  error: string | null;
  steps: AnswerStep[];
  frameCount: number;
  /** False when the capture ends before the terminating frame. */
  complete: boolean;
  conversationId: string | null;
  runId: string | null;
  followUpEnabled: boolean | null;
  /** Wall-clock time from the run's first frame to its last, when timestamped. */
  durationMs: number | null;
}

/** Frames arrive as `data:{...}`; the space after the colon is optional. */
function readSseFrames(body: string): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    const frame = asRecord(raw);
    if (frame) frames.push(frame);
  }
  return frames;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toCitations(value: unknown): AnswerCitation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      id: str(entry.id),
      title: str(entry.title)?.trim() ?? null,
      uri: str(entry.uri),
      clickUri: str(entry.clickUri),
      permanentid: str(entry.permanentid),
      source: str(entry.source),
      filetype: str(entry.filetype),
      text: str(entry.text),
      fields: (asRecord(entry.fields) ?? {}) as Record<string, unknown>,
    }));
}

export function parseAnswerStream(body: string | null): ParsedAnswerStream | null {
  if (!body) return null;
  const frames = readSseFrames(body);
  if (frames.length === 0) return null;

  const isAgent = frames.some((frame) => typeof frame.type === 'string');
  const parsed: ParsedAnswerStream = {
    kind: isAgent ? 'agent' : 'rga',
    contentFormat: null,
    answerStyle: null,
    answer: '',
    citations: [],
    answerGenerated: null,
    finishReason: null,
    completionReason: null,
    error: null,
    steps: [],
    frameCount: frames.length,
    complete: false,
    conversationId: null,
    runId: null,
    followUpEnabled: null,
    durationMs: null,
  };

  return isAgent ? readAgentFrames(frames, parsed) : readGenqaFrames(frames, parsed);
}

function readGenqaFrames(
  frames: Record<string, unknown>[],
  parsed: ParsedAnswerStream,
): ParsedAnswerStream {
  for (const frame of frames) {
    const errorMessage = str(frame.errorMessage);
    if (errorMessage) parsed.error = errorMessage;
    const finishReason = str(frame.finishReason);
    if (finishReason) parsed.finishReason = finishReason;

    const payload = asRecord(frame.payload);
    if (!payload) continue;

    switch (frame.payloadType) {
      case 'genqa.headerMessageType':
        parsed.contentFormat = str(payload.contentFormat);
        parsed.answerStyle = str(payload.answerStyle);
        break;
      case 'genqa.messageType':
        parsed.answer += str(payload.textDelta) ?? '';
        break;
      case 'genqa.citationsType':
        parsed.citations = toCitations(payload.citations);
        break;
      case 'genqa.endOfStreamType':
        parsed.answerGenerated = payload.answerGenerated === true;
        parsed.complete = true;
        break;
    }
  }
  return parsed;
}

function readAgentFrames(
  frames: Record<string, unknown>[],
  parsed: ParsedAnswerStream,
): ParsedAnswerStream {
  const toolCalls = new Map<string, AnswerToolCall>();
  let openStep: AnswerStep | null = null;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const frame of frames) {
    const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : null;
    if (timestamp != null) {
      firstTimestamp = firstTimestamp ?? timestamp;
      lastTimestamp = timestamp;
    }
    switch (frame.type) {
      case 'RUN_STARTED':
        parsed.conversationId = str(frame.threadId);
        parsed.runId = str(frame.runId);
        break;
      case 'STEP_STARTED': {
        // A step name can repeat within a run, so steps are kept in sequence.
        const step: AnswerStep = {
          name: str(frame.stepName) ?? 'Step',
          startedAt: timestamp,
          finishedAt: null,
          toolCalls: [],
        };
        parsed.steps.push(step);
        openStep = step;
        break;
      }
      case 'STEP_FINISHED': {
        const name = str(frame.stepName);
        for (let index = parsed.steps.length - 1; index >= 0; index--) {
          const step = parsed.steps[index];
          if (step.name === name && step.finishedAt == null) {
            step.finishedAt = timestamp;
            break;
          }
        }
        break;
      }
      case 'TOOL_CALL_START': {
        const id = str(frame.toolCallId);
        if (!id) break;
        const call: AnswerToolCall = { name: str(frame.toolCallName) ?? 'tool', args: '' };
        toolCalls.set(id, call);
        (openStep ?? parsed.steps[parsed.steps.length - 1])?.toolCalls.push(call);
        break;
      }
      case 'TOOL_CALL_ARGS': {
        const call = toolCalls.get(str(frame.toolCallId) ?? '');
        if (call) call.args += str(frame.delta) ?? '';
        break;
      }
      case 'TEXT_MESSAGE_CHUNK':
        parsed.answer += str(frame.delta) ?? '';
        break;
      case 'CUSTOM': {
        const value = asRecord(frame.value);
        if (!value) break;
        if (frame.name === 'citations') {
          parsed.citations = toCitations(value.citations);
        } else if (frame.name === 'header') {
          parsed.contentFormat = str(value.contentFormat) ?? parsed.contentFormat;
          parsed.conversationId = str(value.conversationId) ?? parsed.conversationId;
          parsed.followUpEnabled =
            typeof value.followUpEnabled === 'boolean' ? value.followUpEnabled : null;
        }
        break;
      }
      case 'RUN_FINISHED': {
        const reason = str(asRecord(frame.result)?.completionReason);
        parsed.completionReason = reason;
        parsed.answerGenerated = reason === 'ANSWERED';
        parsed.complete = true;
        break;
      }
      case 'RUN_ERROR':
        parsed.error = str(frame.message) ?? 'Agent run failed.';
        parsed.complete = true;
        break;
    }
  }
  if (firstTimestamp != null && lastTimestamp != null) {
    parsed.durationMs = lastTimestamp - firstTimestamp;
  }
  return parsed;
}
