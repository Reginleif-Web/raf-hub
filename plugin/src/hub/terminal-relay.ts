import { randomUUID } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { Entity } from "../shared/markdown.ts";
import type { Button } from "./telegram.ts";
import { field } from "../shared/guards.ts";
import { RIG_QUERY_LIMIT_MS } from "../shared/info-data.ts";
import { isAlive } from "../shared/process-alive.ts";
import { realTimers, type Timers } from "../shared/timers.ts";

const snapshotSchema = z.object({ session: z.string(), generation: z.string(), revision: z.number().int().nonnegative(), screen: z.string(), status: z.enum(["starting", "running", "exited"]), recoveries: z.number().int().nonnegative() });
const descriptorSchema = z.object({ schemaVersion: z.literal(1), session: z.string(), generation: z.string(), port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/) });
export type TerminalSnapshot = z.infer<typeof snapshotSchema>;
type Input = { generation: string; revision: number; key?: string; text?: string };
type Frame = { session: string; generation: string; revision: number };
// Match the hub's bound on pending permission prompts. Older keyboards become stale.
const MAX_FRAMES = 200;
// Telegram's plain-text limit minus space for the title and usage hint.
const SCREEN_CHARS = 4096 - 512;
const KEY_ROWS = [["up", "↑"], ["down", "↓"], ["left", "←"], ["right", "→"], ["enter", "Enter"], ["escape", "Esc"], ["tab", "Tab"], ["backspace", "⌫"], ["interrupt", "Ctrl+C"], ["refresh", "↻"], ["text", "Text"]] as const;
const keys = new Set<string>(KEY_ROWS.map(([key]) => key));

export type TerminalRelayOptions = {
  directory: string;
  request?: (session: string, input?: Input) => Promise<TerminalSnapshot>;
  show(session: string, text: string, entities: Entity[], buttons: Button[][], generation: string): void;
  connected(session: string): boolean;
  known(session: string): boolean;
  watch?(session: string): boolean;
  warn(text: string): void;
  timers?: Timers;
};

export class TerminalRelay {
  private frames = new Map<string, Frame>();
  private latest = new Map<string, string>();
  private announced = new Map<string, string>();
  private scanning = false;
  private recoveriesSeen = new Map<string, number>();
  private textFrames = new Map<string, Frame>();
  constructor(private options: TerminalRelayOptions) {}

  private async request(session: string, input?: Input): Promise<TerminalSnapshot> {
    if (!/^[\w-]{1,128}$/.test(session) || !this.options.known(session)) throw new Error("Unknown session");
    if (this.options.request) return this.options.request(session, input);
    const record = descriptorSchema.parse(JSON.parse(readFileSync(join(this.options.directory, `${session}.json`), "utf8")));
    if (record.session !== session || (input && record.generation !== input.generation)) throw new Error("Terminal restarted; use /terminal");
    const headers = { authorization: `Bearer ${record.token}`, "content-type": "application/json" };
    const timers = this.options.timers ?? realTimers;
    const abort = new AbortController();
    const timer = timers.setTimer(() => abort.abort(), RIG_QUERY_LIMIT_MS);
    try {
      const result = await fetch(`http://127.0.0.1:${record.port}/${input ? "input" : "screen"}`, { method: input ? "POST" : "GET", headers,
        ...(input ? { body: JSON.stringify(input) } : {}), signal: abort.signal });
      if (!result.ok) throw new Error(result.status === 409 ? "Screen changed; use /terminal" : `Terminal request failed (${result.status})`);
      if (input) return this.request(session);
      const snapshot = snapshotSchema.parse(await result.json());
      if (snapshot.session !== session || snapshot.generation !== record.generation) throw new Error("Terminal identity changed; use /terminal");
      return snapshot;
    } finally { timers.clearTimer(timer); }
  }

  private show(snapshot: TerminalSnapshot): void {
    const prior = this.latest.get(snapshot.session);
    if (prior) this.frames.delete(prior);
    const key = randomUUID().replaceAll("-", "").slice(0, 12);
    this.frames.set(key, { session: snapshot.session, generation: snapshot.generation, revision: snapshot.revision });
    this.latest.set(snapshot.session, key);
    while (this.frames.size > MAX_FRAMES) this.frames.delete(this.frames.keys().next().value!);
    const heading = `Terminal · ${snapshot.status}${snapshot.recoveries ? " · recovered completed question" : ""}\n\n`;
    const screen = snapshot.screen.slice(-SCREEN_CHARS) || "(waiting for terminal output)";
    const hint = "\n\nText button → /terminal text <answer> → Enter. /terminal refreshes the screen. Login: open the displayed link on your phone.";
    const buttons: Button[][] = [];
    for (let index = 0; index < KEY_ROWS.length; index += 5) buttons.push(KEY_ROWS.slice(index, index + 5).map(([action, text]) => ({ text, data: `t:${key}:${action}` })));
    this.options.show(snapshot.session, heading + screen + hint, [{ type: "pre", offset: heading.length, length: screen.length }], snapshot.status === "exited" ? [] : buttons, snapshot.generation);
  }

  async command(session: string, args: string): Promise<void> {
    const argument = args.trim();
    if (!argument || argument === "screen" || argument === "refresh") { this.show(await this.request(session)); return; }
    if (!argument.startsWith("text ")) throw new Error("Use the buttons on the displayed screen. For text, press Text first, then /terminal text <answer>.");
    const frame = this.textFrames.get(session);
    if (!frame) throw new Error("Press Text on the displayed screen first, then use /terminal text <answer>.");
    this.textFrames.delete(session);
    this.show(await this.request(session, { generation: frame.generation, revision: frame.revision, text: argument.slice(5) }));
  }

  async press(data: string): Promise<string> {
    const match = /^t:([a-f0-9]{12}):(\w+)$/.exec(data);
    const frame = match ? this.frames.get(match[1]) : undefined;
    if (!match || !frame || !keys.has(match[2])) return "Request outdated; use /terminal";
    this.frames.delete(match[1]);
    if (match[2] === "text") {
      this.textFrames.set(frame.session, frame);
      return "Use /terminal text <answer>, then press Enter on the updated screen";
    }
    try {
      const snapshot = await this.request(frame.session, match[2] === "refresh" ? undefined : { generation: frame.generation, revision: frame.revision, key: match[2] });
      this.show(snapshot);
      return "Sent";
    } catch (error) {
      try { this.show(await this.request(frame.session)); } catch {}
      return error instanceof Error ? error.message : "Terminal unavailable; use /terminal";
    }
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let names: string[];
      try { names = readdirSync(this.options.directory); } catch { return; }
      for (const name of names) {
        if (!/^[\w-]+\.json$/.test(name)) continue;
        const session = name.slice(0, -5);
        if (!this.options.known(session)) continue;
        if (this.options.watch && !this.options.watch(session)) continue;
        try {
          const snapshot = await this.request(session);
          if (!snapshot.screen) continue;
          // Unknown startup screens must be operable before the plugin exists.
          // Once it connects, only recognized blocking menus need automatic cards.
          const prompt = /Accessing workspace:|Loading development channels|Press Enter|Enter to select|Enter to confirm|Esc to cancel|Do you want|Would you like|What do you want to do/.test(snapshot.screen);
          const recovered = snapshot.recoveries > (this.recoveriesSeen.get(session) ?? 0);
          if (this.options.connected(session) && !prompt && snapshot.status !== "exited" && !recovered) continue;
          const signature = `${snapshot.generation}:${snapshot.revision}:${snapshot.status}`;
          if (this.announced.get(session) === signature) continue;
          this.announced.set(session, signature);
          this.recoveriesSeen.set(session, snapshot.recoveries);
          this.show(snapshot);
        } catch { /* A dead descriptor is not a new prompt. /terminal reports the failure on demand. */ }
      }
    } finally { this.scanning = false; }
  }

  async running(session: string): Promise<boolean> {
    try { return (await this.request(session)).status !== "exited"; } catch { return false; }
  }

  // Whether a terminal supervisor owns the session: its descriptor exists and the supervisor pid it records is
  // alive. Synchronous and local, so a transient request failure cannot answer false the way running() does.
  // A descriptor that exists but cannot be read or understood (being rewritten, locked) counts as supervised:
  // a false "no supervisor" would warn about a dialog the owner can already see.
  supervised(session: string): boolean {
    if (!/^[\w-]{1,128}$/.test(session)) return false;
    let text: string;
    try { text = readFileSync(join(this.options.directory, `${session}.json`), "utf8"); } catch (e) { return field(e, "code") !== "ENOENT"; }
    try {
      const pid: unknown = field(JSON.parse(text), "pid");
      return typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid);
    } catch { return true; }
  }
}
