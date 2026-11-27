// The HTTP side of the factory link. The fetch and the clock are injected; a request that takes longer than
// `requestTimeoutMs` is aborted through a Timers timer, never a real one.
import type { Timers } from "../shared/timers.ts";
import type { FactoryApiSettings } from "./factory-config.ts";
import type { QueueResponse } from "./factory-queue.ts";

export type FactoryFetch = (url: string, init: RequestInit) => Promise<Response>;
export type FactoryToken = "hub" | "relay";

export class FactoryClient {
  constructor(private api: FactoryApiSettings, private timers: Timers, private fetchFn: FactoryFetch) {}

  get canRegister(): boolean { return this.api.relayToken !== undefined; }

  // Never returns an error status as an exception: the caller decides what a 4xx or 5xx means. A network failure,
  // a timeout or an unreadable body throws.
  async request(method: "GET" | "POST", path: string, token: FactoryToken, body?: unknown, idempotencyKey?: string, timeoutMs = this.api.requestTimeoutMs): Promise<QueueResponse> {
    const secret = token === "hub" ? this.api.hubToken : this.api.relayToken;
    if (!secret) throw new Error(`no ${token} token configured`);
    const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const abort = new AbortController();
    const timer = this.timers.setTimer(() => abort.abort(), timeoutMs);
    // A fetch that ignores the signal must not hold the caller past the timeout.
    const expired = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error(`${path} timed out`))));
    try {
      const done = (async (): Promise<QueueResponse> => {
        const response = await this.fetchFn(`${this.api.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: abort.signal });
        let json: unknown;
        try { json = await response.json(); } catch {}
        return { status: response.status, json };
      })();
      // Promise.race subscribes to both, so the losing branch is never an unhandled rejection.
      return await Promise.race([done, expired]);
    } finally {
      this.timers.clearTimer(timer);
    }
  }
}
