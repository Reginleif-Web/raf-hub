// Buttons for a client of the hub (D5). A client sends a message with buttons, each button carries the client's own
// press id; the hub gives every button a token of its own, `b:<token>` as the callback data, shows the message, and
// takes the first press of each token by an allowed user, once. The client reads its presses and acknowledges them.
//
// - A client is known by its name and its key (both headers); a missing, wrong or another client's key is refused.
// - A send is idempotent on [client, chat, key]: the same payload is the same message, a different one is refused.
// - A press id the client already registered is refused (press_replayed): one press id, one button, ever.
// - A token is taken once and only while its window is open (press_expired); the second press, a replayed one, is refused.
// Who may press at all (allowFrom) is decided before a press gets here, by the hub's callback routing.
import type { Button } from "./telegram.ts";
import type { Timers } from "../shared/timers.ts";
import type { FactoryButtonSettings } from "./factory-config.ts";

import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { z } from "zod";
import { loadJson, saveJson } from "./factory-files.ts";

export const BUTTON_PREFIX = "b:";
const TOKEN_CHARS = 24;
// Telegram callback data is at most 64 bytes; the prefix and the token stay far below.
const MAX_BUTTONS = 8;
const MAX_TOKENS = 2000;
const MAX_SENDS = 1000;
const MAX_PRESSES = 1000;

const tokenSchema = z.object({ client: z.string(), pressId: z.string(), draftId: z.string(), expiresAt: z.number(), used: z.boolean() });
const pressSchema = z.object({ seq: z.number(), client: z.string(), pressId: z.string(), draftId: z.string(), userId: z.string(), at: z.number() });
const sendSchema = z.object({ payload: z.string(), outboxId: z.string() });
const dataSchema = z.object({
  sends: z.record(z.string(), sendSchema),
  tokens: z.record(z.string(), tokenSchema),
  presses: z.array(pressSchema),
  seq: z.number(),
});
type Data = z.infer<typeof dataSchema>;
export type ButtonPress = z.infer<typeof pressSchema>;

export const sendRequestSchema = z.object({
  chat: z.string().min(1),
  key: z.string().min(1),
  text: z.string().min(1),
  topic: z.number().int().optional(),
  buttons: z.array(z.object({ id: z.string().min(1), draftId: z.string().min(1), text: z.string().min(1) })).min(1).max(MAX_BUTTONS),
});
export type SendRequest = z.infer<typeof sendRequestSchema>;

export type RegisterResult =
  | { kind: "created"; outboxId: string; buttons: Button[][] }
  | { kind: "same"; outboxId: string }
  | { kind: "conflict" }
  | { kind: "replayed"; pressId: string };

export type PressResult = { ok: true } | { ok: false; reason: "unknown" | "used" | "expired" };

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

export class ButtonStore {
  private data: Data;

  constructor(private file: string, private settings: FactoryButtonSettings, private warn: (text: string) => void, private timers: Timers) {
    this.data = loadJson(file, dataSchema, () => ({ sends: {}, tokens: {}, presses: [], seq: 0 }), warn, timers, "button store");
  }

  // The client's name and key must both match; every configured key is compared so the time does not tell which one was close.
  authenticate(client: string | null, key: string | null): string | undefined {
    if (!client || !key) return undefined;
    const given = digest(key);
    let ok = false;
    for (const [name, expected] of Object.entries(this.settings.keys)) {
      const same = timingSafeEqual(given, digest(expected));
      if (same && name === client) ok = true;
    }
    return ok ? client : undefined;
  }

  register(client: string, request: SendRequest): RegisterResult {
    const scope = JSON.stringify([client, request.chat, request.key]);
    const payload = digest(JSON.stringify({ text: request.text, topic: request.topic, buttons: request.buttons })).toString("hex");
    const existing = this.data.sends[scope];
    if (existing) return existing.payload === payload ? { kind: "same", outboxId: existing.outboxId } : { kind: "conflict" };
    const pressIds = new Set(Object.values(this.data.tokens).filter(token => token.client === client).map(token => token.pressId));
    const seen = new Set<string>();
    for (const button of request.buttons) {
      if (pressIds.has(button.id) || seen.has(button.id)) return { kind: "replayed", pressId: button.id };
      seen.add(button.id);
    }
    const expiresAt = this.timers.now() + this.settings.pressWindowMs;
    const buttons: Button[][] = request.buttons.map(button => {
      const token = randomUUID().replaceAll("-", "").slice(0, TOKEN_CHARS);
      this.data.tokens[token] = { client, pressId: button.id, draftId: button.draftId, expiresAt, used: false };
      return [{ text: button.text, data: `${BUTTON_PREFIX}${token}` }];
    });
    const outboxId = `btn:${client}:${request.chat}:${request.key}`;
    this.data.sends[scope] = { payload, outboxId };
    this.trim();
    this.save();
    return { kind: "created", outboxId, buttons };
  }

  // The first press of a token that is still open is taken and recorded; anything else is refused and recorded nowhere.
  press(token: string, userId: string): PressResult {
    const found = this.data.tokens[token];
    if (!found) return { ok: false, reason: "unknown" };
    if (found.used) return { ok: false, reason: "used" };
    const now = this.timers.now();
    if (now > found.expiresAt) return { ok: false, reason: "expired" };
    found.used = true;
    this.data.seq += 1;
    this.data.presses.push({ seq: this.data.seq, client: found.client, pressId: found.pressId, draftId: found.draftId, userId, at: now });
    if (this.data.presses.length > MAX_PRESSES) {
      this.warn(`button store: ${this.data.presses.length - MAX_PRESSES} unread presses dropped`);
      this.data.presses.splice(0, this.data.presses.length - MAX_PRESSES);
    }
    this.save();
    return { ok: true };
  }

  presses(client: string): ButtonPress[] {
    return this.data.presses.filter(press => press.client === client);
  }

  // false: no such unread press of this client (another client's press is not found for it).
  acknowledge(client: string, seq: number): boolean {
    const at = this.data.presses.findIndex(press => press.seq === seq && press.client === client);
    if (at < 0) return false;
    this.data.presses.splice(at, 1);
    this.save();
    return true;
  }

  private trim(): void {
    for (const [name, limit] of [["tokens", MAX_TOKENS], ["sends", MAX_SENDS]] as const) {
      const map = this.data[name];
      const keys = Object.keys(map);
      for (const stale of keys.slice(0, Math.max(0, keys.length - limit))) delete map[stale];
    }
  }

  private save(): void {
    saveJson(this.file, this.data);
  }
}
