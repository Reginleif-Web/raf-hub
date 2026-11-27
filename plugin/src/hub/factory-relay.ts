// The hub's link to the factory API (see docs/superpowers/specs/factory-relay-design.md). One object holds everything the link does, so the hub
// itself only calls it at a few places and behaves exactly as before when the link is not configured (the hub then
// never builds this object).
//
// - Outputs (api configured): the hub's messages, polls, poll results and conversation states go to the factory API
//   through a durable queue; Telegram never waits for it.
// - Poll answers: the factory's answer requests of hub polls are read at the start and then every pollAnswerIntervalMs,
//   applied to the live poll when it still takes that answer, and reported (accepted or refused).
// - Poll registration (relay token configured): a poll that carries an inquiry id is registered with the registry; the
//   display line it returns is shown above the question, and every press of a registered poll is captured.
// - Gate (gate configured): an optional command run by the question hook before the question is shown.
// - Buttons (button keys configured): clients send messages with buttons; each press is taken once and read back.
import type { TimerHandle, Timers } from "../shared/timers.ts";
import type { AskQuestion } from "../shared/protocol.ts";
import type { Button } from "./telegram.ts";
import type { FactoryFetch } from "./factory-client.ts";
import type { FactorySettings } from "./factory-config.ts";
import type { GateRun, GateVerdict } from "./factory-gate.ts";
import type { FactoryState } from "./factory-prompts.ts";
import type { PressResult } from "./factory-buttons.ts";

import { join } from "path";
import { arr, field, isObject, str } from "../shared/guards.ts";
import { ButtonStore, sendRequestSchema } from "./factory-buttons.ts";
import { FactoryClient } from "./factory-client.ts";
import { runGate } from "./factory-gate.ts";
import { FactoryQueue } from "./factory-queue.ts";

const MAX_ANSWER_PAGES = 5;
const POLL_PREFIX = "poll";

// What the hub did with a poll-answer request from the factory.
export type AnswerOutcome = "applied" | "closed" | "invalid";

export type RelayDeps = {
  settings: FactorySettings;
  // The directory the link keeps its files in (next to the hub's outbox).
  dir: string;
  timers: Timers;
  fetchFn: FactoryFetch;
  warn: (text: string) => void;
  gateRun: GateRun;
  groupId: () => string | undefined;
  // Shows a message with buttons in the group (through the machine outbox).
  postButtons: (id: string, text: string, buttons: Button[][], topicId: number | undefined) => void;
  // Applies the answer of a factory request to the live poll `pollKey` at question `index`.
  applyAnswer: (pollKey: string, index: number, answerKey: string) => AnswerOutcome;
};

type Registered = { pollId: string; displayLine: string };

export class FactoryRelay {
  private queue?: FactoryQueue;
  private client?: FactoryClient;
  private buttons?: ButtonStore;
  private registered = new Map<string, Registered>();
  private tasks = new Set<Promise<unknown>>();
  private gating = 0;
  private stateCount = 0;
  private repeat?: TimerHandle;

  constructor(private deps: RelayDeps) {
    const { api, buttons } = deps.settings;
    if (api) {
      this.queue = new FactoryQueue(join(deps.dir, "factory-queue.json"), deps.warn, deps.timers);
      this.client = new FactoryClient(api, deps.timers, deps.fetchFn);
    }
    if (buttons) this.buttons = new ButtonStore(join(deps.dir, "buttons.json"), buttons, deps.warn, deps.timers);
  }

  // Records waiting for the API, or work of the link in flight: the hub is not idle meanwhile.
  get size(): number { return (this.queue?.size ?? 0); }
  get busy(): boolean { return this.gating > 0 || this.tasks.size > 0 || (this.queue?.busy ?? false); }
  get hasButtons(): boolean { return this.buttons !== undefined; }

  // Resolves when all work started so far has finished (tests, a clean stop).
  async drain(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  start(): void {
    if (!this.client || !this.deps.settings.api) return;
    this.track(this.tick());
    this.repeat = this.deps.timers.setRepeat(() => this.track(this.tick()), this.deps.settings.api.pollAnswerIntervalMs);
  }

  stop(): void {
    if (this.repeat !== undefined) this.deps.timers.clearTimer(this.repeat);
    this.repeat = undefined;
  }

  // ----- gate -----

  async gate(sessionId: string, toolUseId: string | undefined, toolInput: unknown): Promise<GateVerdict> {
    const settings = this.deps.settings.gate;
    if (!settings) return { pass: true };
    this.gating++;
    try {
      return await runGate(settings, { sessionId, toolUseId, toolInput }, this.deps.timers, this.deps.gateRun, this.deps.warn);
    } finally {
      this.gating--;
    }
  }

  // ----- poll registration -----

  // Registers the question with the registry when it carries an inquiry id and the relay token is configured. Any failure
  // or timeout leaves the poll unregistered: the question is sent as it is (fail open).
  async register(pollKey: string, index: number, inquiry: string | undefined, question: AskQuestion): Promise<void> {
    const client = this.client;
    const api = this.deps.settings.api;
    if (!client?.canRegister || !api || !inquiry) return;
    const options = question.options.map((option, i) => ({ key: String(i), label: option.label }));
    try {
      const response = await client.request("POST", "/registry/polls", "relay", { inquiry_id: inquiry, question: question.question, options }, undefined, api.registryTimeoutMs);
      const pollId = str(field(response.json, "poll_id"));
      const displayLine = str(field(response.json, "display_line"));
      if (response.status !== 201 || !pollId || displayLine === undefined) {
        this.deps.warn(`registry poll not registered (${response.status}); the question is sent as it is`);
        return;
      }
      this.registered.set(`${pollKey}:${index}`, { pollId, displayLine });
    } catch (error) {
      this.deps.warn(`registry poll not registered (${String(error)}); the question is sent as it is`);
    }
  }

  displayLine(pollKey: string, index: number): string | undefined {
    return this.registered.get(`${pollKey}:${index}`)?.displayLine || undefined;
  }

  forget(pollKey: string): void {
    for (const key of [...this.registered.keys()]) if (key.startsWith(`${pollKey}:`)) this.registered.delete(key);
  }

  // A press of a registered poll, one capture per chosen option; the press id is the Telegram callback id.
  capture(pollKey: string, index: number, callbackId: string, userId: string, optionIndexes: number[]): void {
    const registered = this.registered.get(`${pollKey}:${index}`);
    if (!this.queue || !this.client?.canRegister || !registered) return;
    const many = optionIndexes.length > 1;
    for (const option of optionIndexes) {
      const pressId = many ? `tg:${callbackId}:${option}` : `tg:${callbackId}`;
      this.queue.post({
        id: `capture:${pressId}`, path: "/registry/captures", token: "relay", idempotencyKey: pressId,
        body: { press_id: pressId, telegram_user_id: userId, poll_id: registered.pollId, option_index: option },
      });
    }
    this.kick();
  }

  // ----- outputs -----

  mirrorMessage(sessionId: string, sourceId: string, text: string): void {
    if (!this.queue) return;
    const key = `msg:${sourceId}`;
    this.queue.post({ id: key, path: "/hub/messages", token: "hub", body: { session_ref: sessionId, key, kind: "text", content: { text } } });
    this.kick();
  }

  mirrorPoll(sessionId: string, pollKey: string, index: number, question: AskQuestion): void {
    if (!this.queue) return;
    const key = `${POLL_PREFIX}:${pollKey}:${index}`;
    const content = {
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      multi_select: question.multiSelect,
      options: question.options.map((option, i) => ({ key: String(i), label: option.label })),
    };
    this.queue.post({ id: key, path: "/hub/polls", token: "hub", body: { session_ref: sessionId, key, kind: "poll", content }, remember: `${pollKey}:${index}` });
    this.kick();
  }

  // The answer the owner chose in Telegram (indexes are the 0-based option positions).
  mirrorPollResult(pollKey: string, index: number, optionIndexes: number[]): void {
    if (!this.queue) return;
    const answerKey = [...optionIndexes].sort((a, b) => a - b).join(",");
    this.queue.post({
      id: `poll-result:${pollKey}:${index}`, path: `/hub/polls/{poll:${pollKey}:${index}}/result`, token: "hub",
      body: { answer_key: answerKey, answered_via: "telegram" },
    });
    this.kick();
  }

  // Only the state, never the text of what the session waits for.
  mirrorState(sessionId: string, state: FactoryState): void {
    if (!this.queue) return;
    this.stateCount++;
    const key = `state:${this.deps.timers.now()}-${this.stateCount}`;
    this.queue.post({ id: key, path: "/hub/states", token: "hub", body: { session_ref: sessionId, key, kind: "state", content: { state } } });
    this.kick();
  }

  // ----- poll answers -----

  // The option positions an answer key names; undefined when it names none that exist or repeats one.
  static answerIndexes(answerKey: string, options: number, multi: boolean): number[] | undefined {
    const parts = answerKey.split(",");
    if (!multi && parts.length !== 1) return undefined;
    const indexes: number[] = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return undefined;
      const value = Number(part);
      if (value >= options || indexes.includes(value)) return undefined;
      indexes.push(value);
    }
    return indexes.sort((a, b) => a - b);
  }

  private async tick(): Promise<void> {
    await this.flush();
    await this.readAnswers();
    await this.flush();
  }

  private async readAnswers(): Promise<void> {
    const queue = this.queue;
    const client = this.client;
    if (!queue || !client) return;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_ANSWER_PAGES; page++) {
      let json: unknown;
      try {
        const query = cursor ? `?state=pending&cursor=${encodeURIComponent(cursor)}` : "?state=pending";
        const response = await client.request("GET", `/hub/poll-answers${query}`, "hub");
        if (response.status !== 200) { this.deps.warn(`poll answers not read (${response.status})`); return; }
        json = response.json;
      } catch (error) {
        this.deps.warn(`poll answers not read: ${String(error)}`);
        return;
      }
      for (const item of arr(field(json, "items"))) this.answer(item);
      cursor = str(field(json, "next_cursor"));
      if (!cursor) break;
    }
  }

  // One answer request. The result record is posted once; a request already resulted is not applied again.
  private answer(item: unknown): void {
    const queue = this.queue;
    if (!queue || !isObject(item)) return;
    const id = str(item.id);
    const pollId = str(item.poll_id);
    const answerKey = str(item.answer_key);
    if (!id || !pollId || answerKey === undefined) return;
    const resultId = `answer-result:${id}`;
    if (queue.known(resultId)) return;
    const result = (body: Record<string, unknown>) => queue.post({ id: resultId, path: `/hub/poll-answers/${encodeURIComponent(id)}/result`, token: "hub", body });
    const key = queue.keyOfApiId(pollId);
    const at = key?.lastIndexOf(":") ?? -1;
    if (!key || at < 0) { result({ state: "refused", refusal_reason: "poll_closed" }); return; }
    const outcome = this.deps.applyAnswer(key.slice(0, at), Number(key.slice(at + 1)), answerKey);
    if (outcome === "applied") result({ state: "accepted", hub_ref: key });
    else result({ state: "refused", refusal_reason: outcome === "closed" ? "poll_closed" : "invalid_answer" });
  }

  // ----- sending -----

  private kick(): void {
    this.track(this.flush());
  }

  private flush(): Promise<void> {
    const { queue, client } = this;
    if (!queue || !client) return Promise.resolve();
    return queue.flush(item => client.request("POST", item.path, item.token, item.body, item.idempotencyKey));
  }

  private track(task: Promise<unknown>): void {
    const tracked: Promise<unknown> = task.catch(error => this.deps.warn(`factory link: ${String(error)}`)).finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  // ----- buttons -----

  // Undefined when buttons are not configured: the hub then answers as it always did.
  async handleButtons(req: Request, url: URL): Promise<Response | undefined> {
    const store = this.buttons;
    if (!store) return undefined;
    const client = store.authenticate(req.headers.get("x-hub-client"), req.headers.get("x-hub-client-key"));
    if (!client) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (req.method === "POST" && url.pathname === "/buttons/send") {
      const parsed = sendRequestSchema.safeParse(await req.json().catch(() => undefined));
      if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
      const request = parsed.data;
      if (request.chat !== this.deps.groupId()) return Response.json({ error: "chat_not_allowed" }, { status: 403 });
      const registered = store.register(client, request);
      switch (registered.kind) {
        case "conflict": return Response.json({ error: "key_conflict" }, { status: 409 });
        case "replayed": return Response.json({ error: "press_replayed", press_id: registered.pressId }, { status: 409 });
        case "same": return Response.json({ message: registered.outboxId }, { status: 200 });
        case "created":
          this.deps.postButtons(registered.outboxId, request.text, registered.buttons, request.topic);
          return Response.json({ message: registered.outboxId }, { status: 201 });
      }
    }
    if (req.method === "GET" && url.pathname === "/buttons/presses") {
      const items = store.presses(client).map(press => ({ seq: press.seq, press_id: press.pressId, draft_id: press.draftId, telegram_user_id: press.userId, at: press.at }));
      return Response.json({ items });
    }
    const ack = /^\/buttons\/presses\/(\d+)\/ack$/.exec(url.pathname);
    if (req.method === "POST" && ack?.[1]) {
      return store.acknowledge(client, Number(ack[1])) ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // The first press of a button token by a user the hub lets press at all; any other press is refused.
  press(token: string, userId: string): PressResult {
    return this.buttons ? this.buttons.press(token, userId) : { ok: false, reason: "unknown" };
  }
}
