// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Agent } from '../../types/protocol';
import { BatchRunner } from './BatchRunner';

const agent: Agent = {
  id: 'agent-live',
  name: 'agent-live',
  groupIds: [],
  disabled: false,
  online: true,
  createdAt: 1_700_000_000_000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const batch = {
  id: 'batch-live',
  requestId: 'req-live',
  command: 'uname -a',
  timeoutSec: 300,
  createdAt: 1_700_000_000_000,
};

const run = {
  id: 'run-live',
  batchId: batch.id,
  agentId: agent.id,
  agentName: agent.name,
  status: 'running' as const,
  lastSeq: 0,
  createdAt: 1_700_000_000_000,
};

describe('BatchRunner real form + API client integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  const settle = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('submits the browser form, POSTs /ui-api/batches as JSON, then starts events fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/ui-api/batches')) {
        return jsonResponse({ batch, runs: [run] }, 201);
      }
      if (url.includes('/ui-api/runs/')) {
        return jsonResponse({ events: [], nextSeq: 1, hasMore: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await act(async () => {
      root.render(
        <BatchRunner
          agents={[agent]}
          preselectedAgentIds={[agent.id]}
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

    await act(async () => {
      if (typeof form!.requestSubmit === 'function') form!.requestSubmit();
      else form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    await settle();

    const postCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input) === '/ui-api/batches' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeTruthy();

    const init = postCall![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      agentIds: [agent.id],
      command: 'uname -a',
      timeoutSec: 300,
    });
    expect(typeof payload.requestId).toBe('string');
    expect(payload.requestId.length).toBeGreaterThan(0);

    // The client uses the returned run id to begin incremental log fetch.
    expect(
      fetchSpy.mock.calls.some(([input]) => String(input).includes('/ui-api/runs/run-live/events')),
    ).toBe(true);
  });
});
