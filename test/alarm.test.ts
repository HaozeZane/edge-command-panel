import { beforeEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";

const GRACE_MS = 10_000;
const run = runInDurableObject as any;

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  attachment: any;
  closeCalls: Array<{ code: number; reason: string }> = [];
  sent: string[] = [];

  constructor(attachment: any) {
    this.attachment = attachment;
  }

  deserializeAttachment(): any {
    return this.attachment;
  }

  serializeAttachment(attachment: any): void {
    this.attachment = attachment;
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

function setSockets(instance: any, all: FakeSocket[], browser: FakeSocket[]): void {
  Object.defineProperty(instance.ctx, "getWebSockets", {
    configurable: true,
    value: (tag?: string) => {
      if (tag === undefined) return all;
      if (tag === "browser") return browser;
      return all.filter((ws) => ws.attachment?.agentId === tag);
    },
  });
}

function hubStub(): any {
  return (env as any).HUB.get((env as any).HUB.idFromName("hub"));
}

function setCleanup(state: DurableObjectState, at: number): void {
  state.storage.sql.exec(
    "UPDATE meta SET value=? WHERE key='next_cleanup_at'",
    String(at),
  );
}

describe("Durable Object alarm lifecycle", () => {
  beforeEach(async () => {
    await reset();
  });

  it("closes an expired browser socket once and never reschedules it every millisecond", async () => {
    await run(hubStub(), async (instance: any, state: any) => {
      const cleanup = Date.now() + 600_000;
      setCleanup(state, cleanup);
      const browser = new FakeSocket({
        kind: "browser",
        expiresAt: Date.now() - 1_000,
        identity: "browser-test",
      });
      setSockets(instance, [browser], [browser]);

      await instance.alarm();
      await instance.alarm();
      await instance.alarm();

      expect(browser.attachment.closing).toBe(true);
      expect(browser.readyState).toBe(WebSocket.CLOSING);
      expect(browser.closeCalls).toHaveLength(1);
      expect(browser.closeCalls[0]!.code).toBe(4003);
      expect(await state.storage.getAlarm()).toBe(cleanup);
    });
  });

  it("closes expired agent auth and hello-timeout sockets exactly once", async () => {
    await run(hubStub(), async (instance: any, state: any) => {
      setCleanup(state, Date.now() + 600_000);
      const now = Date.now();
      const authExpired = new FakeSocket({
        kind: "agent",
        agentId: "agent-auth",
        connectionId: "conn-auth",
        hello: true,
        connectedAt: now - 1_000,
        lastSeenAt: now - 1_000,
        authDeadline: now - 1,
      });
      const helloTimeout = new FakeSocket({
        kind: "agent",
        agentId: "agent-hello",
        connectionId: "conn-hello",
        hello: false,
        connectedAt: now - 20_000,
        lastSeenAt: now - 20_000,
        authDeadline: now + 60_000,
      });
      setSockets(instance, [authExpired, helloTimeout], []);

      await instance.alarm();
      await instance.alarm();

      expect(authExpired.closeCalls).toHaveLength(1);
      expect(authExpired.closeCalls[0]!.code).toBe(4003);
      expect(helloTimeout.closeCalls).toHaveLength(1);
      expect(helloTimeout.closeCalls[0]!.code).toBe(4008);
      expect(authExpired.attachment.closing).toBe(true);
      expect(helloTimeout.attachment.closing).toBe(true);
    });
  });

  it("keeps the persisted closing flag after hibernation attachment reconstruction", async () => {
    await run(hubStub(), async (instance: any, state: any) => {
      setCleanup(state, Date.now() + 600_000);
      const first = new FakeSocket({
        kind: "browser",
        expiresAt: Date.now() - 1_000,
        identity: "browser-test",
      });
      setSockets(instance, [first], [first]);
      await instance.alarm();
      expect(first.closeCalls).toHaveLength(1);

      // Hibernation restores the serialized attachment; closing must survive it.
      const restored = new FakeSocket(JSON.parse(JSON.stringify(first.attachment)));
      setSockets(instance, [restored], [restored]);
      await instance.alarm();

      expect(restored.attachment.closing).toBe(true);
      expect(restored.closeCalls).toHaveLength(0);
    });
  });

  it("does not let a late old-connection close clear the new identity", async () => {
    await run(hubStub(), async (instance: any, state: any) => {
      const now = Date.now();
      const cleanup = now + 600_000;
      setCleanup(state, cleanup);
      state.storage.sql.exec(
        `INSERT INTO agents(id,name,group_ids,disabled,access_client_id,connection_id,connected_at,created_at)
         VALUES('agent-1','agent','[]',0,'client-1','new-conn',?,?)`,
        now,
        now,
      );
      const old = new FakeSocket({
        kind: "agent",
        agentId: "agent-1",
        connectionId: "old-conn",
        hello: true,
        connectedAt: now - 1_000,
        lastSeenAt: now - 1_000,
        authDeadline: now + 60_000,
      });
      old.readyState = WebSocket.CLOSED;
      const current = new FakeSocket({
        kind: "agent",
        agentId: "agent-1",
        connectionId: "new-conn",
        hello: true,
        connectedAt: now,
        lastSeenAt: now,
        authDeadline: now + 60_000,
      });
      setSockets(instance, [old, current], []);

      await instance.webSocketClose(old as unknown as WebSocket, 1006, "old close", false);

      const row = state.storage.sql
        .exec("SELECT id,connection_id FROM agents WHERE id='agent-1'")
        .one() as { id: string; connection_id: string };
      expect(row.connection_id).toBe("new-conn");
      expect(instance.currentSocket(row)).toBe(current);
    });
  });

  it("recomputes the alarm on browser close and error callbacks", async () => {
    await run(hubStub(), async (instance: any, state: any) => {
      const cleanup = Date.now() + 600_000;
      setCleanup(state, cleanup);
      const browser = new FakeSocket({
        kind: "browser",
        expiresAt: Date.now() + 60_000,
        identity: "browser-test",
      });
      browser.readyState = WebSocket.CLOSED;
      setSockets(instance, [], [browser]);

      await state.storage.deleteAlarm();
      await instance.webSocketClose(browser as unknown as WebSocket, 1000, "done", true);
      expect(await state.storage.getAlarm()).toBe(cleanup);

      await state.storage.deleteAlarm();
      await instance.webSocketError(browser as unknown as WebSocket, new Error("socket error"));
      expect(await state.storage.getAlarm()).toBe(cleanup);
    });
  });

  it("keeps real run deadlines and future cleanup in the alarm schedule", async () => {
    await run(hubStub(), async (instance: any, state: any) => {
      const now = Date.now();
      const cleanup = now + 600_000;
      setCleanup(state, cleanup);
      const deadline = now + 30_000;
      state.storage.sql.exec(
        `INSERT INTO runs(id,batch_id,agent_id,agent_name,status,last_seq,created_at,deadline_at,timeout_sec,output_bytes)
         VALUES('run-1','batch-1','agent-1','agent','running',0,?,?,300,0)`,
        now,
        deadline,
      );
      setSockets(instance, [], []);

      await instance.scheduleAlarm();
      expect(await state.storage.getAlarm()).toBe(deadline + GRACE_MS);

      state.storage.sql.exec("UPDATE runs SET status='succeeded' WHERE id='run-1'");
      await instance.scheduleAlarm();
      expect(await state.storage.getAlarm()).toBe(cleanup);
    });
  });

  it("does not count, notify or send to closing sockets", async () => {
    await run(hubStub(), async (instance: any, state: any) => {
      const now = Date.now();
      setCleanup(state, now + 600_000);
      state.storage.sql.exec(
        `INSERT INTO agents(id,name,group_ids,disabled,access_client_id,connection_id,connected_at,created_at)
         VALUES('agent-1','agent','[]',0,'client-1','conn-1',?,?)`,
        now,
        now,
      );
      const agent = new FakeSocket({
        kind: "agent",
        agentId: "agent-1",
        connectionId: "conn-1",
        hello: true,
        connectedAt: now,
        lastSeenAt: now,
        authDeadline: now + 60_000,
      });
      agent.readyState = WebSocket.CLOSING;
      const browser = new FakeSocket({
        kind: "browser",
        expiresAt: now + 60_000,
        identity: "browser-test",
      });
      browser.readyState = WebSocket.CLOSING;
      setSockets(instance, [agent], [browser]);

      const row = { id: "agent-1", connection_id: "conn-1" };
      expect(instance.currentSocket(row)).toBeUndefined();
      expect(instance.socketOnline(row)).toBe(false);
      instance.notify({ v: 1, type: "changed" });
      expect(browser.sent).toHaveLength(0);
      expect(instance.send(agent, { v: 1, type: "welcome", connectionId: "conn-1" })).toBe(false);
      expect(agent.sent).toHaveLength(0);
    });
  });
});
