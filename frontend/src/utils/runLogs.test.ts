import { describe, it, expect } from 'vitest';
import type { EventStream, RunEvent } from '../types/protocol';
import {
  appendEventToCache,
  createRunLogCache,
  getLogText,
  getVisibleChunks,
} from './runLogs';

const RUN_ID = 'run-test';

function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function outputEvent(seq: number, stream: EventStream, bytes: Uint8Array): RunEvent {
  return {
    v: 1,
    type: 'event',
    runId: RUN_ID,
    seq,
    kind: 'output',
    stream,
    dataBase64: base64Bytes(bytes),
  };
}

function finishedEvent(seq: number): RunEvent {
  return {
    v: 1,
    type: 'event',
    runId: RUN_ID,
    seq,
    kind: 'finished',
    status: 'succeeded',
    exitCode: 0,
  };
}

describe('run log cache', () => {
  it('keeps stdout and stderr decoders independent across interleaved UTF-8 chunks', () => {
    const stdoutText = 'stdout: 你好，世界 🚀\n';
    const stderrText = 'stderr: 错误 ⚠️\n';
    const stdoutBytes = new TextEncoder().encode(stdoutText);
    const stderrBytes = new TextEncoder().encode(stderrText);

    // Split inside the first multibyte character of each stream.
    const stdoutSplit = 10;
    const stderrSplit = 10;

    const cache = createRunLogCache(RUN_ID);
    appendEventToCache(cache, outputEvent(1, 'stdout', stdoutBytes.subarray(0, stdoutSplit)));
    appendEventToCache(cache, outputEvent(2, 'stderr', stderrBytes.subarray(0, stderrSplit)));
    appendEventToCache(cache, outputEvent(3, 'stdout', stdoutBytes.subarray(stdoutSplit)));
    appendEventToCache(cache, outputEvent(4, 'stderr', stderrBytes.subarray(stderrSplit)));
    appendEventToCache(cache, finishedEvent(5));

    expect(getLogText(cache, 'stdout')).toBe(stdoutText);
    expect(getLogText(cache, 'stderr')).toBe(stderrText);
    expect(cache.hasTruncated).toBe(false);
    expect(cache.flushed.stdout).toBe(true);
    expect(cache.flushed.stderr).toBe(true);

    const stdoutChunks = getVisibleChunks(cache, 'stdout');
    const stderrChunks = getVisibleChunks(cache, 'stderr');
    expect(stdoutChunks.every((c) => c.stream === 'stdout')).toBe(true);
    expect(stderrChunks.every((c) => c.stream === 'stderr')).toBe(true);
    expect(getVisibleChunks(cache, 'all').length).toBe(
      stdoutChunks.length + stderrChunks.length,
    );
  });

  it('ignores duplicate seq events so snapshot and WS backfill cannot double output', () => {
    const cache = createRunLogCache(RUN_ID);
    const event = outputEvent(1, 'stdout', new TextEncoder().encode('once'));

    expect(appendEventToCache(cache, event)).toBe(true);
    expect(appendEventToCache(cache, event)).toBe(false);
    expect(getLogText(cache, 'all')).toBe('once');
    expect(cache.lastSeq).toBe(1);
  });

  it('records truncation without inventing a specific 1MB reason', () => {
    const cache = createRunLogCache(RUN_ID);
    const event: RunEvent = {
      ...outputEvent(1, 'stdout', new TextEncoder().encode('partial')),
      outputTruncated: true,
    };
    appendEventToCache(cache, event);
    expect(cache.hasTruncated).toBe(true);
  });
});
