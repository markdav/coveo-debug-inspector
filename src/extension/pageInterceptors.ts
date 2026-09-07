export interface InterceptorReport {
  fetchWrapped: boolean;
  xhrWrapped: boolean;
}

export const NO_INTERCEPTORS: InterceptorReport = { fetchWrapped: false, xhrWrapped: false };

export function createInterceptorProbeExpression(): string {
  return `(${probeInterceptors.toString()})()`;
}

export function describeInterceptors(report: InterceptorReport | undefined): string | null {
  if (!report) return null;
  const wrapped = [
    report.fetchWrapped ? 'window.fetch' : null,
    report.xhrWrapped ? 'XMLHttpRequest' : null,
  ].filter(Boolean);
  if (wrapped.length === 0) return null;
  return `${wrapped.join(' and ')} ${wrapped.length > 1 ? 'have' : 'has'} been replaced on this page.`;
}

// Interceptor extensions can serve a wrapped request from their own worker, so DevTools never sees it.
function probeInterceptors(): InterceptorReport {
  const isNative = (value: unknown): boolean => {
    try {
      return Function.prototype.toString.call(value).includes('[native code]');
    } catch {
      return true;
    }
  };
  const scope = globalThis as {
    fetch?: unknown;
    XMLHttpRequest?: { prototype?: { open?: unknown } };
  };
  const xhrOpen = scope.XMLHttpRequest?.prototype?.open;
  return {
    fetchWrapped: typeof scope.fetch === 'function' && !isNative(scope.fetch),
    xhrWrapped: typeof xhrOpen === 'function' && !isNative(xhrOpen),
  };
}
