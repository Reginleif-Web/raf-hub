// The registry gate (G9) invoked through the hub's question hook. The hub knows nothing about the registry: it runs an
// optional command the owner configured and obeys its verdict, so the same hook serves any gate.
//
// Command: an argv; `{session_id}`, `{tool_use_id}` and `{inquiry_id}` in any element are replaced before the run.
// Standard input: JSON `{session_id, tool_use_id, tool_input}`.
// Standard output: JSON `{pass: boolean, reason?: string, records?: unknown}`.
// pass:false refuses the tool call; `reason` (else a default) and the found records go back to the model.
// Anything else (exit code not 0, output that is not that JSON, no answer within the timeout, the command missing)
// lets the question pass: a registry that is down or slow never blocks the work (fail open).
import type { Timers } from "../shared/timers.ts";
import type { FactoryGateSettings } from "./factory-config.ts";

import { field, isObject, str } from "../shared/guards.ts";

const RECORDS_CHARS = 4000;

export type GateRun = (argv: string[], input: string, signal: AbortSignal) => Promise<{ code: number; stdout: string }>;
export type GateVerdict = { pass: true } | { pass: false; reason: string };
export type GateInput = { sessionId: string; toolUseId?: string; toolInput: unknown };

// The inquiry id the question tool input carries (governance G9): `metadata.source`.
export function inquiryId(toolInput: unknown): string | undefined {
  const source = str(field(field(toolInput, "metadata"), "source"));
  return source?.trim() || undefined;
}

export const spawnGate: GateRun = async (argv, input, signal) => {
  const child = Bun.spawn(argv, { stdin: Buffer.from(input), stdout: "pipe", stderr: "ignore", signal });
  const stdout = await new Response(child.stdout).text();
  return { code: await child.exited, stdout };
};

function fill(part: string, values: Record<string, string>): string {
  return part.replace(/\{(session_id|tool_use_id|inquiry_id)\}/g, (_, name: string) => values[name] ?? "");
}

export async function runGate(settings: FactoryGateSettings, input: GateInput, timers: Timers, run: GateRun, warn: (text: string) => void): Promise<GateVerdict> {
  const values = { session_id: input.sessionId, tool_use_id: input.toolUseId ?? "", inquiry_id: inquiryId(input.toolInput) ?? "" };
  const argv = settings.command.map(part => fill(part, values));
  const abort = new AbortController();
  const timer = timers.setTimer(() => abort.abort(), settings.timeoutMs);
  // A runner that ignores the signal must not hold the question past the timeout.
  const expired = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("timeout"))));
  try {
    const result = await Promise.race([run(argv, JSON.stringify({ session_id: input.sessionId, tool_use_id: input.toolUseId, tool_input: input.toolInput }), abort.signal), expired]);
    if (result.code !== 0) { warn(`gate command exited ${result.code}; the question passes`); return { pass: true }; }
    const verdict: unknown = JSON.parse(result.stdout);
    if (!isObject(verdict) || typeof verdict.pass !== "boolean") { warn("gate command gave no verdict; the question passes"); return { pass: true }; }
    if (verdict.pass) return { pass: true };
    const reason = str(verdict.reason)?.trim() || "The question was refused by the registry gate.";
    const records = verdict.records === undefined ? "" : `\n${JSON.stringify(verdict.records).slice(0, RECORDS_CHARS)}`;
    return { pass: false, reason: reason + records };
  } catch (error) {
    warn(`gate command failed (${abort.signal.aborted ? "timeout" : String(error)}); the question passes`);
    return { pass: true };
  } finally {
    timers.clearTimer(timer);
  }
}
