import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abortAllDurableObjects,
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  agentToken,
  b64,
  call,
  createAgent,
  hello,
  installFakeCloudflare,
  openAgentSocket,
  openBrowserSocket,
  restoreFetch,
  uiCall,
  waitAgentOnline,
} from "./helpers";
import type { FakeCloudflareState } from "./helpers";

async function startRun(
  agentId: string,
  command = "echo hello",
  timeoutSec = 30,
): Promise<{ batch: any; run: any }> {
  const response = await uiCall("/ui-api/batches", {
    method: "POST",
    body: {
      requestId: crypto.randomUUID(),
      agentIds: [agentId],
      command,
      timeoutSec,
    },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { batch: any; runs: any[] };
  return { batch: body.batch, run: body.runs[0] };
}

describe("batches, agent websocket delivery and event journal", () => {
  let fake: FakeCloudflareState;
  beforeEach(async () => {
    await reset();
    fake = installFakeCloudflare();
  });
  afterEach(() => restoreFetch());

  it("dispatches once, persists ordered events, acks duplicates and keeps HTTP authoritative", async () => {
    const { agent, token } = await createAgent(fake, "batch-a");
    const browser = await openBrowserSocket();
    const socket = await openAgentSocket(token.client_id);
    await hello(socket);
    await waitAgentOnline(agent.id);
    await browser.waitFor((value) => value?.type === "agents_changed");

    const { batch, run } = await startRun(agent.id);
    const execute = await socket.waitFor((value) => value?.type === "execute");
    expect(execute.runId).toBe(run.id);
    expect(execute.command).toBe("echo hello");
    expect(execute.acceptBefore).toBeGreaterThan(Date.now());

    socket.send({ v: 1, type: "event", runId: run.id, seq: 1, kind: "accepted" });
    expect(await socket.waitFor((v) => v.type === "ack" && v.runId === run.id)).toEqual({
      v: 1,
      type: "ack",
      runId: run.id,
      throughSeq: 1,
    });
    socket.send({ v: 1, type: "event", runId: run.id, seq: 2, kind: "started" });
    await socket.waitFor((v) => v.type === "ack" && v.throughSeq === 2);
    socket.send({
      v: 1,
      type: "event",
      runId: run.id,
      seq: 3,
      kind: "output",
      stream: "stdout",
      dataBase64: b64("hello\n"),
    });
    await socket.waitFor((v) => v.type === "ack" && v.throughSeq === 3);
    socket.send({
      v: 1,
      type: "event",
      runId: run.id,
      seq: 4,
      kind: "finished",
      status: "succeeded",
      exitCode: 0,
    });
    await socket.waitFor((v) => v.type === "ack" && v.throughSeq === 4);
    const changed = await browser.waitFor(
      (value) => value?.type === "changed" && value.runId === run.id && value.lastSeq === 4,
    );
    expect(changed.lastSeq).toBe(4);

    const batchResponse = await uiCall(`/ui-api/batches/${batch.id}`);
    const body = (await batchResponse.json()) as any;
    expect(body.runs[0].status).toBe("succeeded");
    expect(body.runs[0].exitCode).toBe(0);
    expect(body.runs[0].lastSeq).toBe(4);
    expect(body.runs[0].finishedAt).toBeTypeOf("number");

    const events = (await (await uiCall(`/ui-api/runs/${run.id}/events?afterSeq=0`)).json()) as any;
    expect(events.events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(events.events[2].dataBase64).toBe(b64("hello\n"));
    expect(events.nextSeq).toBe(4);
    expect(events.hasMore).toBe(false);

    socket.send({ v: 1, type: "event", runId: run.id, seq: 3, kind: "output", stream: "stdout", dataBase64: b64("dup") });
    expect(await socket.waitFor((v) => v.type === "ack" && v.throughSeq === 4)).toBeTruthy();
    const afterDup = (await (await uiCall(`/ui-api/batches/${batch.id}`)).json()) as any;
    expect(afterDup.runs[0].status).toBe("succeeded");
    expect(afterDup.runs[0].lastSeq).toBe(4);

    browser.close();
    socket.close();
  });

  it("ACKs only the contiguous prefix on gaps and validates ownership", async () => {
    const a = await createAgent(fake, "gap-a");
    const b = await createAgent(fake, "gap-b");
    const socketA = await openAgentSocket(a.token.client_id);
    const socketB = await openAgentSocket(b.token.client_id);
    await hello(socketA);
    await hello(socketB);
    await waitAgentOnline(a.agent.id);
    await waitAgentOnline(b.agent.id);

    const { run } = await startRun(a.agent.id);
    await socketA.waitFor((v) => v.type === "execute" && v.runId === run.id);
    socketA.send({ v: 1, type: "event", runId: run.id, seq: 1, kind: "accepted" });
    await socketA.waitFor((v) => v.type === "ack" && v.throughSeq === 1);
    socketA.send({
      v: 1,
      type: "event",
      runId: run.id,
      seq: 3,
      kind: "output",
      stream: "stdout",
      dataBase64: b64("out-of-order"),
    });
    expect(await socketA.waitFor((v) => v.type === "ack" && v.runId === run.id)).toEqual({
      v: 1,
      type: "ack",
      runId: run.id,
      throughSeq: 1,
    });
    const afterGap = (await (await uiCall(`/ui-api/runs/${run.id}/events`)).json()) as any;
    expect(afterGap.events.map((e: any) => e.seq)).toEqual([1]);

    socketB.send({ v: 1, type: "event", runId: run.id, seq: 2, kind: "started" });
    const closed = await socketB.closed;
    expect(closed.code).toBe(1008);
    expect((await (await uiCall("/ui-api/agents")).json() as any).agents.length).toBe(2);
    socketA.close();
  });

  it("replaces the old socket and ignores its late state changes", async () => {
    const { agent, token } = await createAgent(fake, "reconnect");
    const oldSocket = await openAgentSocket(token.client_id);
    await hello(oldSocket);
    await waitAgentOnline(agent.id);

    const newSocket = await openAgentSocket(token.client_id);
    await hello(newSocket);
    expect((await oldSocket.closed).code).toBe(4001);
    await waitAgentOnline(agent.id);

    const { run } = await startRun(agent.id);
    const execute = await newSocket.waitFor((v) => v.type === "execute");
    expect(execute.runId).toBe(run.id);
    newSocket.send({ v: 1, type: "event", runId: run.id, seq: 1, kind: "accepted" });
    await newSocket.waitFor((v) => v.type === "ack" && v.throughSeq === 1);
    newSocket.close();
  });

  it("uses one Alarm for accept deadlines and accepts a late trusted finish after unknown", async () => {
    const { agent, token } = await createAgent(fake, "late");
    const socket = await openAgentSocket(token.client_id);
    await hello(socket);
    await waitAgentOnline(agent.id);
    const { batch, run } = await startRun(agent.id, "sleep 20", 5);
    const execute = await socket.waitFor((v) => v.type === "execute");
    expect(execute.runId).toBe(run.id);

    const stub = (env as any).HUB.get((env as any).HUB.idFromName("hub"));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE runs SET accept_deadline=? WHERE id=?",
        Date.now() - 60_000,
        run.id,
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const unknown = (await (await uiCall(`/ui-api/batches/${batch.id}`)).json()) as any;
    expect(unknown.runs[0].status).toBe("unknown");
    expect(unknown.runs[0].reason).toContain("accept timeout");

    socket.send({ v: 1, type: "event", runId: run.id, seq: 1, kind: "accepted" });
    await socket.waitFor((v) => v.type === "ack" && v.throughSeq === 1);
    socket.send({ v: 1, type: "event", runId: run.id, seq: 2, kind: "started" });
    await socket.waitFor((v) => v.type === "ack" && v.throughSeq === 2);
    socket.send({
      v: 1,
      type: "event",
      runId: run.id,
      seq: 3,
      kind: "finished",
      status: "succeeded",
      exitCode: 0,
    });
    await socket.waitFor((v) => v.type === "ack" && v.throughSeq === 3);
    const corrected = (await (await uiCall(`/ui-api/batches/${batch.id}`)).json()) as any;
    expect(corrected.runs[0].status).toBe("succeeded");
    expect(corrected.runs[0].exitCode).toBe(0);
    socket.close();
  });

  it("reconstructs SQLite state across memory eviction and never redispatches", async () => {
    const { agent, token } = await createAgent(fake, "hibernate");
    const socket = await openAgentSocket(token.client_id);
    await hello(socket);
    await waitAgentOnline(agent.id);
    const { run } = await startRun(agent.id);
    await socket.waitFor((v) => v.type === "execute");
    socket.send({ v: 1, type: "event", runId: run.id, seq: 1, kind: "accepted" });
    await socket.waitFor((v) => v.type === "ack" && v.throughSeq === 1);

    const stub = (env as any).HUB.get((env as any).HUB.idFromName("hub"));
    const attachment = await runInDurableObject(stub, (_instance, state) => {
      const sockets = state.getWebSockets();
      return sockets[0]?.deserializeAttachment() as any;
    });
    expect(attachment.kind).toBe("agent");
    expect(attachment.connectionId).toBeTypeOf("string");
    expect(attachment.authDeadline).toBeGreaterThan(Date.now());

    // Miniflare 5 alpha currently hangs HTTP/WS delivery after an eviction that
    // preserves a hibernated socket. Close the socket first, then evict memory;
    // SQLite and the reconnect protocol path are still exercised for real.
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await abortAllDurableObjects();
    const agents = (await (await uiCall("/ui-api/agents")).json()) as any;
    expect(agents.agents[0].online).toBe(false);
    const history = (await (await uiCall(`/ui-api/batches/${run.batchId}`)).json()) as any;
    expect(history.runs[0].lastSeq).toBe(1);
    expect(history.runs[0].status).toBe("accepted");

    const reconnected = await openAgentSocket(token.client_id);
    await hello(reconnected, {
      runs: [{ runId: run.id, state: "accepted", lastSeq: 1 }],
    });
    await waitAgentOnline(agent.id);
    // Hello only ACKs; the old dispatching/execute request is never re-sent.
    expect(
      await reconnected.waitFor((v) => v.type === "ack" && v.runId === run.id),
    ).toEqual({ v: 1, type: "ack", runId: run.id, throughSeq: 1 });
    reconnected.send({ v: 1, type: "event", runId: run.id, seq: 2, kind: "started" });
    await reconnected.waitFor((v) => v.type === "ack" && v.throughSeq === 2);
    reconnected.close();
  });

  it("stops persisting output and does not ACK once log/SQL quotas are exhausted", async () => {
    const { agent, token } = await createAgent(fake, "quota");
    const socket = await openAgentSocket(token.client_id);
    await hello(socket);
    await waitAgentOnline(agent.id);
    const { batch, run } = await startRun(agent.id);
    await socket.waitFor((v) => v.type === "execute");
    socket.send({ v: 1, type: "event", runId: run.id, seq: 1, kind: "accepted" });
    await socket.waitFor((v) => v.type === "ack" && v.throughSeq === 1);

    const stub = (env as any).HUB.get((env as any).HUB.idFromName("hub"));
    const day = new Date().toISOString().slice(0, 10);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE usage SET log_frames=10000 WHERE day=?",
        day,
      );
    });
    const before = await runInDurableObject(stub, (_instance, state) => {
      const events = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM run_events")
        .one();
      const usage = state.storage.sql
        .exec<{ log_frames: number; rows_written: number }>(
          "SELECT log_frames,rows_written FROM usage WHERE day=?",
          day,
        )
        .one();
      return { events: events.count, usage };
    });
    socket.send({
      v: 1,
      type: "event",
      runId: run.id,
      seq: 2,
      kind: "output",
      stream: "stderr",
      dataBase64: b64("must-not-be-stored"),
    });
    const pause = await socket.waitFor((v) => v.type === "pause");
    expect(pause.retryAfter).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await runInDurableObject(stub, (_instance, state) => {
      const events = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM run_events")
        .one();
      const usage = state.storage.sql
        .exec<{ log_frames: number; rows_written: number }>(
          "SELECT log_frames,rows_written FROM usage WHERE day=?",
          day,
        )
        .one();
      const row = state.storage.sql
        .exec<{ last_seq: number; status: string; output_truncated: number }>(
          "SELECT last_seq,status,output_truncated FROM runs WHERE id=?",
          run.id,
        )
        .one();
      return { events: events.count, usage, row };
    });
    expect(after.events).toBe(before.events);
    expect(after.usage.log_frames).toBe(10000);
    expect(after.row.last_seq).toBe(1);
    expect(after.row.status).toBe("accepted");
    // Re-sending the same pending output also produces no new rows.
    socket.send({
      v: 1,
      type: "event",
      runId: run.id,
      seq: 2,
      kind: "output",
      stream: "stderr",
      dataBase64: b64("must-not-be-stored"),
    });
    await socket.waitFor((v) => v.type === "pause");
    const afterRetry = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM run_events")
        .one().count,
    );
    expect(afterRetry).toBe(before.events);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE usage SET log_frames=0,rows_written=50000 WHERE day=?",
        day,
      );
    });
    socket.send({
      v: 1,
      type: "event",
      runId: run.id,
      seq: 2,
      kind: "output",
      stream: "stdout",
      dataBase64: b64("write-budget"),
    });
    await socket.waitFor((v) => v.type === "pause");
    const afterSqlBudget = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM run_events")
        .one().count,
    );
    expect(afterSqlBudget).toBe(before.events);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE usage SET requests=100000 WHERE day=?",
        day,
      );
    });
    const rejected = await uiCall("/ui-api/batches", {
      method: "POST",
      body: {
        requestId: crypto.randomUUID(),
        agentIds: [agent.id],
        command: "echo no",
      },
    });
    expect(rejected.status).toBe(507);
    const usage = (await (await uiCall("/ui-api/usage")).json()) as any;
    expect(usage.limited).toBe(true);
    expect(usage.rowsWritten).toBeGreaterThan(0);
    void batch;
    socket.close();
  });

  it("freezes resolved targets, deduplicates unions, skips busy/offline", async () => {
    const group = (await (await uiCall("/ui-api/groups", {
      method: "POST",
      body: { name: "fleet" },
    })).json() as any).group;
    const a = await createAgent(fake, "union-a", [group.id]);
    const b = await createAgent(fake, "union-b", [group.id]);
    const c = await createAgent(fake, "union-c");
    const socketA = await openAgentSocket(a.token.client_id);
    const socketB = await openAgentSocket(b.token.client_id);
    await hello(socketA);
    await hello(socketB);
    await waitAgentOnline(a.agent.id);
    await waitAgentOnline(b.agent.id);

    const requestId = crypto.randomUUID();
    const payload = {
      requestId,
      agentIds: [a.agent.id],
      groupIds: [group.id],
      command: "echo union",
      timeoutSec: 10,
    };
    const first = await uiCall("/ui-api/batches", { method: "POST", body: payload });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as any;
    expect(firstBody.runs.map((r: any) => r.agentId).sort()).toEqual(
      [a.agent.id, b.agent.id].sort(),
    );
    const executeA = await socketA.waitFor((v) => v.type === "execute");
    const executeB = await socketB.waitFor((v) => v.type === "execute");
    expect(executeA.runId).toBe(firstBody.runs.find((r: any) => r.agentId === a.agent.id).id);
    expect(executeB.runId).toBe(firstBody.runs.find((r: any) => r.agentId === b.agent.id).id);

    // Adding an agent to the group after the fact must not change the frozen batch.
    await uiCall(`/ui-api/groups/${group.id}`, {
      method: "PATCH",
      body: { name: "fleet-renamed" },
    });
    await uiCall(`/ui-api/agents/${c.agent.id}`, {
      method: "PATCH",
      body: { groupIds: [group.id] },
    });
    const replay = await uiCall("/ui-api/batches", { method: "POST", body: payload });
    expect([200, 201]).toContain(replay.status);
    const replayBody = (await replay.json()) as any;
    expect(replayBody.batch.id).toBe(firstBody.batch.id);
    expect(replayBody.runs).toHaveLength(2);
    expect(replayBody.runs.some((r: any) => r.agentId === c.agent.id)).toBe(false);
    const conflict = await uiCall("/ui-api/batches", {
      method: "POST",
      body: { ...payload, command: "echo changed" },
    });
    expect(conflict.status).toBe(409);

    const busy = await uiCall("/ui-api/batches", {
      method: "POST",
      body: {
        requestId: crypto.randomUUID(),
        agentIds: [a.agent.id],
        command: "echo busy",
      },
    });
    expect(busy.status).toBe(201);
    const busyBody = (await busy.json()) as any;
    expect(busyBody.runs[0].status).toBe("skipped_busy");

    const offline = await uiCall("/ui-api/batches", {
      method: "POST",
      body: {
        requestId: crypto.randomUUID(),
        agentIds: [c.agent.id],
        command: "echo offline",
      },
    });
    expect(offline.status).toBe(201);
    expect(((await offline.json()) as any).runs[0].status).toBe("skipped_offline");
    socketA.close();
    socketB.close();
  });

  it("closes the live socket on disable and rejects reconnect", async () => {
    const { agent, token } = await createAgent(fake, "disable-live");
    const socket = await openAgentSocket(token.client_id);
    await hello(socket);
    await waitAgentOnline(agent.id);
    const disabled = await uiCall(`/ui-api/agents/${agent.id}/disable`, { method: "POST" });
    expect(disabled.status).toBe(200);
    expect((await socket.closed).code).toBe(4003);
    const retry = await call("/agent/ws", {
      token: await agentToken(token.client_id),
      headers: { upgrade: "websocket" },
    });
    expect(retry.status).toBe(403);
  });

  it("rejects oversized frames and malformed output base64", async () => {
    const { agent, token } = await createAgent(fake, "framing");
    const oversized = await openAgentSocket(token.client_id);
    await hello(oversized);
    await waitAgentOnline(agent.id);
    oversized.sendText("x".repeat(65 * 1024 + 1));
    expect((await oversized.closed).code).toBe(1009);

    const malformed = await openAgentSocket(token.client_id);
    await hello(malformed);
    await waitAgentOnline(agent.id);
    const { run } = await startRun(agent.id);
    await malformed.waitFor((v) => v.type === "execute");
    malformed.send({
      v: 1,
      type: "event",
      runId: run.id,
      seq: 1,
      kind: "output",
      stream: "stdout",
      dataBase64: "not base64!!",
    });
    expect((await malformed.closed).code).toBe(1008);
  });

  it("probes RTT in socket attachments and merges calls within 15 seconds", async () => {
    const { agent, token } = await createAgent(fake, "probe");
    const socket = await openAgentSocket(token.client_id);
    await hello(socket);
    await waitAgentOnline(agent.id);
    const first = await uiCall("/ui-api/agents/probe", {
      method: "POST",
      body: { agentIds: [agent.id] },
    });
    expect(first.status).toBe(200);
    const probe = await socket.waitFor((v) => v.type === "probe");
    socket.send({ v: 1, type: "probe_reply", probeId: probe.probeId });
    const agents = await waitAgentOnline(agent.id);
    expect(agents.latencyMs).toBeTypeOf("number");
    expect(agents.latencyMeasuredAt).toBeTypeOf("number");

    const second = await uiCall("/ui-api/agents/probe", {
      method: "POST",
      body: { agentIds: [agent.id] },
    });
    expect(second.status).toBe(200);
    let merged = false;
    try {
      await socket.waitFor((v) => v.type === "probe", 150);
    } catch {
      merged = true;
    }
    expect(merged).toBe(true);
    socket.close();
  });
});
