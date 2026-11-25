#!/usr/bin/env bun
// PreToolUse hook for AskUserQuestion: while Telegram mode is on, the hub asks
// the questions in the topic and holds the request until they are answered.
//
// One rule for every end that is not an answer (no connection, an error status,
// a lost or unreadable answer, the hook's own time limit, an explicit "none"),
// before the hub accepted the poll or after it. While the session's Telegram
// mode is on, the owner reads Telegram and not the terminal, so the terminal
// dialog opens only when the persisted mode of the session is not on at the
// moment the hook decides (off, unknown, a session missing from the file or an
// unreadable file). A new hub answers "none" only with the mode off, but an
// older one also does for technical reasons with the mode on (a second call
// ended the poll, the window went away, the hub was stopping), so "none" alone
// never opens the dialog.
//  - The parent is gone: nobody reads the output, print nothing.
//  - An explicit "none": with the persisted mode on, deny with the plain-text
//    reason; otherwise print nothing.
//  - The hub accepted the poll (QUESTION_ACCEPTED_HEADER, which goes out at
//    once): deny, whatever the persisted mode says.
//  - Otherwise, with the persisted mode on: deny.
//  A lost connection after acceptance and the hook's limit ask for the question
//  again: each needs an outside event per round. An end that would repeat by
//  itself (a hub not reached, an error status, an unreadable answer, a response
//  cut off before the acceptance header, "none" with the mode on) gets the
//  plain-text reason, so the agent never loops.
//  - Otherwise print nothing.
//
// The hook asks for the stream (QUESTION_STREAM_HEADER): a hub that knows it sends each answer the owner
// gives as a line at once, and the decision as the last line. If the wait then ends for a technical reason that
// only the hook sees (a lost connection, the hook's limit, an unreadable end), the answers received are named
// in the deny, with the instruction to ask only the unanswered questions (all answered: they are the allow).
// This end is the only place that adds them: a deny the hub sends is printed as is. A hub that does not know
// the header sends one JSON at the end, and the texts are the same as before.
import { z } from "zod";
import { isAlive } from "../shared/process-alive.ts";
import { hubPort, paths } from "../shared/config.ts";
import { QUESTION_ACCEPTED_HEADER, QUESTION_STREAM_HEADER } from "../shared/protocol.ts";
import { questionDecision, questionFrame } from "../shared/protocol-schema.ts";
import { readSessionMode } from "../hub/sessions.ts";
import { PARENT_CHECK_MS, QUESTION_DEADLINE_MS } from "./question-limits.ts";
import { readLines } from "./question-lines.ts";
import { endedReason, unreachableReason } from "./question-reasons.ts";
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
  // The answers the hub sent as they were given (a hub that knows QUESTION_STREAM_HEADER), by question text.
  // A Map, so a question named like an Object property stays an ordinary key.
  const answered = new Map<string, string>();
  const answersSoFar = () => Object.fromEntries(answered);
  const allow = (answers: Record<string, string>): Output => ({ permissionDecision: "allow", permissionDecisionReason: "Answered in Telegram", updatedInput: { ...input.tool_input, answers } });
  // Every question of the call has an answer: only the decision itself was missing.
  // Answers go by question text, so one answer never stands for two questions with the same text.
  const allAnswered = () => {
    const texts = input.tool_input.questions.map(q => (q as { question?: unknown } | undefined)?.question);
    return texts.length > 0 && new Set(texts).size === texts.length && texts.every(t => typeof t === "string" && answered.has(t));
  };
  // The one rule for a technical end; the persisted mode tells whether the owner counts on Telegram. The reason
  // is built here, from the answers received, so the hub never has to repeat them (and never does for a hook that
  // ended the wait itself).
  const modeOn = () => readSessionMode(paths().sessionsFile, input.session_id) === true;
  const technicalEnd = (why: EndedWhy | "notTaken"): Output | undefined => {
    if (parentGone || !(accepted || modeOn())) return undefined;
    const answers = answersSoFar();
    return deny(why === "notTaken" ? unreachableReason(answers) : endedReason(why, answers));
  };
  // An end without a decision: when every question was already answered, those answers are the decision.
  const endWithoutDecision = (why: EndedWhy | "notTaken"): Output | undefined => (!parentGone && accepted && allAnswered() ? allow(answersSoFar()) : technicalEnd(why));
  let res: Response;
  try {
    // timeout: false turns off Bun's 5-minute idle timer on the held request.
    res = await fetch(`http://127.0.0.1:${hubPort()}/question`, {
      method: "POST",
      headers: { "content-type": "application/json", [QUESTION_STREAM_HEADER]: "1" },
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
    return technicalEnd(timedOut ? "timeLimit" : "notTaken");
  }
  if (!res.ok) return technicalEnd("notTaken");
  accepted = res.headers.has(QUESTION_ACCEPTED_HEADER);
  // The body is read as lines, whatever way it is cut into chunks: a hub that streams sends an answer frame per
  // line and the decision as the last line; an older one sends one JSON without a newline. Only complete lines
  // are taken while reading; the rest after the last newline is the decision of an older hub (taken at the end).
  let decisionLine: string | undefined;
  const take = (line: string) => {
    const text = line.trim();
    if (!text) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      decisionLine = text;
      return;
    }
    const frame = questionFrame.safeParse(value);
    if (frame.success) answered.set(frame.data.answered.question, frame.data.answered.answer);
    else decisionLine = text;
  };
  try {
    await readLines(res.body, take);
  } catch {
    // A decision that arrived whole (a line ended by its newline) stands, even if the connection broke right after.
    // Asking again is for a hub that took the poll. A response cut off before the acceptance header is a hub
    // that never took it (or an older one), and the same cut would repeat by itself: the plain-text reason.
    if (decisionLine === undefined) return endWithoutDecision(timedOut ? "timeLimit" : accepted ? "connectionLost" : "notTaken");
  }
  if (decisionLine === undefined) return endWithoutDecision("notTaken");
  let decision;
  try {
    decision = questionDecision.safeParse(JSON.parse(decisionLine));
  } catch {
    return endWithoutDecision("notTaken");
  }
  if (!decision.success) return endWithoutDecision("notTaken");
  const d = decision.data;
  // The terminal dialog opens only when the persisted mode is not on right now: a new hub answers none only
  // with the mode off, but an older one also does for technical ends, and then the owner reads Telegram.
  if (d.decision === "none") return parentGone || !modeOn() ? undefined : deny(unreachableReason(answersSoFar()));
  if (d.decision === "deny") return deny(d.reason);
  return allow(d.answers);
}

try {
  const output = await decide();
  // Awaited: process.exit below must not cut a large answer short.
  if (output) await Bun.write(Bun.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...output } }));
} catch {}
process.exit(0);
