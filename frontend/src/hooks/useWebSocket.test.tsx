// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWebSocket } from './useWebSocket';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  serverOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  serverClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

const Harness: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { isConnected } = useWebSocket({ enabled });
  return <div data-testid="ws-state">{isConnected ? 'open' : 'closed'}</div>;
};

describe('useWebSocket lifecycle isolation', () => {
  let container: HTMLDivElement;
  let root: Root;

  const state = () => container.querySelector('[data-testid="ws-state"]')?.textContent;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('ignores a late close event from an old socket after a new socket opens', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<Harness enabled />);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    const first = MockWebSocket.instances[0];

    await act(async () => {
      first.serverOpen();
    });
    expect(state()).toBe('open');

    // Disconnect and let the hook create a replacement socket.
    await act(async () => {
      first.serverClose();
    });
    expect(state()).toBe('closed');
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = MockWebSocket.instances[1];
    await act(async () => {
      second.serverOpen();
    });
    expect(state()).toBe('open');

    // A stale close callback from the old socket must not flip the new one.
    await act(async () => {
      first.onclose?.(new CloseEvent('close'));
    });
    expect(state()).toBe('open');
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('cancels retries while disabled (expired session) and ignores old callbacks', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<Harness enabled />);
    });
    const first = MockWebSocket.instances[0];
    await act(async () => {
      first.serverOpen();
    });
    expect(state()).toBe('open');

    await act(async () => {
      root.render(<Harness enabled={false} />);
    });
    expect(state()).toBe('closed');

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    await act(async () => {
      first.onclose?.(new CloseEvent('close'));
    });
    expect(state()).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
