// The durable queue of records for the factory API. A record is written to the file first, sent in order, and removed only
// when the API acknowledges it (200 or 201). While the API is down the queue grows; Telegram never waits for it.
// A refusal of the request itself (4xx other than 408 and 429) drops that one record with a warning, the way
// the machine outbox drops what Telegram refuses; everything else (network, 5xx, 408, 429) stops the flush and is retried.
import type { Timers } from "../shared/timers.ts";

import { z } from "zod";
import { loadJson, saveJson } from "./factory-files.ts";

const REQUEST_TIMEOUT = 408;
const TOO_MANY_REQUESTS = 429;
const FIRST_CLIENT_ERROR = 400;
const FIRST_SERVER_ERROR = 500;
// Ids of finished records are kept to recognise a repeated post; a repeat only comes soon after the first.
const REMEMBERED = 1000;

const itemSchema = z.object({
  id: z.string(),
  // May hold `{poll:<item key>}`: replaced with the API id the poll was stored under.
  path: z.string(),
  token: z.enum(["hub", "relay"]),
  body: z.unknown().optional(),
  idempotencyKey: z.string().optional(),
  // The key under which the `id` of the API's answer is remembered (a poll, later addressed by its result).
  remember: z.string().optional(),
});
const dataSchema = z.object({ items: z.array(itemSchema), delivered: z.array(z.string()), ids: z.record(z.string(), z.string()) });
export type QueueItem = z.infer<typeof itemSchema>;
type Data = z.infer<typeof dataSchema>;

export type QueueResponse = { status: number; json: unknown };
export type QueueSend = (item: QueueItem & { path: string }) => Promise<QueueResponse>;

const POLL_PLACEHOLDER = /\{poll:([^}]+)\}/;

export class FactoryQueue {
  private data: Data;
  private flushing: Promise<void> | undefined;

  constructor(private file: string, private warn: (text: string) => void, private timers: Timers, private remembered = REMEMBERED) {
    this.data = loadJson(file, dataSchema, () => ({ items: [], delivered: [], ids: {} }), warn, timers, "factory queue");
  }

  get size(): number { return this.data.items.length; }
  get busy(): boolean { return this.flushing !== undefined; }
  // Delivered or still waiting: a post under this id would be ignored.
  known(id: string): boolean { return this.data.delivered.includes(id) || this.data.items.some(item => item.id === id); }

  post(item: QueueItem): void {
    if (this.known(item.id)) return;
    this.data.items.push(item);
    this.save();
  }

  // The API id a record was stored under, by the key it was remembered with.
  apiId(key: string): string | undefined { return this.data.ids[key]; }
  // The key a poll was remembered under, by the API id (a poll-answer request names the API id).
  keyOfApiId(id: string): string | undefined {
    return Object.entries(this.data.ids).find(([, value]) => value === id)?.[0];
  }

  flush(send: QueueSend): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.run(send).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async run(send: QueueSend): Promise<void> {
    for (;;) {
      const item = this.data.items[0];
      if (!item) return;
      const path = this.resolve(item.path);
      if (path === undefined) {
        this.drop(item, "its poll was never stored");
        continue;
      }
      let response: QueueResponse;
      try {
        response = await send({ ...item, path });
      } catch (error) {
        this.warn(`factory queue: ${item.id} not sent, will retry: ${String(error)}`);
        return;
      }
      const { status } = response;
      if (status === 200 || status === 201) {
        this.remember(item, response.json);
        this.finish(item);
      } else if (status >= FIRST_CLIENT_ERROR && status < FIRST_SERVER_ERROR && status !== REQUEST_TIMEOUT && status !== TOO_MANY_REQUESTS) {
        this.drop(item, `the API refused it (${status})`);
      } else {
        this.warn(`factory queue: ${item.id} not accepted (${status}), will retry`);
        return;
      }
    }
  }

  private resolve(path: string): string | undefined {
    const match = path.match(POLL_PLACEHOLDER);
    if (!match?.[1]) return path;
    const id = this.data.ids[match[1]];
    return id === undefined ? undefined : path.replace(POLL_PLACEHOLDER, encodeURIComponent(id));
  }

  private remember(item: QueueItem, json: unknown): void {
    if (!item.remember) return;
    const id = typeof json === "object" && json !== null ? (json as Record<string, unknown>).id : undefined;
    if (typeof id !== "string") return;
    this.data.ids[item.remember] = id;
    const keys = Object.keys(this.data.ids);
    for (const stale of keys.slice(0, Math.max(0, keys.length - this.remembered))) delete this.data.ids[stale];
  }

  private drop(item: QueueItem, reason: string): void {
    this.warn(`factory queue: ${item.id} dropped, ${reason}`);
    this.finish(item);
  }

  private finish(item: QueueItem): void {
    if (this.data.items[0]?.id === item.id) this.data.items.shift();
    this.data.delivered.push(item.id);
    if (this.data.delivered.length > this.remembered) this.data.delivered.splice(0, this.data.delivered.length - this.remembered);
    this.save();
  }

  private save(): void {
    saveJson(this.file, this.data);
  }
}
