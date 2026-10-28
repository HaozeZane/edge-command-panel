import { describe, it, expect } from 'vitest';
import {
  formatLatency,
  formatBytes,
  formatDuration,
  formatRelativeTime,
} from './format';

describe('Format utilities', () => {
  it('formatLatency handles fresh latency within 90s', () => {
    const now = Date.now();
    const good = formatLatency(45, now - 5000);
    expect(good.status).toBe('good');
    expect(good.text).toContain('45 ms');

    const medium = formatLatency(180, now - 10000);
    expect(medium.status).toBe('medium');
    expect(medium.text).toContain('180 ms');

    const slow = formatLatency(520, now - 10000);
    expect(slow.status).toBe('slow');
    expect(slow.text).toContain('520 ms');
  });

  it('formatLatency handles expired latency (> 90s)', () => {
    const now = Date.now();
    const expired = formatLatency(50, now - 100_000);
    expect(expired.status).toBe('unknown');
    expect(expired.text).toContain('已过期');
  });

  it('formatLatency handles undefined or null values', () => {
    expect(formatLatency(undefined, undefined).status).toBe('unknown');
    expect(formatLatency(undefined, Date.now()).status).toBe('unknown');
    expect(formatLatency(50, undefined).status).toBe('unknown');
  });

  it('formatBytes formats properly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024 * 50)).toBe('50.0 KB');
    expect(formatBytes(1024 * 1024 * 12.5)).toBe('12.5 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.25)).toBe('2.25 GB');
  });

  it('formatRelativeTime calculates elapsed relative string', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 3000)).toBe('刚刚');
    expect(formatRelativeTime(now - 15000)).toBe('15 秒前');
  });

  it('formatDuration calculates elapsed time', () => {
    expect(formatDuration(1000, 1500)).toBe('500 ms');
    expect(formatDuration(1000, 3500)).toBe('2.5 s');
  });
});
