#!/usr/bin/env bun
// PreToolUse hook for AskUserQuestion: while Telegram mode is on, the hub asks
// the questions in the topic and holds the request until they are answered.
//
// The hub marks a request it took as a poll with a header that goes out at
// once (QUESTION_ACCEPTED_HEADER). Before that, and with a hub that sends no
// header, the hook prints a decision only for an answer (allow) or a cancel
// (deny); otherwise, or on any error, it prints nothing and the terminal shows
// its own dialog. After it, the owner may be away from the terminal, so a
// technical end (the connection lost, an unreadable answer, the hook's own time
// limit) is a deny that tells the agent nothing was answered: only an explicit
// "none" from the hub leaves the dialog to the terminal.
//
// A hub that cannot be reached at all (or that closed the connection before
// accepting, or answered with an error status) is a deny too while the session's persisted Telegram mode is on,
// telling the agent to write the question as plain text; with the mode off or
// unknown the hook stays silent. A parent that is gone is always silent.
import { z } from "zod";
import { isAlive } from "../shared/process-alive.ts";
import { hubPort, paths } from "../shared/config.ts";
import { QUESTION_ACCEPTED_HEADER } from "../shared/protocol.ts";
import { questionDecision } from "../shared/protocol-schema.ts";
import { readSessionMode } from "../hub/sessions.ts";
import { PARENT_CHECK_MS, QUESTION_DEADLINE_MS } from "./question-limits.ts";
import { endedReason, HUB_UNREACHABLE_REASON } from "./question-reasons.ts";
import type { EndedWhy } from "./question-reasons.ts";

// The part of the hook input the hub needs; the hub checks the questions.
// The tool input stays whole: updatedInput replaces it, so other fields must
// survive.
const hookInput = z.object({
  session_id: z.string().min(1),
  tool_input: z.looseObject({ questions: z.array(z.unknown()) }),
});

type Output = { permissionDecision: "allow"; permissionDecisionReason: string; updatedInput: Record<string, unknown> } | { permissionDecision: "deny"; permissionDecisionReason: string };

const deny = (reason: string): Output => ({ permissionDecision: "deny", permissionDecisionReason: reason });

// The wait ends at the hook's own deadline (TELEGRAM_HUB_QUESTION_DEADLINE_MS
// shortens it for tests) or once the parent is gone: a hook that Claude Code
// no longer waits for must not hold the poll open. Only signals the parent,
// so it starts no process; on Windows ppid keeps the dead parent's number.
const stop = new AbortController();
const parent = process.ppid;
const deadline = Number(process.env.TELEGRAM_HUB_QUESTION_DEADLINE_MS) || QUESTION_DEADLINE_MS;
let timedOut = false;
let parentGone = false;
setTimeout(() => {
  timedOut = true;
  stop.abort();
}, deadline);
setInterval(() => {
  if (process.ppid !== parent || !isAlive(parent)) {
    parentGone = true;
    stop.abort();
  }
}, PARENT_CHECK_MS);

// What the hook prints, or undefined to print nothing.
async function decide(): Promise<Output | undefined> {
  const parsed = hookInput.safeParse(JSON.parse(await Bun.stdin.text()));
  if (!parsed.success) return undefined;
  const input = parsed.data;
  // The persisted mode tells whether the owner counts on Telegram.
  const notTaken = (): Output | undefined => (readSessionMode(paths().sessionsFile, input.session_id) === true ? deny(HUB_UNREACHABLE_REASON) : undefined);
  let res: Response;
  try {
    // timeout: false turns off Bun's 5-minute idle timer on the held request.
    res = await fetch(`http://127.0.0.1:${hubPort()}/question`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messagingSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET,
        session_id: input.session_id,
        tool_input: input.tool_input,
      }),
      timeout: false,
      signal: stop.signal,
    });
  } catch {
    // No response: nothing listens, the hub closed the connection before accepting, or the hook's own end
    // came first. Our own end is silent as before.
    return parentGone || timedOut ? undefined : notTaken();
  }
  if (!res.ok) return notTaken();
  // A hub that sends no header is an older one: it answers only when the poll is over.
  const accepted = res.headers.has(QUESTION_ACCEPTED_HEADER);
  const ended = (why: EndedWhy): Output | undefined => (accepted && !parentGone ? deny(endedReason(why)) : undefined);
  let body: string;
  try {
    body = await res.text();
  } catch {
    return ended(timedOut ? "timeLimit" : "connectionLost");
  }
  let decision;
  try {
    decision = questionDecision.safeParse(JSON.parse(body));
  } catch {
    return ended("unreadableAnswer");
  }
  if (!decision.success) return ended("unreadableAnswer");
  const d = decision.data;
  if (d.decision === "none") return undefined;
  if (d.decision === "deny") return deny(d.reason);
  return { permissionDecision: "allow", permissionDecisionReason: "Answered in Telegram", updatedInput: { ...input.tool_input, answers: d.answers } };
}

try {
  const output = await decide();
  // Awaited: process.exit below must not cut a large answer short.
  if (output) await Bun.write(Bun.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...output } }));
} catch {}
process.exit(0);
