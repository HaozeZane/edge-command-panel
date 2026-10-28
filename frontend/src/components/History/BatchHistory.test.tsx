// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Batch, BrowserFrame, Run } from '../../types/protocol';
import { api } from '../../api/client';
import { BatchHistory } from './BatchHistory';

vi.mock('../../api/client', () => ({
  api: {
    getBatches: vi.fn(),
    getBatchDetail: vi.fn(),
    getRunEvents: vi.fn(),
  },
}));

const getBatches = vi.mocked(api.getBatches);
const getBatchDetail = vi.mocked(api.getBatchDetail);
const getRunEvents = vi.mocked(api.getRunEvents);

const batch: Batch = {
  id: 'history-batch',
  requestId: 'req-history',
  command: 'df -h',
  timeoutSec: 60,
  createdAt: 1_700_000_000_000,
};

const runs: Run[] = [
  {
    id: 'history-run',
    batchId: batch.id,
    agentId: 'agent-history',
    agentName: 'agent-history',
    status: 'succeeded',
    lastSeq: 0,
    exitCode: 0,
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_010_000,
  },
];

describe('BatchHistory live sync', () => {
  let container: HTMLDivElement;
  let root: Root;

  const settle = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const renderHistory = async (props: {
    wsFrame?: BrowserFrame | null;
    wsFrameId?: number;
    wsGeneration?: number;
  }) => {
    await act(async () => {
      root.render(
        <BatchHistory
          initialBatchId={batch.id}
          onError={() => {}}
          lastWsFrame={props.wsFrame ?? null}
          wsFrameId={props.wsFrameId ?? 0}
          wsGeneration={props.wsGeneration ?? 0}
        />,
      );
    });
    await settle();
    await settle();
  };

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getBatches.mockReset();
    getBatchDetail.mockReset();
    getRunEvents.mockReset();
    getBatches.mockResolvedValue({ batches: [batch], nextCursor: null });
    getBatchDetail.mockResolvedValue({ batch, runs });
    getRunEvents.mockResolvedValue({ events: [], nextSeq: 1, hasMore: false });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('backfills the selected batch snapshot on WS generation changes', async () => {
    await renderHistory({ wsGeneration: 0 });
    const before = getBatchDetail.mock.calls.length;
    expect(before).toBe(1);

    await renderHistory({ wsGeneration: 1 });
    expect(getBatchDetail.mock.calls.length).toBe(before + 1);
  });

  it('handles each notification id once instead of refetching in a loop', async () => {
    await renderHistory({ wsGeneration: 0 });
    const before = getBatchDetail.mock.calls.length;

    const frame: BrowserFrame = {
      v: 1,
      type: 'changed',
      batchId: batch.id,
      runId: runs[0].id,
    };

    await renderHistory({ wsFrame: frame, wsFrameId: 1, wsGeneration: 0 });
    await settle(250);
    const afterNotification = getBatchDetail.mock.calls.length;
    expect(afterNotification).toBe(before + 1);

    // Same frame id delivered again must be ignored.
    await renderHistory({ wsFrame: frame, wsFrameId: 1, wsGeneration: 0 });
    await settle(250);
    expect(getBatchDetail.mock.calls.length).toBe(afterNotification);
  });
});
