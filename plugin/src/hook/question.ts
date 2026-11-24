#!/usr/bin/env bun
// PreToolUse hook for AskUserQuestion: while Telegram mode is on, the hub asks
// the questions in the topic and holds the request until they are answered.
//
// One rule for every technical end (no connection, an error status, a lost or
// unreadable answer, the hook's own time limit), before the hub accepted the
// poll or after it. While the session's Telegram mode is on, the owner reads
// Telegram and not the terminal, so the hook never falls through to the
// terminal dialog; the only ways to it are an explicit "none" from the hub
// (the owner turned the mode off, or it already was) and a mode that is off or
// unknown in the persisted state.
//  - The parent is gone: nobody reads the output, print nothing.
//  - The hub accepted the poll (QUESTION_ACCEPTED_HEADER, which goes out at
//    once): deny with the ask-again reason, whatever the persisted mode says.
//  - Otherwise, with the persisted mode on: deny. A hub that was not reached,
//    or that answered with an error status, gets the plain-text reason; an
//    older hub (no header) whose answer was lost, unreadable, or held until
//    the hook's limit gets the ask-again reason.
//  - Otherwise print nothing.
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
  tool_use_id: z.string().optional(),
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
  // A hub that sends no header is an older one: it answers only when the poll is over.
  let accepted = false;
  // The one rule for a technical end; the persisted mode tells whether the owner counts on Telegram.
  const technicalEnd = (why: EndedWhy | "unreachable"): Output | undefined => {
    if (parentGone) return undefined;
    if (accepted && why !== "unreachable") return deny(endedReason(why));
    if (readSessionMode(paths().sessionsFile, input.session_id) !== true) return undefined;
    return deny(why === "unreachable" ? HUB_UNREACHABLE_REASON : endedReason(why));
  };
  let res: Response;
  try {
    // timeout: false turns off Bun's 5-minute idle timer on the held request.
    res = await fetch(`http://127.0.0.1:${hubPort()}/question`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messagingSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET,
        session_id: input.session_id,
        tool_use_id: input.tool_use_id,
        tool_input: input.tool_input,
      }),
      timeout: false,
      signal: stop.signal,
    });
  } catch {
    // No response: nothing listens, the hub closed the connection before accepting, or the hook's own end
    // came first. Its own end before any response is a request an older hub held until the limit.
    return technicalEnd(timedOut ? "timeLimit" : "unreachable");
  }
  if (!res.ok) return technicalEnd("unreachable");
  accepted = res.headers.has(QUESTION_ACCEPTED_HEADER);
  let body: string;
  try {
    body = await res.text();
  } catch {
    return technicalEnd(timedOut ? "timeLimit" : "connectionLost");
  }
  let decision;
  try {
    decision = questionDecision.safeParse(JSON.parse(body));
  } catch {
    return technicalEnd("unreadableAnswer");
  }
  if (!decision.success) return technicalEnd("unreadableAnswer");
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
