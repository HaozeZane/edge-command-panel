import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, SessionExpiredError } from './client';

describe('API Client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('detects Cloudflare Access 302 HTML response and throws SessionExpiredError', async () => {
    const htmlResponse = new Response('<!DOCTYPE html><html>Login with Cloudflare Access</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(htmlResponse);

    await expect(api.getSession()).rejects.toThrow(SessionExpiredError);
  });

  it('detects 401 Unauthorized and throws SessionExpiredError', async () => {
    const errorResponse = new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorResponse);

    await expect(api.getAgents()).rejects.toThrow(SessionExpiredError);
  });

  it.each([
    ['disableAgent', () => api.disableAgent('agent-1'), 'POST'],
    ['rotateAgentToken', () => api.rotateAgentToken('agent-1'), 'POST'],
    ['revokeEnrollment', () => api.revokeEnrollment('enroll-1'), 'POST'],
    ['deleteGroup', () => api.deleteGroup('group-1'), 'DELETE'],
  ])('sends JSON headers and an empty JSON body for body-less write %s', async (_name, call, method) => {
    const okResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResponse);

    await call();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.method).toBe(method);
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe('{}');
  });

  it('parses { error: string } JSON from backend on 400 Bad Request', async () => {
    const errorResponse = new Response(
      JSON.stringify({ error: 'One token limit reached (max 50)' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorResponse);

    await expect(
      api.createAgent({ requestId: 'test-req', name: 'fail-agent' }),
    ).rejects.toThrowError('One token limit reached (max 50)');
  });
});
