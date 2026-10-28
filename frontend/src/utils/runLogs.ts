import type { EventStream, RunEvent } from '../types/protocol';
import { StreamLogDecoder } from './base64';

export type LogFilter = 'all' | EventStream;

export interface LogChunk {
  seq: number;
  stream: EventStream;
  text: string;
}

/**
 * Per-run event cache.
 *
 * A run has one globally increasing seq space, but stdout and stderr are
 * independent byte streams. Each stream therefore needs its own streaming
 * UTF-8 decoder; sharing one decoder corrupts characters whenever a chunk
 * from one stream is split across WS/HTTP fetches.
 */
export interface RunLogCache {
  runId: string;
  chunks: LogChunk[];
  seqSet: Set<number>;
  lastSeq: number;
  decoders: Record<EventStream, StreamLogDecoder>;
  flushed: Record<EventStream, boolean>;
  hasTruncated: boolean;
  isFetching: boolean;
  error: string | null;
  lastErrorAt: number;
  abort: AbortController | null;
}

export function createRunLogCache(runId: string): RunLogCache {
  return {
    runId,
    chunks: [],
    seqSet: new Set<number>(),
    lastSeq: 0,
    decoders: {
      stdout: new StreamLogDecoder(),
      stderr: new StreamLogDecoder(),
    },
    flushed: {
      stdout: false,
      stderr: false,
    },
    hasTruncated: false,
    isFetching: false,
    error: null,
    lastErrorAt: 0,
    abort: null,
  };
}

function pushChunk(cache: RunLogCache, seq: number, stream: EventStream, text: string): void {
  if (!text) return;
  cache.chunks.push({ seq, stream, text });
}

/**
 * Merge one event into the cache. Returns false for duplicate seq values
 * (for example when a reconnect snapshot and a WS notification overlap).
 */
export function appendEventToCache(cache: RunLogCache, ev: RunEvent): boolean {
  if (cache.seqSet.has(ev.seq)) return false;
  cache.seqSet.add(ev.seq);
  if (ev.seq > cache.lastSeq) cache.lastSeq = ev.seq;

  if (ev.outputTruncated) cache.hasTruncated = true;

  if (ev.kind === 'output' && ev.dataBase64) {
    const stream: EventStream = ev.stream === 'stderr' ? 'stderr' : 'stdout';
    pushChunk(cache, ev.seq, stream, cache.decoders[stream].decodeChunk(ev.dataBase64));
  } else if (ev.kind === 'finished') {
    flushCache(cache, ev.seq);
  }

  return true;
}

/**
 * Flush any incomplete UTF-8 bytes held by either stream. This must happen for
 * BOTH streams when a run reaches a terminal state, otherwise a dangling
 * multibyte character can be silently lost.
 */
export function flushCache(cache: RunLogCache, seq: number): void {
  for (const stream of ['stdout', 'stderr'] as const) {
    if (cache.flushed[stream]) continue;
    cache.flushed[stream] = true;
    pushChunk(cache, seq, stream, cache.decoders[stream].flush());
  }
}

export function getVisibleChunks(cache: RunLogCache | null, filter: LogFilter = 'all'): LogChunk[] {
  if (!cache) return [];
  // Always return a fresh array: caches are mutated in place, and React memo
  // comparisons rely on the rendered chunk array identity.
  return filter === 'all' ? cache.chunks.slice() : cache.chunks.filter((c) => c.stream === filter);
}

export function getLogText(cache: RunLogCache | null, filter: LogFilter = 'all'): string {
  return getVisibleChunks(cache, filter)
    .map((c) => c.text)
    .join('');
}

export function hasStreamOutput(cache: RunLogCache | null, stream: EventStream): boolean {
  return !!cache && cache.chunks.some((c) => c.stream === stream && c.text.length > 0);
}
