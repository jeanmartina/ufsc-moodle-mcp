import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  publicBaseUrl?: string;
}

export interface OperationMetrics {
  durationMs: number;
  moodleApiCalls: number;
  fileDownloads: number;
  cacheHits: number;
}

interface MutableMetricsStore {
  startedAtMs: number;
  moodleApiCalls: number;
  fileDownloads: number;
  cacheHits: number;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();
const metricsStorage = new AsyncLocalStorage<MutableMetricsStore>();

export function getEffectivePublicBaseUrl(configuredBaseUrl?: string): string | undefined {
  if (configuredBaseUrl && configuredBaseUrl.trim()) {
    return configuredBaseUrl.trim().replace(/\/+$/, '');
  }
  const ctx = requestContextStorage.getStore();
  if (ctx?.publicBaseUrl) {
    return ctx.publicBaseUrl.replace(/\/+$/, '');
  }
  return undefined;
}

export function recordMoodleApiCall(count = 1): void {
  const store = metricsStorage.getStore();
  if (store) {
    store.moodleApiCalls += count;
  }
}

export function recordFileDownload(count = 1): void {
  const store = metricsStorage.getStore();
  if (store) {
    store.fileDownloads += count;
  }
}

export function recordCacheHit(count = 1): void {
  const store = metricsStorage.getStore();
  if (store) {
    store.cacheHits += count;
  }
}

export async function withOperationMetrics<T>(
  fn: () => Promise<T>
): Promise<{ result: T; metrics: OperationMetrics }> {
  const store: MutableMetricsStore = {
    startedAtMs: performance.now(),
    moodleApiCalls: 0,
    fileDownloads: 0,
    cacheHits: 0,
  };
  const result = await metricsStorage.run(store, fn);
  const durationMs = Math.max(0, Math.round(performance.now() - store.startedAtMs));
  return {
    result,
    metrics: {
      durationMs,
      moodleApiCalls: store.moodleApiCalls,
      fileDownloads: store.fileDownloads,
      cacheHits: store.cacheHits,
    },
  };
}
