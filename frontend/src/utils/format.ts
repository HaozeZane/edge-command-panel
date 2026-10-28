/**
 * Formatting helpers for UI representation
 */

export function formatTimestamp(timestampMs?: number): string {
  if (!timestampMs) return '-';
  const d = new Date(timestampMs);
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatRelativeTime(timestampMs?: number): string {
  if (!timestampMs) return '未知';
  const diffSec = Math.floor((Date.now() - timestampMs) / 1000);
  if (diffSec < 0) return '刚刚';
  if (diffSec < 10) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}

export function formatLatency(
  latencyMs?: number,
  measuredAt?: number,
  expiryMs = 90_000,
): { text: string; status: 'good' | 'medium' | 'slow' | 'unknown' } {
  if (latencyMs === undefined || latencyMs === null || !measuredAt) {
    return { text: '未知', status: 'unknown' };
  }

  // Check if expired
  if (Date.now() - measuredAt > expiryMs) {
    return { text: '未知 (已过期)', status: 'unknown' };
  }

  const relative = formatRelativeTime(measuredAt);
  const text = `${Math.round(latencyMs)} ms (${relative})`;

  if (latencyMs < 100) {
    return { text, status: 'good' };
  } else if (latencyMs < 300) {
    return { text, status: 'medium' };
  } else {
    return { text, status: 'slow' };
  }
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function formatDuration(startMs?: number, finishMs?: number): string {
  if (!startMs) return '-';
  const end = finishMs || Date.now();
  const ms = Math.max(0, end - startMs);
  if (ms < 1000) return `${ms} ms`;
  const sec = (ms / 1000).toFixed(1);
  return `${sec} s`;
}
