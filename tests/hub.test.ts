import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { setupProblem, startFailureProblem } from "../apps/desktop/src/bot-readiness.js";
import { checkConfig, loadConfig } from "../src/config.js";
import { checkHub, HubClient, newHubToken } from "../src/hub/client.js";
import { createLogger } from "../src/logger.js";
import { normalizeCode, Pairings, PAIRING_TTL_MS } from "../src/hub/pairing.js";
import { fileIdOf, Grants } from "../src/hub/policy.js";
import { HUB_CLOSE, type HubMessage } from "../src/hub/protocol.js";
import { HubServer, type SlackGateway } from "../src/hub/server.js";
import { DesktopStore } from "../src/hub/store.js";
import { HubReceiver } from "../src/messengers/slack/hub-receiver.js";

const root = mkdtempSync(path.join(tmpdir(), "orbly-hub-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const alice = { id: "U0ALICE", name: "alice" };

describe("hub pairing", () => {
  it("binds a code to the member who sent it and confirms with the desktop's token", () => {
    let now = 1_000;
    const pairings = new Pairings(() => now);
    const token = randomBytes(32).toString("hex");
    const { pairingId, code } = pairings.start(sha256(token), "work laptop");
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(pairings.status(pairingId)).toEqual({ status: "pending" });

    expect(pairings.bind(code.toLowerCase().replace("-", " "), alice)).toEqual({
      result: "bound",
      label: "work laptop",
    });
    // Someone else who saw the code cannot take it over.
    expect(pairings.bind(code, { id: "U0EVE", name: "eve" })).toEqual({
      result: "taken",
    });
    expect(pairings.status(pairingId)).toEqual({ status: "bound", user: alice });

    expect(pairings.confirm(pairingId, sha256("another token"))).toBeUndefined();
    expect(pairings.confirm(pairingId, sha256(token))).toEqual({
      user: alice,
      label: "work laptop",
    });
    expect(pairings.status(pairingId)).toEqual({ status: "expired" });

    const late = pairings.start(sha256(token), "x");
    now += PAIRING_TTL_MS + 1;
    expect(pairings.bind(late.code, alice)).toEqual({ result: "unknown" });
    expect(normalizeCode("abcd2345")).toBe("ABCD-2345");
  });
});

describe("hub policy", () => {
  const mention = {
    channel: "C1",
    ts: "200.1",
    thread_ts: "100.1",
    user: "U0ALICE",
    files: [
      {
        id: "F1",
        url_private_download: "https://files.slack.com/files-pri/T1-F1/download/a.png",
      },
    ],
  };

  it("allows the calls a routed thread needs, and nothing else", () => {
    const grants = new Grants();
    expect(
      grants.authorize("conversations.replies", { channel: "C1", ts: "100.1" }).ok
    ).toBe(false);
    grants.add(mention);
    const ok = (method: string, args: Record<string, string>) =>
      grants.authorize(method, args).ok;

    expect(ok("auth.test", {})).toBe(true);
    expect(ok("conversations.replies", { channel: "C1", ts: "100.1" })).toBe(true);
    expect(ok("conversations.replies", { channel: "C1", ts: "999.9" })).toBe(false);
    expect(ok("conversations.replies", { channel: "C2", ts: "100.1" })).toBe(false);
    expect(
      ok("conversations.history", { channel: "C1", latest: "100.1", limit: "10" })
    ).toBe(true);
    expect(
      ok("conversations.history", { channel: "C1", latest: "100.1", limit: "500" })
    ).toBe(false);
    expect(
      ok("chat.postMessage", { channel: "C1", thread_ts: "100.1", text: "hi" })
    ).toBe(true);
    expect(ok("chat.postMessage", { channel: "C1", text: "top level" })).toBe(false);
    expect(ok("chat.postEphemeral", { channel: "C1", user: "U0ALICE" })).toBe(true);
    expect(ok("chat.postEphemeral", { channel: "C1", user: "U0BOB" })).toBe(false);
    expect(ok("conversations.list", {})).toBe(false);
    expect(ok("chat.delete", { channel: "C1", ts: "100.1" })).toBe(false);

    // Only messages the desktop posted can be edited.
    expect(ok("chat.update", { channel: "C1", ts: "300.1" })).toBe(false);
    grants.observe(
      "chat.postMessage",
      { channel: "C1", thread_ts: "100.1" },
      { ok: true, ts: "300.1" }
    );
    expect(ok("chat.update", { channel: "C1", ts: "300.1" })).toBe(true);

    // Files in the thread can be read; others cannot.
    expect(ok("files.info", { file: "F1" })).toBe(true);
    expect(ok("files.info", { file: "F9" })).toBe(false);
    expect(
      grants.canDownload("https://files.slack.com/files-pri/T1-F1/download/a.png")
    ).toBe(true);
    expect(
      grants.canDownload("https://files.slack.com/files-pri/T1-F9/download/b.png")
    ).toBe(false);
    grants.observe(
      "conversations.replies",
      { channel: "C1", ts: "100.1" },
      { ok: true, messages: [{ files: [{ id: "F2" }] }] }
    );
    expect(ok("files.info", { file: "F2" })).toBe(true);

    // Uploads complete only into the thread, and only for files the desktop created.
    grants.observe("files.getUploadURLExternal", {}, { ok: true, file_id: "F3" });
    const files = JSON.stringify([{ id: "F3", title: "chart" }]);
    expect(
      ok("files.completeUploadExternal", { channel_id: "C1", thread_ts: "100.1", files })
    ).toBe(true);
    expect(
      ok("files.completeUploadExternal", { channel_id: "C2", thread_ts: "100.1", files })
    ).toBe(false);
    expect(
      ok("files.completeUploadExternal", {
        channel_id: "C1",
        thread_ts: "100.1",
        files: JSON.stringify([{ id: "F4" }]),
      })
    ).toBe(false);
  });

  it("lets a grant expire", () => {
    let now = 0;
    const grants = new Grants(() => now);
    grants.add(mention);
    now += 3 * 60 * 60_000;
    expect(
      grants.authorize("conversations.replies", { channel: "C1", ts: "100.1" }).ok
    ).toBe(false);
  });

  it("reads file ids only from Slack file URLs", () => {
    expect(fileIdOf("https://files.slack.com/files-pri/T1-F0AB/download/x.pdf")).toBe(
      "F0AB"
    );
    expect(
      fileIdOf("https://evil.example/files-pri/T1-F0AB/download/x.pdf")
    ).toBeUndefined();
    expect(fileIdOf("not a url")).toBeUndefined();
  });
});

describe("hub server", () => {
  const notices: { user: string; text: string }[] = [];
  const calls: { method: string; body: string }[] = [];
  const slack: SlackGateway = {
    async call(method, body) {
      calls.push({ method, body });
      if (method === "files.getUploadURLExternal")
        return {
          status: 200,
          json: {
            ok: true,
            file_id: "F7",
            upload_url: "https://files.slack.com/upload/v1/abc",
          },
        };
      return { status: 200, json: { ok: true, ts: "300.1", messages: [] } };
    },
    download: async () =>
      new Response("file bytes", { headers: { "content-type": "image/png" } }),
    upload: async () => new Response("OK"),
    async postEphemeral(_channel, user, text) {
      notices.push({ user, text });
    },
    userName: async (id) => (id === alice.id ? alice.name : id),
  };
  const store = new DesktopStore(path.join(root, "data", "desktops.json"));
  const hub = new HubServer({
    store,
    pairings: new Pairings(),
    slack,
    team: { id: "T1", name: "ashon" },
    log: createLogger("error", "hub", []),
  });
  let base = "";
  const token = randomBytes(32).toString("hex");
  const authed = { Authorization: `Bearer ${token}` };
  const mention = (user: string, text: string) => ({
    type: "event_callback",
    team_id: "T1",
    event: {
      type: "app_mention",
      user,
      text,
      channel: "C1",
      ts: "200.1",
      thread_ts: "100.1",
    },
  });

  beforeAll(async () => {
    base = `http://127.0.0.1:${await hub.listen(0, "127.0.0.1")}`;
  });
  afterAll(() => hub.close());

  it("pairs a desktop, routes its member's mentions to it, and proxies its Slack calls", async () => {
    const start = (await (
      await fetch(`${base}/pair/start`, {
        method: "POST",
        body: JSON.stringify({ tokenHash: sha256(token), label: "work laptop" }),
      })
    ).json()) as { pairingId: string; code: string };

    await hub.handleMention(mention(alice.id, `<@B1> connect ${start.code}`));
    expect(notices.at(-1)).toEqual({
      user: alice.id,
      text: expect.stringContaining('"work laptop"'),
    });
    expect(
      await (await fetch(`${base}/pair/status?pairingId=${start.pairingId}`)).json()
    ).toEqual({ status: "bound", user: alice });

    const confirm = await fetch(`${base}/pair/confirm`, {
      method: "POST",
      body: JSON.stringify({ pairingId: start.pairingId, token }),
    });
    expect(await confirm.json()).toEqual({
      user: alice,
      team: { id: "T1", name: "ashon" },
    });
    expect(store.byUser(alice.id)?.label).toBe("work laptop");

    // The desktop connects and receives its member's mentions.
    const ws = new WebSocket(`${base.replace("http", "ws")}/connect`, {
      headers: authed,
    });
    const messages: HubMessage[] = [];
    const next = () =>
      new Promise<HubMessage>((resolve) =>
        ws.once("message", (data) => resolve(JSON.parse(data.toString()) as HubMessage))
      );
    const ready = await next();
    messages.push(ready);
    expect(ready).toEqual({
      type: "ready",
      user: alice,
      team: { id: "T1", name: "ashon" },
    });
    expect(await (await fetch(`${base}/me`, { headers: authed })).json()).toMatchObject({
      connected: true,
    });

    const routed = next();
    await hub.handleMention(mention(alice.id, "<@B1> why is web-01 down?"));
    expect(await routed).toMatchObject({
      type: "event",
      body: { event: { text: "<@B1> why is web-01 down?" } },
    });

    // Calls inside the routed thread go to Slack; others are refused without reaching it.
    const api = (method: string, form: Record<string, string>) =>
      fetch(`${base}/api/${method}`, {
        method: "POST",
        headers: { ...authed, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }).then((res) => res.json() as Promise<Record<string, unknown>>);
    expect(
      await api("chat.postMessage", { channel: "C1", thread_ts: "100.1", text: "ok" })
    ).toMatchObject({
      ok: true,
    });
    expect(calls.at(-1)?.method).toBe("chat.postMessage");
    const before = calls.length;
    expect(
      await api("chat.postMessage", { channel: "C9", thread_ts: "1.1", text: "no" })
    ).toEqual({
      ok: false,
      error: "thread_not_granted",
    });
    expect(calls.length).toBe(before);

    // Upload URLs come back pointing at the hub.
    const upload = await api("files.getUploadURLExternal", {
      filename: "a.png",
      length: "3",
    });
    expect(upload.upload_url).toMatch(new RegExp(`^${base}/upload\\?key=[0-9a-f]{32}$`));
    const uploaded = await fetch(String(upload.upload_url), {
      method: "POST",
      headers: authed,
      body: "png",
    });
    expect(await uploaded.text()).toBe("OK");

    // Unknown tokens get nothing.
    expect((await fetch(`${base}/me`)).status).toBe(401);
    const intruder = new WebSocket(`${base.replace("http", "ws")}/connect`, {
      headers: { Authorization: `Bearer ${"0".repeat(64)}` },
    });
    await expect(
      new Promise((resolve, reject) => {
        intruder.once("open", resolve);
        intruder.once("error", reject);
      })
    ).rejects.toThrow(/401/);

    // A member without a desktop is told how to connect one.
    await hub.handleMention(mention("U0BOB", "<@B1> hello"));
    expect(notices.at(-1)).toEqual({
      user: "U0BOB",
      text: expect.stringContaining("Settings > Messengers > Slack"),
    });

    // Disconnecting unpairs the desktop and closes its connection.
    const closed = new Promise<number>((resolve) =>
      ws.once("close", (code) => resolve(code))
    );
    expect(
      (await fetch(`${base}/disconnect`, { method: "POST", headers: authed })).status
    ).toBe(200);
    expect(await closed).toBe(HUB_CLOSE.revoked);
    expect(store.byUser(alice.id)).toBeUndefined();
  });
});

describe("desktop side of the hub", () => {
  const store = new DesktopStore(path.join(root, "data2", "desktops.json"));
  const pairings = new Pairings();
  const slack: SlackGateway = {
    call: async () => ({ status: 200, json: { ok: true } }),
    download: async () => new Response(""),
    upload: async () => new Response(""),
    postEphemeral: async () => undefined,
    userName: async () => alice.name,
  };
  const hub = new HubServer({
    store,
    pairings,
    slack,
    team: { id: "T1", name: "ashon" },
    log: createLogger("error", "hub", []),
  });
  let base = "";
  beforeAll(async () => {
    base = `http://127.0.0.1:${await hub.listen(0, "127.0.0.1")}`;
  });
  afterAll(() => hub.close());

  /** Pairs a desktop through the HTTP API, as the app does, and returns its token. */
  async function pair(): Promise<string> {
    const { token, tokenHash } = newHubToken();
    const client = new HubClient(base);
    const { pairingId, code } = await client.pairStart(tokenHash, "test desktop");
    await hub.handleMention({
      event: {
        type: "app_mention",
        user: alice.id,
        text: `connect ${code}`,
        channel: "C1",
        ts: "1.1",
      },
    });
    await client.pairConfirm(pairingId, token);
    return token;
  }

  const quietLog = createLogger("error", "test", []);

  it("receives the member's mentions and hands them to Bolt", async () => {
    const token = await pair();
    const states: string[] = [];
    const processed: unknown[] = [];
    const receiver = new HubReceiver({
      url: base,
      token,
      log: quietLog,
      onState: (state) => states.push(state),
      onFatal: () => undefined,
    });
    receiver.init({
      processEvent: async (event: { body: unknown }) => void processed.push(event.body),
    } as never);
    await receiver.start();
    expect(states).toEqual(["connecting", "connected"]);

    await hub.handleMention({
      type: "event_callback",
      event: {
        type: "app_mention",
        user: alice.id,
        text: "hi",
        channel: "C1",
        ts: "5.5",
      },
    });
    await vi.waitFor(() => expect(processed).toHaveLength(1));
    expect(processed[0]).toMatchObject({ event: { text: "hi" } });

    expect(await checkHub(base, token)).toEqual([
      { label: "Hub", ok: true, detail: "Reachable" },
      { label: "Pairing", ok: true, detail: "alice (U0ALICE) @ ashon" },
      { label: "Bot", ok: true, detail: "Connected to the hub" },
    ]);

    // Unpairing from the app stops the receiver for good.
    const fatal = new Promise<Error>((resolve) => {
      (
        receiver as unknown as { options: { onFatal: (e: Error) => void } }
      ).options.onFatal = resolve;
    });
    await new HubClient(base).disconnect(token);
    expect((await fatal).message).toMatch(/hub_revoked/);
    await receiver.stop();
  });

  it("refuses to start with a token the hub does not know", async () => {
    const receiver = new HubReceiver({
      url: base,
      token: newHubToken().token,
      log: quietLog,
      onState: () => undefined,
      onFatal: () => undefined,
    });
    await expect(receiver.start()).rejects.toThrow(/hub_unauthorized/);
  });

  it("configures the bot for the hub, and says what is missing", () => {
    const token = newHubToken().token;
    const config = loadConfig({
      SLACK_CONNECTION: "hub",
      HUB_URL: "https://hub.example.com/",
      HUB_TOKEN: token,
    });
    expect(config.slack).toEqual({
      kind: "hub",
      hubUrl: "https://hub.example.com",
      hubToken: token,
    });
    expect(
      checkConfig({ SLACK_CONNECTION: "hub", HUB_URL: "https://hub.example.com" })
    ).toEqual([
      {
        key: "HUB_TOKEN",
        message: expect.stringContaining("Settings > Messengers > Slack"),
        missing: true,
      },
    ]);
    expect(
      checkConfig({
        SLACK_CONNECTION: "hub",
        HUB_URL: "http://hub.example.com",
        HUB_TOKEN: token,
      })[0]?.key
    ).toBe("HUB_URL");
    expect(
      setupProblem({ SLACK_CONNECTION: "hub", HUB_URL: "https://hub.example.com" })
    ).toMatchObject({
      kind: "slack",
      message: expect.stringContaining("not paired"),
    });
    expect(
      startFailureProblem([
        "ERROR [orbly] Startup failed: An API error occurred: hub_unauthorized",
      ])
    ).toMatchObject({
      kind: "slack",
      message: expect.stringContaining("hub_unauthorized"),
    });
  });
});
