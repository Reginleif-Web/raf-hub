import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { z } from "zod";
import type { Message } from "./telegram.ts";
import { parseRecord } from "../transcript/parse.ts";

const schema = z.record(z.string(), z.array(z.object({ message_id: z.number().int(), date: z.number(), chat: z.object({ id: z.number(), type: z.enum(["private", "group", "supergroup", "channel"]) }).loose() }).loose()));

// The transcript is the durable acknowledgement if the hub died before it
// received `seen`. Tool output and quoted tags are not acknowledgements.
export function transcriptMessageIds(text: string, group: string): number[] {
  const ids = new Set<number>();
  for (const line of text.split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const observed = new Set(parseRecord(entry).flatMap(event => event.kind === "channel_seen" ? event.messageIds : []));
    if (!observed.size) continue;
    const content = entry.type === "attachment" ? entry.attachment?.prompt : entry.message?.content;
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter(block => block.type === "text").map(block => block.text) : [];
    for (const value of texts) {
      if (typeof value !== "string") continue;
      for (const tag of value.matchAll(/<channel\b([^>]*)>/g)) {
        if (!/source="[^"]*telegram-hub[^"]*"/.test(tag[1])) continue;
        const chat = /\bchat_id="([^"]+)"/.exec(tag[1])?.[1];
        const candidates = [Number(/\bmessage_id="(\d+)"/.exec(tag[1])?.[1]), ...(/\bmessage_ids="([\d,]+)"/.exec(tag[1])?.[1].split(",").map(Number) ?? [])];
        for (const id of candidates) if (chat === group && observed.has(id)) ids.add(id);
      }
    }
  }
  return [...ids];
}

// Telegram updates are acknowledged before a window necessarily exists.
// Retain startup messages until the plugin reports that the agent saw them.
export class TerminalInbox {
  private pending: Record<string, Message[]> = {};
  constructor(private file: string) {
    try { this.pending = schema.parse(JSON.parse(readFileSync(file, "utf8"))) as Record<string, Message[]>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  entries(): [string, Message[]][] { return Object.entries(this.pending).map(([sid, messages]) => [sid, [...messages]]); }
  add(session: string, message: Message): void {
    const messages = this.pending[session] ?? [];
    if (messages.some(known => known.message_id === message.message_id)) return;
    this.pending[session] = [...messages, message].sort((a, b) => a.message_id - b.message_id);
    this.save();
  }
  seen(ids: readonly number[]): void {
    const seen = new Set(ids);
    let changed = false;
    for (const [session, messages] of Object.entries(this.pending)) {
      const next = messages.filter(message => !seen.has(message.message_id));
      if (next.length === messages.length) continue;
      changed = true;
      if (next.length) this.pending[session] = next;
      else delete this.pending[session];
    }
    if (changed) this.save();
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const staged = `${this.file}.tmp`;
    writeFileSync(staged, JSON.stringify(this.pending), { mode: 0o600 });
    renameSync(staged, this.file);
  }
}
