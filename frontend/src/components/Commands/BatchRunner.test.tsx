// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Agent, Batch, BrowserFrame, EventsResponse, Run, RunEvent } from '../../types/protocol';
import { api } from '../../api/client';
import { BatchRunner } from './BatchRunner';

vi.mock('../../api/client', () => ({
  api: {
    getBatchDetail: vi.fn(),
    getRunEvents: vi.fn(),
    createBatch: vi.fn(),
  },
}));

const getBatchDetail = vi.mocked(api.getBatchDetail);
const getRunEvents = vi.mocked(api.getRunEvents);
const createBatch = vi.mocked(api.createBatch);

const batch: Batch = {
  id: 'batch-1',
  requestId: 'req-1',
  command: 'uname -a',
  timeoutSec: 300,
  createdAt: 1_700_000_000_000,
};

const agent: Agent = {
  id: 'agent-1',
  name: 'agent-1',
  groupIds: [],
  disabled: false,
  online: true,
  createdAt: 1_700_000_000_000,
};

const runs: Run[] = [
  {
    id: 'run-1',
    batchId: batch.id,
    agentId: 'agent-1',
    agentName: 'agent-1',
    status: 'running',
    lastSeq: 0,
    createdAt: 1_700_000_000_000,
  },
  {
    id: 'run-2',
    batchId: batch.id,
    agentId: 'agent-2',
    agentName: 'agent-2',
    status: 'running',
    lastSeq: 0,
    createdAt: 1_700_000_000_000,
  },
];

function outputEvent(runId: string, text: string): RunEvent {
  return {
    v: 1,
    type: 'event',
    runId,
    seq: 1,
    kind: 'output',
    stream: 'stdout',
    dataBase64: btoa(text),
  };
}

function eventsResponse(events: RunEvent[] = []): EventsResponse {
  return { events, nextSeq: events.length > 0 ? 2 : 1, hasMore: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RenderProps {
  wsFrame?: BrowserFrame | null;
  wsFrameId?: number;
  wsGeneration?: number;
}

describe('BatchRunner live sync', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderRunner = async (props: RenderProps = {}) => {
    await act(async () => {
      root.render(
        <BatchRunner
          agents={[]}
          initialBatchId={batch.id}
          initialCommand="uname -a"
          onError={() => {}}
          onSuccess={() => {}}
          isWsConnected
          lastWsFrame={props.wsFrame ?? null}
          wsFrameId={props.wsFrameId ?? 0}
          wsGeneration={props.wsGeneration ?? 0}
        />,
      );
    });
    await settle();
  };

  const settle = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const findButton = (text: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent || '').includes(text),
    );

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getBatchDetail.mockReset();
    getRunEvents.mockReset();
    createBatch.mockReset();
    getBatchDetail.mockResolvedValue({ batch, runs });
    getRunEvents.mockResolvedValue(eventsResponse());
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('processes one WS frame id once and never loops snapshot/event fetches', async () => {
    await renderRunner();
    const initialDetailCalls = getBatchDetail.mock.calls.length;
    expect(initialDetailCalls).toBe(1);

    const frame: BrowserFrame = {
      v: 1,
      type: 'changed',
      batchId: batch.id,
      runId: 'run-1',
    };

    await act(async () => {
      root.render(
        <BatchRunner
          agents={[]}
          initialBatchId={batch.id}
          onError={() => {}}
          onSuccess={() => {}}
          isWsConnected
          lastWsFrame={frame}
          wsFrameId={1}
          wsGeneration={0}
        />,
      );
    });
    await settle(250);

    const afterNotificationDetailCalls = getBatchDetail.mock.calls.length;
    const afterNotificationEventCalls = getRunEvents.mock.calls.length;
    expect(afterNotificationDetailCalls).toBe(initialDetailCalls + 1);

    // Re-render with the exact same frame/id, as a parent state update would.
    await act(async () => {
      root.render(
        <BatchRunner
          agents={[]}
          initialBatchId={batch.id}
          onError={() => {}}
          onSuccess={() => {}}
          isWsConnected
          lastWsFrame={frame}
          wsFrameId={1}
          wsGeneration={0}
        />,
      );
    });
    await settle(650);

    expect(getBatchDetail.mock.calls.length).toBe(afterNotificationDetailCalls);
    expect(getRunEvents.mock.calls.length).toBe(afterNotificationEventCalls);
  });

  it('does not leak a late response from the previous run into the newly selected run', async () => {
    const lateRun1 = deferred<EventsResponse>();
    getRunEvents.mockImplementation((runId: string) => {
      if (runId === 'run-1') return lateRun1.promise;
      return Promise.resolve(eventsResponse([outputEvent('run-2', 'RUN2_OUTPUT')]));
    });

    await renderRunner();

    const run2Button = findButton('agent-2');
    expect(run2Button).toBeTruthy();
    await act(async () => {
      run2Button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    await settle();
    await settle();

    expect(container.textContent).toContain('RUN2_OUTPUT');

    lateRun1.resolve(eventsResponse([outputEvent('run-1', 'RUN1_LATE')]));
    await settle(50);
    await settle();

    expect(container.textContent).toContain('RUN2_OUTPUT');
    expect(container.textContent).not.toContain('RUN1_LATE');
  });

  it('submits the real form with selected targets and POSTs the batch payload', async () => {
    createBatch.mockResolvedValue({ batch, runs: [runs[0]] });

    await act(async () => {
      root.render(
        <BatchRunner
          agents={[agent]}
          preselectedAgentIds={['agent-1']}
          initialCommand="uname -a"
          onError={() => {}}
          onSuccess={() => {}}
          isWsConnected
          lastWsFrame={null}
          wsFrameId={0}
          wsGeneration={0}
        />,
      );
    });
    await settle();

    const form = container.querySelector('form');
    expect(form).toBeTruthy();
    const submitButton = findButton('提交并分发任务');
    expect(submitButton).toBeTruthy();
    expect(submitButton!.disabled).toBe(false);

    await act(async () => {
      // Use the browser's own form submission path, not a direct call to the
      // API helper, so client-side validation/handler wiring is covered.
      if (typeof form!.requestSubmit === 'function') {
        form!.requestSubmit();
      } else {
        form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    });
    await settle();

    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(createBatch.mock.calls[0][0]).toMatchObject({
      agentIds: ['agent-1'],
      command: 'uname -a',
      timeoutSec: 300,
    });
  });

  it('refetches the snapshot and backfills active-run output on reconnect generation', async () => {
    let reconnected = false;
    getRunEvents.mockImplementation(() =>
      Promise.resolve(
        reconnected
          ? eventsResponse([outputEvent('run-1', 'RECONNECTED_OUTPUT')])
          : eventsResponse(),
      ),
    );

    await renderRunner();
    const detailCallsBeforeReconnect = getBatchDetail.mock.calls.length;
    const eventCallsBeforeReconnect = getRunEvents.mock.calls.length;

    reconnected = true;
    await act(async () => {
      root.render(
        <BatchRunner
          agents={[]}
          initialBatchId={batch.id}
          onError={() => {}}
          onSuccess={() => {}}
          isWsConnected
          lastWsFrame={null}
          wsFrameId={0}
          wsGeneration={1}
        />,
      );
    });
    await settle(100);

    expect(getBatchDetail.mock.calls.length).toBe(detailCallsBeforeReconnect + 1);
    expect(getRunEvents.mock.calls.length).toBeGreaterThanOrEqual(
      eventCallsBeforeReconnect + 1,
    );
    expect(container.textContent).toContain('RECONNECTED_OUTPUT');
  });
});
