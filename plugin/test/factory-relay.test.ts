// The link to the factory API (package 41): the hub mirrors messages, questions and states to the API, takes poll answers
// from it, registers questions with the registry, runs the registry gate, and serves buttons for clients of the hub.
// The API, the gate command and the clocks are all faked; nothing here talks to a real service.
import type { Config } from "../src/shared/config.ts";
import type { Timers } from "../src/shared/timers.ts";
import type { FactoryFetch } from "../src/hub/factory-client.ts";
import type { FactorySettings } from "../src/hub/factory-config.ts";
import type { GateRun } from "../src/hub/factory-gate.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { Hub } from "../src/hub/hub.ts";
import { TelegramApi } from "../src/hub/telegram.ts";
import { ButtonStore } from "../src/hub/factory-buttons.ts";
import { FactoryClient } from "../src/hub/factory-client.ts";
import { parseButtonKeys, parseFactorySettings } from "../src/hub/factory-config.ts";
import { runGate } from "../src/hub/factory-gate.ts";
import { FACTORY_STATES, PROMPT_HANDLING } from "../src/hub/factory-prompts.ts";
import { FactoryQueue } from "../src/hub/factory-queue.ts";
import { FactoryRelay } from "../src/hub/factory-relay.ts";
import { arr, field } from "../src/shared/guards.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { en } from "../src/shared/i18n/en.ts";
import { platformFor } from "../src/shared/platform.ts";
import { noAttemptTimeouts } from "./api-timers.ts";
import { FakeExec } from "./fake-exec.ts";
import { buttonPress, FakeTelegram } from "./fake-telegram.ts";
import { hubFetch, memLogger, must, NO_PACE, tempDir, waitFor, wsClient } from "./helpers.ts";
import { manualClock } from "./manual-clock.ts";

const GROUP = "-1001";
const ME = "123456789";
const CWD = join(import.meta.dir, "..", "..");
const DEFAULT_DIR = "C:\\Users\\me\\.claude";
const PROFILE = "C:\\Users\\me\\.claude-swap-backup\\sessions\\2-me_gmail.com";
const READY_DELAY_MS = 50;
const WAIT_MS = 5000;
// A poll-answer tick that real timers can use in a test: the only tests that wait for it are the ones about answers.
const FAST_TICK_MS = 20;

// Invented values; no real token or address.
const API = { url: "http://factory.test", hubToken: "hub-secret", relayToken: "relay-secret", pollAnswerIntervalMs: 60_000, requestTimeoutMs: 10_000, registryTimeoutMs: 3_000 };
const GATE = { command: ["gate", "{inquiry_id}"], timeoutMs: 3_000 };
const BUTTONS = { keys: { alpha: "key-alpha", beta: "key-beta" }, pressWindowMs: 600_000 };
const FULL: FactorySettings = { api: API, gate: GATE, buttons: BUTTONS };
const FAST: FactorySettings = { ...FULL, api: { ...API, pollAnswerIntervalMs: FAST_TICK_MS } };

const Q1 = { question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "" }], multiSelect: false };
const Q1_TEXT = "Color\nWhich color?\n\n1. Red \u2014 warm\n2. Blue";

// --- the faked factory API --------------------------------------------------------------------------------------------

type Call = { method: string; path: string; headers: Headers; body: unknown; status: number };

class FakeFactory {
  calls: Call[] = [];
  down = false;
  registry: "ok" | number = "ok";
  answers: { id: string; poll_id: string; answer_key: string }[] = [];
  private failures: { method: string; prefix: string; status: number; times: number }[] = [];
  private resulted = new Set<string>();
  private ids = new Map<string, string>();
  private seen = new Set<string>();
  private captured = new Set<string>();
  private registered = 0;

  fail(method: string, prefix: string, status: number, times: number): void {
    this.failures.push({ method, prefix, status, times });
  }

  of(method: string, prefix: string): Call[] {
    return this.calls.filter(call => call.method === method && call.path.startsWith(prefix));
  }

  idOf(key: string): string {
    const known = this.ids.get(key);
    if (known) return known;
    const id = `p${this.ids.size + 1}`;
    this.ids.set(key, id);
    return id;
  }

  fetch: FactoryFetch = async (url, init) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const path = target.pathname + target.search;
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call: Call = { method, path, headers: new Headers(init.headers), body, status: 0 };
    this.calls.push(call);
    if (this.down) throw new Error("connection refused");
    const reply = (status: number, json: unknown) => {
      call.status = status;
      return new Response(JSON.stringify(json), { status });
    };
    const failure = this.failures.find(f => f.times > 0 && f.method === method && path.startsWith(f.prefix));
    if (failure) {
      failure.times -= 1;
      return reply(failure.status, { error: "unavailable" });
    }
    const key = String(field(body, "key") ?? "");
    if (method === "POST" && (path === "/hub/messages" || path === "/hub/states")) return reply(this.firstTime(key) ? 201 : 200, { key });
    if (method === "POST" && path === "/hub/polls") {
      const fresh = this.firstTime(key);
      return reply(fresh ? 201 : 200, { id: this.idOf(key), key });
    }
    if (method === "POST" && /^\/hub\/polls\/[^/]+\/result$/.test(path)) return reply(200, {});
    if (method === "POST" && path === "/registry/polls") {
      if (this.registry !== "ok") return reply(this.registry, { error: "registry" });
      this.registered += 1;
      return reply(201, { poll_id: `rp${this.registered}`, display_line: "[R-1] Registry says: check" });
    }
    if (method === "POST" && path === "/registry/captures") {
      const pressId = String(field(body, "press_id"));
      if (this.captured.has(pressId)) return reply(409, { error: "press_replayed" });
      this.captured.add(pressId);
      return reply(201, {});
    }
    if (method === "GET" && path.startsWith("/hub/poll-answers")) return reply(200, { items: this.answers.filter(a => !this.resulted.has(a.id)).map(a => ({ ...a, state: "pending" })) });
    const result = path.match(/^\/hub\/poll-answers\/([^/]+)\/result$/);
    if (method === "POST" && result?.[1]) {
      this.resulted.add(decodeURIComponent(result[1]));
      return reply(200, {});
    }
    return reply(404, { error: "not_found" });
  };

  private firstTime(key: string): boolean {
    const had = this.seen.has(key);
    this.seen.add(key);
    return !had;
  }
}

// The gate command, faked: what it was run with goes into the factory's call list so tests can check the order.
class FakeGate {
  runs: { argv: string[]; input: unknown }[] = [];
  result: { code: number; stdout: string } | Error = { code: 0, stdout: JSON.stringify({ pass: true }) };

  constructor(private factory: FakeFactory) {}

  run: GateRun = async (argv, input) => {
    const parsed: unknown = JSON.parse(input);
    this.runs.push({ argv, input: parsed });
    this.factory.calls.push({ method: "GATE", path: argv.join(" "), headers: new Headers(), body: parsed, status: 0 });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  };
}

// --- the hub under test ------------------------------------------------------------------------------------------------

type Clock = ReturnType<typeof manualClock>;

let fake: FakeTelegram;
let hub: Hub;
let port: number;
let dir: string;
let config: Config;
let log: ReturnType<typeof memLogger>;
let factory: FakeFactory;
let gate: FakeGate;
const clients: { close(): void }[] = [];
const clocks: Clock[] = [];
let reqId = 0;

function newClock(): Clock {
  const clock = manualClock();
  clocks.push(clock);
  return clock;
}

function startHub(settings?: FactorySettings, timers?: Timers): void {
  hub = new Hub({
    platform: platformFor("win32"),
    accountsAvailable: () => true,
    port: 0,
    sessionsFile: join(dir, "sessions.json"),
    outboxFile: join(dir, "outbox.json"),
    cardsFile: join(dir, "cards.json"),
    spoolDir: join(dir, "spool"),
    spoolScanMs: 50,
    filesDir: join(dir, "outbox-files"),
    inboxDir: join(dir, "inbox"),
    api: new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, networkRetryMs: 5, deadlineMs: 500, groupPace: NO_PACE, timers: noAttemptTimeouts }),
    config: () => config,
    idleMs: 60_000,
    pollTimeoutSec: 1,
    pollRetryBaseMs: 10,
    sendRetryBaseMs: 10,
    sendRetryMaxMs: 50,
    cardEditMs: 50,
    cardGapMs: 0,
    typingEveryMs: 50,
    reactionDelayMs: 50,
    readyDelayMs: READY_DELAY_MS,
    batchQuietMs: 5,
    catchUpMs: 20,
    ...(timers ? { timers } : {}),
    defaultConfigDir: DEFAULT_DIR,
    defaultAccount: async () => undefined,
    execRunsFile: join(dir, "exec-runs.json"),
    execClient: new FakeExec(),
    execCheckMs: 20,
    execCardMs: 100,
    execGraceMs: 300,
    ...(settings ? { factory: settings } : {}),
    factoryFetch: factory.fetch,
    factoryGate: gate.run,
    log,
    onExit: () => {},
  });
  if (!hub.start()) throw new Error("hub did not start");
  port = hub.port;
}

const hello = (sessionId: string) => ({ type: "hello", v: PROTOCOL_VERSION, windowKey: `win-${sessionId}`, sessionId, cwd: CWD, configDir: PROFILE, reportsSeen: true });

async function plugin(sessionId: string) {
  const c = await wsClient(port, hello(sessionId));
  clients.push(c);
  await c.next("state");
  return c;
}

async function req(c: Awaited<ReturnType<typeof plugin>>, body: object) {
  const id = `r${++reqId}`;
  c.send({ type: "req", id, ...body });
  return c.next("res", m => m.id === id, WAIT_MS);
}

async function enabled(sessionId: string) {
  const c = await plugin(sessionId);
  expect((await req(c, { op: "enable", title: "Title" })).ok).toBe(true);
  return c;
}

function ask(sessionId: string, questions: unknown[], inquiry?: string): Promise<unknown> {
  const body = { messagingSocket: `win-${sessionId}`, session_id: sessionId, tool_use_id: "tu-1", tool_input: { questions, ...(inquiry ? { metadata: { source: inquiry } } : {}) } };
  return fetch(`http://127.0.0.1:${port}/question`, { method: "POST", body: JSON.stringify(body) }).then(r => r.json()).catch(e => String(e));
}

const rows = (params: unknown) => arr(field(field(params, "reply_markup"), "inline_keyboard")).map(arr);
const dataOf = (params: unknown, row: number, col = 0) => String(field(rows(params)[row][col], "callback_data"));
const polled = (n = 1) => waitFor(() => fake.callsOf("sendMessage")[n - 1], WAIT_MS, `Telegram message ${n}`);
const press = (data: string, fromId = ME) => fake.pushUpdate(buttonPress({ chatId: GROUP, fromId, messageId: fake.lastMessageId, data }));
const pollKey = (i = 0) => String(field(factory.of("POST", "/hub/polls")[i].body, "key")).split(":")[1];
const warned = (text: string) => log.lines.some(line => line.startsWith("WARN") && line.includes(text));
const sentOf = (c: Awaited<ReturnType<typeof plugin>>, id: string, text: string) => c.send({ type: "send", id, sessionId: "a", text, notify: false });

beforeEach(() => {
  fake = new FakeTelegram();
  dir = tempDir();
  config = { groupId: GROUP, allowFrom: [ME], turnEndChime: "" };
  log = memLogger();
  factory = new FakeFactory();
  gate = new FakeGate(factory);
  reqId = 0;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await hub?.stop();
  for (const c of clocks.splice(0)) c.dispose();
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

// --- configuration ----------------------------------------------------------------------------------------------------

describe("configuration", () => {
  test("nothing configured gives no settings", () => {
    expect(parseFactorySettings({}, {})).toBeUndefined();
    expect(parseFactorySettings(undefined, {})).toBeUndefined();
  });

  test("the API needs both the URL and the hub token; a trailing slash goes; the relay token is optional", () => {
    expect(parseFactorySettings({}, { TELEGRAM_HUB_FACTORY_URL: "http://f.test/" })).toBeUndefined();
    expect(parseFactorySettings({}, { TELEGRAM_HUB_FACTORY_HUB_TOKEN: "t" })).toBeUndefined();
    const api = parseFactorySettings({}, { TELEGRAM_HUB_FACTORY_URL: "http://f.test//", TELEGRAM_HUB_FACTORY_HUB_TOKEN: "t" })?.api;
    expect(api?.url).toBe("http://f.test");
    expect(api?.hubToken).toBe("t");
    expect(api?.relayToken).toBeUndefined();
    const both = parseFactorySettings({}, { TELEGRAM_HUB_FACTORY_URL: "http://f.test", TELEGRAM_HUB_FACTORY_HUB_TOKEN: "t", TELEGRAM_HUB_FACTORY_RELAY_TOKEN: "r" })?.api;
    expect(both?.relayToken).toBe("r");
  });

  test("the gate needs a command; the button keys come from the environment only", () => {
    expect(parseFactorySettings({ gate: { command: [] } }, {})).toBeUndefined();
    const gated = parseFactorySettings({ gate: { command: ["g", "{inquiry_id}", 5, ""], timeoutMs: 1500 } }, {});
    expect(gated?.gate).toEqual({ command: ["g", "{inquiry_id}"], timeoutMs: 1500 });
    const buttons = parseFactorySettings({ pressWindowMs: 1000 }, { TELEGRAM_HUB_BUTTON_KEYS: "alpha=k1, beta=k2" })?.buttons;
    expect(buttons).toEqual({ keys: { alpha: "k1", beta: "k2" }, pressWindowMs: 1000 });
  });

  test("a malformed button key pair is skipped", () => {
    expect(parseButtonKeys("alpha=k1,broken,=nokey,noname=,  beta = k2 ")).toEqual({ alpha: "k1", beta: "k2" });
  });

  test("a tool permission and a look-alike text are never served as a poll", () => {
    expect(PROMPT_HANDLING["tool-permission"]).toEqual({ served: false, factory: "state" });
    expect(PROMPT_HANDLING["lookalike-text"]).toEqual({ served: false, factory: "message" });
    expect(PROMPT_HANDLING["session-poll"].served).toBe(true);
    expect([...FACTORY_STATES]).toEqual(["active", "waiting", "permission_wait", "ended"]);
  });
});

// --- not configured: unchanged ------------------------------------------------------------------------------------------

describe("not configured", () => {
  test("the hub behaves as before and never touches the factory", async () => {
    startHub(undefined);
    const a = await enabled("a");
    sentOf(a, "s1", "hello");
    await a.next("ack");
    a.send({ type: "permission", requestId: "r1", toolName: "Bash", description: "d", inputPreview: "i" });
    await waitFor(() => fake.texts().length >= 2, WAIT_MS, "the message and the permission prompt");
    const answer = ask("a", [Q1], "inq-1");
    const msg = await waitFor(() => fake.callsOf("sendMessage").find(call => String(field(call, "text")).includes("Which color?")), WAIT_MS, "the question");
    expect(String(field(msg, "text"))).toBe(Q1_TEXT);
    press(dataOf(msg, 1));
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Blue" } });
    expect(factory.calls).toEqual([]);
    expect(gate.runs).toEqual([]);
    expect(existsSync(join(dir, "factory-queue.json"))).toBe(false);
    expect(existsSync(join(dir, "buttons.json"))).toBe(false);
  });

  test("the button routes are as unknown as before, and a button of the factory is stale", async () => {
    startHub(undefined);
    const response = await hubFetch(hub, "/buttons/send", { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
    const before = fake.callsOf("answerCallbackQuery").length;
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: 5, data: "b:abc" }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").length > before, WAIT_MS, "the answer to the press");
    expect(fake.callsOf("answerCallbackQuery")[before]).toMatchObject({ text: en.permissionStale });
  });
});

// --- hub-key ---------------------------------------------------------------------------------------------------------------

describe("hub-key", () => {
  test("a message is posted once under its own key, with the hub token", async () => {
    startHub(FULL);
    const a = await enabled("a");
    sentOf(a, "s1", "first");
    sentOf(a, "s1", "first");
    sentOf(a, "s2", "second");
    await waitFor(() => factory.of("POST", "/hub/messages").length >= 2, WAIT_MS, "both messages");
    const posts = factory.of("POST", "/hub/messages");
    expect(posts.map(p => p.body)).toEqual([
      { session_ref: "a", key: "msg:s1", kind: "text", content: { text: "first" } },
      { session_ref: "a", key: "msg:s2", kind: "text", content: { text: "second" } },
    ]);
    expect(posts[0].headers.get("authorization")).toBe("Bearer hub-secret");
  });

  test("an item the API refuses is dropped, not retried forever; one it cannot take yet is kept and sent later", async () => {
    startHub(FULL);
    const a = await enabled("a");
    factory.fail("POST", "/hub/messages", 503, 1);
    sentOf(a, "s1", "first");
    await a.next("ack");
    await waitFor(() => factory.of("POST", "/hub/messages").length >= 1, WAIT_MS, "the first try");
    expect(factory.of("POST", "/hub/messages")[0].status).toBe(503);
    expect(warned("not accepted (503)")).toBe(true);
    // The queue is flushed again by the next record (and by the poll tick); nothing is lost meanwhile.
    sentOf(a, "s2", "second");
    await waitFor(() => factory.of("POST", "/hub/messages").some(p => p.status === 201), WAIT_MS, "the delivery");
    const delivered = factory.of("POST", "/hub/messages").filter(p => p.status === 201).map(p => field(p.body, "key"));
    expect(delivered).toEqual(["msg:s1", "msg:s2"]);
  });

  test("a question is mirrored as a poll under a key of its own and its answer as the poll's result", async () => {
    startHub(FULL);
    await enabled("a");
    const answer = ask("a", [Q1]);
    const msg = await polled();
    press(dataOf(msg, 1));
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Blue" } });
    await waitFor(() => factory.of("POST", "/hub/polls/p1/result").length >= 1, WAIT_MS, "the result");
    const posted = factory.of("POST", "/hub/polls")[0];
    expect(posted.body).toEqual({
      session_ref: "a",
      key: `poll:${pollKey()}:0`,
      kind: "poll",
      content: { question: "Which color?", header: "Color", multi_select: false, options: [{ key: "0", label: "Red" }, { key: "1", label: "Blue" }] },
    });
    expect(factory.of("POST", "/hub/polls/p1/result")[0].body).toEqual({ answer_key: "1", answered_via: "telegram" });
    expect(factory.of("POST", "/hub/polls/p1/result")[0].headers.get("authorization")).toBe("Bearer hub-secret");
  });
});

// --- hub-once ----------------------------------------------------------------------------------------------------------------

describe("hub-once", () => {
  test("an answer from the factory is applied once, however often its result has to be sent", async () => {
    startHub(FAST);
    await enabled("a");
    const answer = ask("a", [Q1]);
    await polled();
    const id = fake.lastMessageId;
    await waitFor(() => factory.of("POST", "/hub/polls").some(p => p.status === 201), WAIT_MS, "the poll");
    factory.fail("POST", "/hub/poll-answers/a1/result", 503, 2);
    factory.answers.push({ id: "a1", poll_id: "p1", answer_key: "1" });
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Blue" } });
    await waitFor(() => factory.of("POST", "/hub/poll-answers/a1/result").some(c => c.status === 200), WAIT_MS, "the accepted result");
    const results = factory.of("POST", "/hub/poll-answers/a1/result");
    expect(results.filter(c => c.status === 200)).toHaveLength(1);
    for (const result of results) expect(result.body).toEqual({ state: "accepted", hub_ref: `${pollKey()}:0` });
    expect(fake.callsOf("editMessageText").filter(call => field(call, "message_id") === id)).toHaveLength(1);
    // It is not mirrored back as a result: the factory has the answer already.
    expect(factory.of("POST", "/hub/polls/p1/result")).toEqual([]);
    // More ticks do not apply the answer again.
    const seen = factory.of("GET", "/hub/poll-answers").length;
    await waitFor(() => factory.of("GET", "/hub/poll-answers").length >= seen + 2, WAIT_MS, "two more ticks");
    expect(factory.of("POST", "/hub/poll-answers/a1/result").filter(c => c.status === 200)).toHaveLength(1);
  });

  test("an invalid answer is refused and the poll stays open; a closed or unknown poll is refused as closed", async () => {
    startHub(FAST);
    await enabled("a");
    const answer = ask("a", [Q1]);
    const msg = await polled();
    await waitFor(() => factory.of("POST", "/hub/polls").some(p => p.status === 201), WAIT_MS, "the poll");
    factory.answers.push({ id: "bad", poll_id: "p1", answer_key: "7" }, { id: "ghost", poll_id: "p99", answer_key: "0" });
    await waitFor(() => factory.of("POST", "/hub/poll-answers/ghost/result").length >= 1 && factory.of("POST", "/hub/poll-answers/bad/result").length >= 1, WAIT_MS, "both refusals");
    expect(factory.of("POST", "/hub/poll-answers/bad/result")[0].body).toEqual({ state: "refused", refusal_reason: "invalid_answer" });
    expect(factory.of("POST", "/hub/poll-answers/ghost/result")[0].body).toEqual({ state: "refused", refusal_reason: "poll_closed" });
    press(dataOf(msg, 0));
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Red" } });
    factory.answers.push({ id: "late", poll_id: "p1", answer_key: "1" });
    await waitFor(() => factory.of("POST", "/hub/poll-answers/late/result").length >= 1, WAIT_MS, "the late refusal");
    expect(factory.of("POST", "/hub/poll-answers/late/result")[0].body).toEqual({ state: "refused", refusal_reason: "poll_closed" });
  });
});

// --- button-replay ------------------------------------------------------------------------------------------------------------

describe("button-replay", () => {
  const sendBody = (key = "k1", id = "pr-1", text = "Approve draft?") => ({ chat: GROUP, key, text, buttons: [{ id, draftId: "d-1", text: "Approve" }] });
  const post = (client: string | undefined, secret: string | undefined, body: unknown) => hubFetch(hub, "/buttons/send", {
    method: "POST",
    headers: { ...(client ? { "x-hub-client": client } : {}), ...(secret ? { "x-hub-client-key": secret } : {}) },
    body: JSON.stringify(body),
  });
  const get = (path: string, client = "alpha", secret = "key-alpha", method = "GET") => hubFetch(hub, path, { method, headers: { "x-hub-client": client, "x-hub-client-key": secret } });

  test("a send is idempotent on its key, a different payload under the key is refused, a reused press id is refused", async () => {
    startHub(FULL);
    const first = await post("alpha", "key-alpha", sendBody());
    expect(first.status).toBe(201);
    const message = String(field(await first.json(), "message"));
    const again = await post("alpha", "key-alpha", sendBody());
    expect(again.status).toBe(200);
    expect(field(await again.json(), "message")).toBe(message);
    expect((await post("alpha", "key-alpha", sendBody("k1", "pr-1", "Another text"))).status).toBe(409);
    const reused = await post("alpha", "key-alpha", sendBody("k2", "pr-1"));
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ error: "press_replayed", press_id: "pr-1" });
    // The message went to Telegram once, with one button.
    const sent = await waitFor(() => fake.callsOf("sendMessage").find(call => String(field(call, "text")) === "Approve draft?"), WAIT_MS, "the button message");
    expect(rows(sent)).toHaveLength(1);
    expect(fake.callsOf("sendMessage").filter(call => String(field(call, "text")) === "Approve draft?")).toHaveLength(1);
  });

  test("a wrong, missing or foreign key is refused; so is a chat other than the group", async () => {
    startHub(FULL);
    expect((await post(undefined, undefined, sendBody())).status).toBe(401);
    expect((await post("alpha", "wrong", sendBody())).status).toBe(401);
    expect((await post("alpha", "key-beta", sendBody())).status).toBe(401);
    expect((await post("nobody", "key-alpha", sendBody())).status).toBe(401);
    expect((await post("alpha", "key-alpha", { ...sendBody(), chat: "-999" })).status).toBe(403);
    expect((await post("alpha", "key-alpha", { chat: GROUP })).status).toBe(400);
    expect(fake.callsOf("sendMessage")).toEqual([]);
  });

  test("a button is taken once: the first press is accepted, the second is refused", async () => {
    startHub(FULL);
    await post("alpha", "key-alpha", sendBody());
    const msg = await polled();
    const data = dataOf(msg, 0);
    expect(data.startsWith("b:")).toBe(true);
    press(data);
    await waitFor(() => fake.callsOf("answerCallbackQuery").length >= 1, WAIT_MS, "the first answer");
    press(data);
    await waitFor(() => fake.callsOf("answerCallbackQuery").length >= 2, WAIT_MS, "the second answer");
    expect(fake.callsOf("answerCallbackQuery").map(call => field(call, "text"))).toEqual([en.buttonAccepted, en.buttonRefused]);
    const list = await (await get("/buttons/presses")).json();
    expect(list).toMatchObject({ items: [{ press_id: "pr-1", draft_id: "d-1", telegram_user_id: ME }] });
    expect(arr(field(list, "items"))).toHaveLength(1);
  });

  test("a press by someone who may not press does not take the button", async () => {
    startHub(FULL);
    await post("alpha", "key-alpha", sendBody());
    const data = dataOf(await polled(), 0);
    press(data, "999");
    await waitFor(() => fake.callsOf("answerCallbackQuery").length >= 1, WAIT_MS, "the stranger's answer");
    expect(await (await get("/buttons/presses")).json()).toEqual({ items: [] });
    press(data, ME);
    await waitFor(() => fake.callsOf("answerCallbackQuery").length >= 2, WAIT_MS, "the owner's answer");
    // The hub's own allow-list drops the stranger's press without a text; the owner's press is the one accepted.
    expect(fake.callsOf("answerCallbackQuery").map(call => field(call, "text"))).toEqual([undefined, en.buttonAccepted]);
    const list = await (await get("/buttons/presses")).json();
    expect(arr(field(list, "items")).map(item => field(item, "telegram_user_id"))).toEqual([ME]);
  });

  test("a client reads and acknowledges its own presses only", async () => {
    startHub(FULL);
    await post("alpha", "key-alpha", sendBody());
    press(dataOf(await polled(), 0));
    await waitFor(() => fake.callsOf("answerCallbackQuery").length >= 1, WAIT_MS, "the answer");
    const item = must(arr(field(await (await get("/buttons/presses")).json(), "items"))[0], "a press");
    const seq = String(field(item, "seq"));
    expect(arr(field(await (await get("/buttons/presses", "beta", "key-beta")).json(), "items"))).toEqual([]);
    expect((await get(`/buttons/presses/${seq}/ack`, "beta", "key-beta", "POST")).status).toBe(404);
    expect((await get(`/buttons/presses/${seq}/ack`, "alpha", "wrong", "POST")).status).toBe(401);
    const ack = await get(`/buttons/presses/${seq}/ack`, "alpha", "key-alpha", "POST");
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ ok: true });
    expect(arr(field(await (await get("/buttons/presses")).json(), "items"))).toEqual([]);
  });

  test("the store: a press is expired after its window, unknown for a token it never gave, and used across a restart", async () => {
    const clock = newClock();
    const file = join(dir, "buttons.json");
    const warnings: string[] = [];
    const store = new ButtonStore(file, BUTTONS, text => warnings.push(text), clock);
    const created = store.register("alpha", { chat: GROUP, key: "k1", text: "t", buttons: [{ id: "p1", draftId: "d", text: "A" }, { id: "p2", draftId: "d", text: "B" }] });
    if (created.kind !== "created") throw new Error("not created");
    const [first, second] = created.buttons.map(row => row[0].data.slice(2));
    expect(store.press("nope", ME)).toEqual({ ok: false, reason: "unknown" });
    expect(store.press(first, ME)).toEqual({ ok: true });
    expect(new ButtonStore(file, BUTTONS, text => warnings.push(text), clock).press(first, ME)).toEqual({ ok: false, reason: "used" });
    await clock.advance(BUTTONS.pressWindowMs + 1);
    expect(store.press(second, ME)).toEqual({ ok: false, reason: "expired" });
    expect(store.presses("alpha")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

// --- client-foreign-prompt ----------------------------------------------------------------------------------------------------

describe("client-foreign-prompt", () => {
  test("a tool permission prompt reaches the factory as a bare state and nothing else", async () => {
    startHub(FULL);
    const a = await enabled("a");
    a.send({ type: "permission", requestId: "r1", toolName: "Bash", description: "SECRET-DESC", inputPreview: "SECRET-INPUT" });
    await waitFor(() => fake.texts().length === 1, WAIT_MS, "the permission prompt");
    await waitFor(() => factory.of("POST", "/hub/states").length >= 1, WAIT_MS, "the state");
    const prompt = fake.callsOf("sendMessage")[0];
    const allow = String(field(arr(arr(field(field(prompt, "reply_markup"), "inline_keyboard"))[0])[0], "callback_data"));
    press(allow);
    await a.next("permissionReply");
    await waitFor(() => factory.of("POST", "/hub/states").length >= 2, WAIT_MS, "the state after the answer");
    const states = factory.of("POST", "/hub/states").map(call => call.body);
    expect(states.map(body => field(body, "content"))).toEqual([{ state: "permission_wait" }, { state: "active" }]);
    expect(states.map(body => field(body, "kind"))).toEqual(["state", "state"]);
    expect(factory.of("POST", "/hub/polls")).toEqual([]);
    expect(factory.of("POST", "/hub/messages")).toEqual([]);
    expect(JSON.stringify(factory.calls.map(call => call.body))).not.toContain("SECRET");
  });

  test("a text that looks like an approval prompt is an ordinary message, with no poll and no buttons", async () => {
    startHub(FULL);
    const a = await enabled("a");
    const lookalike = "Allow this tool to run? Reply 1 to approve, 2 to deny.";
    sentOf(a, "s9", lookalike);
    await waitFor(() => factory.of("POST", "/hub/messages").length >= 1, WAIT_MS, "the message");
    expect(factory.of("POST", "/hub/messages")[0].body).toEqual({ session_ref: "a", key: "msg:s9", kind: "text", content: { text: lookalike } });
    expect(factory.of("POST", "/hub/polls")).toEqual([]);
    await waitFor(() => fake.texts().length >= 1, WAIT_MS, "the Telegram message");
    expect(field(fake.callsOf("sendMessage")[0], "reply_markup")).toBeUndefined();
    expect(gate.runs).toEqual([]);
  });
});

// --- the gate and the registry ------------------------------------------------------------------------------------------------

describe("registry gate and poll registration", () => {
  test("the gate runs first, with the inquiry id, and a passing question is then registered and shown with its line", async () => {
    startHub(FULL);
    await enabled("a");
    const answer = ask("a", [Q1], "inq-1");
    const msg = await polled();
    expect(gate.runs).toHaveLength(1);
    expect(gate.runs[0].argv).toEqual(["gate", "inq-1"]);
    expect(gate.runs[0].input).toMatchObject({ session_id: "a", tool_use_id: "tu-1", tool_input: { metadata: { source: "inq-1" } } });
    const order = factory.calls.map(call => `${call.method} ${call.path}`);
    expect(order.indexOf("GATE gate inq-1")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("GATE gate inq-1")).toBeLessThan(order.indexOf("POST /registry/polls"));
    const registered = factory.of("POST", "/registry/polls")[0];
    expect(registered.body).toEqual({ inquiry_id: "inq-1", question: "Which color?", options: [{ key: "0", label: "Red" }, { key: "1", label: "Blue" }] });
    expect(registered.headers.get("authorization")).toBe("Bearer relay-secret");
    expect(String(field(msg, "text"))).toBe(`[R-1] Registry says: check\n${Q1_TEXT}`);
    // The Telegram press is captured for the registry, once, under an id derived from the callback.
    press(dataOf(msg, 1));
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Blue" } });
    await waitFor(() => factory.of("POST", "/registry/captures").length >= 1, WAIT_MS, "the capture");
    const capture = factory.of("POST", "/registry/captures")[0];
    expect(capture.body).toMatchObject({ telegram_user_id: ME, poll_id: "rp1", option_index: 1 });
    const pressId = String(field(capture.body, "press_id"));
    expect(pressId).toMatch(/^tg:cq\d+$/);
    expect(capture.headers.get("idempotency-key")).toBe(pressId);
    expect(capture.headers.get("authorization")).toBe("Bearer relay-secret");
    // The shown outcome keeps the line.
    const edit = await waitFor(() => fake.callsOf("editMessageText").at(-1), WAIT_MS, "the outcome edit");
    expect(String(field(edit, "text"))).toBe(`[R-1] Registry says: check\n${Q1_TEXT}\n\n\u2705 Blue`);
  });

  test("a refusing gate denies the question with its reason and the found records; nothing is shown or registered", async () => {
    startHub(FULL);
    await enabled("a");
    gate.result = { code: 0, stdout: JSON.stringify({ pass: false, reason: "Duplicate of inquiry I-7", records: [{ id: "I-7" }] }) };
    expect(await ask("a", [Q1], "inq-1")).toEqual({ decision: "deny", reason: 'Duplicate of inquiry I-7\n[{"id":"I-7"}]' });
    expect(fake.callsOf("sendMessage")).toEqual([]);
    expect(factory.of("POST", "/registry/polls")).toEqual([]);
    expect(factory.of("POST", "/hub/polls")).toEqual([]);
  });

  test("registry-fail-open: a gate that fails lets the question through", async () => {
    startHub(FULL);
    await enabled("a");
    gate.result = new Error("spawn failed");
    const answer = ask("a", [Q1], "inq-1");
    press(dataOf(await polled(), 1));
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Blue" } });
    expect(warned("gate command failed")).toBe(true);
  });

  test("registry-fail-open: a registry that is down or refuses leaves the question as it is", async () => {
    startHub(FULL);
    await enabled("a");
    factory.registry = 500;
    const answer = ask("a", [Q1], "inq-1");
    const msg = await polled();
    expect(String(field(msg, "text"))).toBe(Q1_TEXT);
    expect(warned("registry poll not registered (500)")).toBe(true);
    press(dataOf(msg, 1));
    await answer;
    // A question the registry never took has nothing to capture.
    await waitFor(() => factory.of("POST", "/hub/polls/p1/result").length >= 1, WAIT_MS, "the result");
    expect(factory.of("POST", "/registry/captures")).toEqual([]);
  });

  test("a question without an inquiry id is not registered", async () => {
    startHub(FULL);
    await enabled("a");
    const answer = ask("a", [Q1]);
    const msg = await polled();
    expect(String(field(msg, "text"))).toBe(Q1_TEXT);
    expect(factory.of("POST", "/registry/polls")).toEqual([]);
    press(dataOf(msg, 0));
    await answer;
  });
});

// --- the pieces ---------------------------------------------------------------------------------------------------------------

describe("the queue", () => {
  const item = (id: string, extra: object = {}) => ({ id, path: `/hub/${id}`, token: "hub" as const, body: { id }, ...extra });

  test("records go in order, leave on 201, and are never posted twice", async () => {
    const clock = newClock();
    const sent: string[] = [];
    const queue = new FactoryQueue(join(dir, "q.json"), () => {}, clock);
    queue.post(item("a"));
    queue.post(item("b"));
    queue.post(item("a"));
    expect(queue.size).toBe(2);
    await queue.flush(async i => { sent.push(i.id); return { status: 201, json: {} }; });
    expect(sent).toEqual(["a", "b"]);
    expect(queue.size).toBe(0);
    queue.post(item("a"));
    expect(queue.size).toBe(0);
  });

  test("a failure keeps the record and stops; a refusal drops it; the file survives a restart", async () => {
    const clock = newClock();
    const warnings: string[] = [];
    const file = join(dir, "q.json");
    const queue = new FactoryQueue(file, text => warnings.push(text), clock);
    queue.post(item("a"));
    queue.post(item("b"));
    await queue.flush(async () => { throw new Error("down"); });
    expect(queue.size).toBe(2);
    expect(warnings[0]).toContain("a not sent, will retry");
    await queue.flush(async () => ({ status: 503, json: undefined }));
    expect(queue.size).toBe(2);
    expect(warnings[1]).toContain("a not accepted (503)");
    expect(new FactoryQueue(file, () => {}, clock).size).toBe(2);
    await queue.flush(async i => (i.id === "a" ? { status: 400, json: {} } : { status: 201, json: {} }));
    expect(queue.size).toBe(0);
    expect(warnings.some(w => w.includes("a dropped, the API refused it (400)"))).toBe(true);
    queue.post(item("a"));
    expect(queue.size).toBe(0);
  });

  test("a later record names the stored poll by its key; one whose poll was never stored is dropped", async () => {
    const clock = newClock();
    const warnings: string[] = [];
    const queue = new FactoryQueue(join(dir, "q.json"), text => warnings.push(text), clock);
    queue.post(item("poll", { path: "/hub/polls", remember: "k1:0" }));
    queue.post({ id: "result", path: "/hub/polls/{poll:k1:0}/result", token: "hub" });
    queue.post({ id: "orphan", path: "/hub/polls/{poll:never}/result", token: "hub" });
    const paths: string[] = [];
    await queue.flush(async i => { paths.push(i.path); return { status: 201, json: { id: "p9" } }; });
    expect(paths).toEqual(["/hub/polls", "/hub/polls/p9/result"]);
    expect(warnings).toEqual(["factory queue: orphan dropped, its poll was never stored"]);
    expect(queue.apiId("k1:0")).toBe("p9");
    expect(queue.keyOfApiId("p9")).toBe("k1:0");
  });
});

describe("the client", () => {
  test("it sends the token, the body and the idempotency key to the configured URL", async () => {
    const clock = newClock();
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new FactoryClient({ ...API, url: "http://f.test" }, clock, async (url, init) => { seen.push({ url, init }); return new Response("{\"ok\":true}", { status: 201 }); });
    expect(await client.request("POST", "/x", "relay", { a: 1 }, "idem")).toEqual({ status: 201, json: { ok: true } });
    expect(seen[0].url).toBe("http://f.test/x");
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.body).toBe("{\"a\":1}");
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer relay-secret");
    expect(headers.get("idempotency-key")).toBe("idem");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("a token that is not configured is an error, and a call that hangs is cut off by the timer", async () => {
    const clock = newClock();
    const { relayToken: _drop, ...noRelay } = API;
    const none = new FactoryClient(noRelay, clock, async () => new Response("{}"));
    expect(none.canRegister).toBe(false);
    await expect(none.request("GET", "/x", "relay")).rejects.toThrow("no relay token configured");
    const hanging = new FactoryClient(API, clock, () => new Promise<Response>(() => {}));
    const outcome = hanging.request("GET", "/slow", "hub").then(() => "ok", e => String(e));
    await clock.advance(API.requestTimeoutMs);
    expect(await outcome).toContain("/slow timed out");
  });
});

describe("the gate runner", () => {
  const input = { sessionId: "s", toolUseId: "t", toolInput: { metadata: { source: " inq-9 " } } };
  const run = (result: { code: number; stdout: string }): GateRun => async () => result;

  test("pass, refusal with records, and the placeholders of the command", async () => {
    const clock = newClock();
    const warnings: string[] = [];
    const argvs: string[][] = [];
    const capture: GateRun = async argv => { argvs.push(argv); return { code: 0, stdout: JSON.stringify({ pass: true }) }; };
    expect(await runGate({ command: ["g", "{session_id}", "{tool_use_id}", "{inquiry_id}"], timeoutMs: 1000 }, input, clock, capture, w => warnings.push(w))).toEqual({ pass: true });
    expect(argvs[0]).toEqual(["g", "s", "t", "inq-9"]);
    const refuse = run({ code: 0, stdout: JSON.stringify({ pass: false }) });
    expect(await runGate(GATE, input, clock, refuse, w => warnings.push(w))).toEqual({ pass: false, reason: "The question was refused by the registry gate." });
    expect(warnings).toEqual([]);
  });

  test("a command that exits non-zero, prints no verdict or prints garbage lets the question pass, with a warning", async () => {
    const clock = newClock();
    for (const [result, text] of [
      [{ code: 3, stdout: "" }, "exited 3"],
      [{ code: 0, stdout: "{}" }, "no verdict"],
      [{ code: 0, stdout: "not json" }, "gate command failed"],
    ] as const) {
      const warnings: string[] = [];
      expect(await runGate(GATE, input, clock, run(result), w => warnings.push(w))).toEqual({ pass: true });
      expect(warnings.join()).toContain(text);
    }
  });

  test("a command that does not answer in time lets the question pass", async () => {
    const clock = newClock();
    const warnings: string[] = [];
    const outcome = runGate(GATE, input, clock, () => new Promise(() => {}), w => warnings.push(w));
    await clock.advance(GATE.timeoutMs);
    expect(await outcome).toEqual({ pass: true });
    expect(warnings.join()).toContain("gate command failed (timeout)");
  });
});

describe("answers of the factory", () => {
  test("a multi-select answer names sorted, distinct, existing options; a single-choice question takes one", () => {
    expect(FactoryRelay.answerIndexes("2,0", 3, true)).toEqual([0, 2]);
    expect(FactoryRelay.answerIndexes("1", 3, false)).toEqual([1]);
    expect(FactoryRelay.answerIndexes("0,1", 3, false)).toBeUndefined();
    expect(FactoryRelay.answerIndexes("3", 3, true)).toBeUndefined();
    expect(FactoryRelay.answerIndexes("1,1", 3, true)).toBeUndefined();
    expect(FactoryRelay.answerIndexes("x", 3, true)).toBeUndefined();
  });
});
