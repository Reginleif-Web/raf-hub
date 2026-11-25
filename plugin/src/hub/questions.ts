// An AskUserQuestion poll in a topic: the message text and buttons of each
// question, and the callback data the buttons carry.
import type { Messages } from "../shared/i18n/index.ts";
import type { Entity, Formatted } from "../shared/markdown.ts";
import type { AskQuestion, QuestionDecision, QuestionFrame } from "../shared/protocol.ts";
import type { Button } from "./telegram.ts";

import { chunk, MAX_MESSAGE } from "../shared/chunk.ts";
import { reasonWithAnswers } from "../shared/question-answers.ts";
import { MAX_REPLY_CHARS } from "./reply-context.ts";

// A preview longer than this is cut; a text longer than TEXT_LIMIT goes
// without previews, and is cut if still longer, leaving room for the
// outcome line under it.
const PREVIEW_CHARS = 700;
const TEXT_LIMIT = 3700;
const BUTTON_CHARS = 64;
// One question of the dialog warning: the same bound as a quoted reply (MAX_REPLY_CHARS), a few lines of text,
// so that a dozen questions still fit in one message.
const DIALOG_QUESTION_CHARS = MAX_REPLY_CHARS;
const ELLIPSIS = "…";

export const POLL_PREFIX = "q:";
// Goes to the agent, so always English.
export const CANCEL_REASON = "The user cancelled the question in Telegram. Do not ask it again; end your turn and wait for their message.";

// The session is being stopped, cleaned or restarted while its Telegram mode is on: a poll it had open is
// ended, and a question that comes meanwhile is refused. The deny keeps the agent out of a terminal dialog the
// owner cannot see; it must also not make the agent ask again, as the new session is not ready for it. Goes to
// the agent, so always English.
export const SESSION_RESTARTING_REASON = "The session is being stopped or restarted, so the question was not asked in Telegram. Nothing was answered and nothing was asked in the terminal. Do not ask it again now; end your turn.";

// Why a poll that the owner could not answer was refused with a deny. The deny keeps the agent from falling
// into a terminal dialog the owner cannot see; the reason tells it what happened and what to do. Goes to
// the agent, so always English.
export type AskAgainWhy = "hubStopping" | "windowGone";

const ASK_AGAIN_WHY: Record<AskAgainWhy, string> = {
  hubStopping: "the Telegram hub was restarting",
  windowGone: "the connection of this session to the Telegram hub was lost",
};

// Telegram rejected the message with the question. A rejection that persists (a text too long or malformed)
// repeats on every new call, and no outside event stops that, so the agent is not told to call the tool again:
// it writes the question as plain text, which reaches the topic as a normal message. Every other ask-again
// reason ends with an outside event (a hub restart, a lost window, the 24 h limit, an owner's press) before
// the next round. Goes to the agent, so always English.
export const NOT_SHOWN_REASON =
  "Telegram did not accept the message with the question (it may be too long or malformed), so it was not shown, and nothing was asked in the terminal. Do not call AskUserQuestion again for this question. Write the question as plain text in your reply, shorter or simpler if it was long, and end your turn; the owner answers in a normal message.";

// With answers (the questions of the poll the owner had answered before it ended), the reason names them and
// asks only for the rest; without, it is the text it always was.
export function askAgainReason(why: AskAgainWhy, answers?: Record<string, string>): string {
  return reasonWithAnswers(
    {
      without: `The question got no answer in Telegram because ${ASK_AGAIN_WHY[why]}. Nothing was answered and nothing was asked in the terminal. Ask it again with a single AskUserQuestion call, shorter or simpler if it was long.`,
      withAnswers: `Not all questions got an answer in Telegram because ${ASK_AGAIN_WHY[why]}, and nothing was asked in the terminal.`,
      askRest: "Do not ask the answered questions again: ask only the unanswered ones, with a single AskUserQuestion call, shorter or simpler if it was long.",
    },
    answers,
  );
}

export function notShownReason(answers?: Record<string, string>): string {
  return reasonWithAnswers(
    {
      without: NOT_SHOWN_REASON,
      withAnswers: "Telegram did not accept the message with the next question (it may be too long or malformed), so it was not shown, and nothing was asked in the terminal.",
      askRest: "Do not call AskUserQuestion again for the unanswered questions, and do not ask the answered ones again. Write only the unanswered questions as plain text in your reply, shorter or simpler if they were long, and end your turn; the owner answers in a normal message.",
    },
    answers,
  );
}

// A deny for a technical end, built when the poll ends from the answers it got by then (see finishPoll).
export type Refusal = (answers: Record<string, string>) => string;

// An open poll. Questions go one at a time: index is the one shown now.
// Each shown question has its message id once sent and its outcome line
// once answered; an outcome set before the send goes with the send.
// Polls of one session are served one after another in the order they came:
// only the first of them is started (catching up, shown, answered); the rest
// wait unseen until it ends.
export type Poll = {
  key: string;
  sessionId: string;
  // The tool call it asks for (an older hook sends no id).
  toolUseId?: string | undefined;
  started: boolean;
  questions: AskQuestion[];
  answers: Record<string, string>;
  index: number;
  checked: Set<number>;
  messageIds: (number | undefined)[];
  // The question being sent right now, and a promise that settles when its send ends, with an id or without. A
  // message that came meanwhile is told apart from the question only by message ids, so it waits for this.
  sending?: { index: number; settled: Promise<void> } | undefined;
  outcomes: (string | undefined)[];
  // Topic messages taken as answers: their ✍ comes off once the agent has them.
  taken: number[];
  // Topic messages that joined an answer group and are kept in the terminal inbox (so a killed hub does not
  // lose them): marked seen once their answer reached the hook, or when the poll ends.
  heldIds?: number[] | undefined;
  // Writes an accepted answer to the hook that asked for the stream, and says whether it went out; undefined for
  // a hook that did not ask.
  stream?: ((frame: QuestionFrame) => boolean) | undefined;
  done: boolean;
  resolve(d: QuestionDecision): void;
};

export type PollAction = number | "done" | "custom" | "cancel";
export type PollPress = { key: string; index: number; action: PollAction };

// The text of question i: its header in bold (numbered when there are
// several), the question, then the numbered options with their previews.
export function questionText(m: Messages, questions: AskQuestion[], i: number): Formatted {
  const full = build(m, questions, i, true);
  return full.text.length > TEXT_LIMIT ? cutText(build(m, questions, i, false), TEXT_LIMIT) : full;
}

function build(m: Messages, questions: AskQuestion[], i: number, previews: boolean): Formatted {
  const q = questions[i];
  const entities: Entity[] = [];
  let text = "";
  const head = m.pollHead({ index: i + 1, total: questions.length, header: q.header });
  if (head) {
    entities.push({ type: "bold", offset: 0, length: head.length });
    text = `${head}\n`;
  }
  text += `${q.question}\n`;
  q.options.forEach((o, n) => {
    text += `\n${n + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`;
    if (previews && o.preview) {
      const preview = cut(o.preview, PREVIEW_CHARS);
      entities.push({ type: "pre", offset: text.length + 1, length: preview.length });
      text += `\n${preview}`;
    }
  });
  return { text, entities };
}

// The message with its outcome line under it, within one Telegram message.
export function withOutcome(f: Formatted, outcome: string): Formatted {
  const body = cutText(f, MAX_MESSAGE - outcome.length - 2);
  return { text: `${body.text}\n\n${outcome}`, entities: body.entities };
}

// A formatted text cut to max characters, the ellipsis included, at a
// paragraph, line or word boundary where it can.
function cutText(f: Formatted, max: number): Formatted {
  if (f.text.length <= max) return f;
  const head = chunk(f, max - ELLIPSIS.length)[0] ?? { text: "", entities: [] };
  return { text: `${head.text}${ELLIPSIS}`, entities: head.entities };
}

export function questionButtons(m: Messages, p: Poll): Button[][] {
  const q = p.questions[p.index];
  const data = (a: PollAction) => `${POLL_PREFIX}${p.key}:${p.index}:${a}`;
  const rows = q.options.map((o, n) => [{ text: cut(`${p.checked.has(n + 1) ? "☑️ " : ""}${n + 1}. ${o.label}`, BUTTON_CHARS), data: data(n + 1) }]);
  if (q.multiSelect) rows.push([{ text: m.pollDone, data: data("done") }]);
  rows.push([
    { text: m.pollCustom, data: data("custom") },
    { text: m.pollCancel, data: data("cancel") },
  ]);
  return rows;
}

export function parsePollPress(data: string): PollPress | undefined {
  const m = /^q:([0-9a-f]+):(\d+):(\d+|done|custom|cancel)$/.exec(data);
  if (!m) return undefined;
  const a = m[3];
  const action: PollAction = a === "done" || a === "custom" || a === "cancel" ? a : Number(a);
  return { key: m[1], index: Number(m[2]), action };
}

// The labels checked in a multiple choice, in option order.
export function checkedLabels(q: AskQuestion, checked: Set<number>): string {
  return q.options
    .filter((_, n) => checked.has(n + 1))
    .map(o => o.label)
    .join(", ");
}

// An answer as the outcome line shows it: cut like a reply's quote.
export function answerLine(answer: string): string {
  return `✅ ${cut(answer, MAX_REPLY_CHARS)}`;
}

// The warning that a session waits on a dialog in its terminal, listing the dialog's questions. The list comes
// from the plugin and has any length and count, but the warning is one message, so it is never split or refused
// by Telegram: each question is cut to DIALOG_QUESTION_CHARS, and the questions that do not fit in MAX_MESSAGE
// are replaced by a line counting them.
export function dialogWarning(m: Messages, questions: string[]): string {
  const fitted: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const next = [...fitted, cut(questions[i], DIALOG_QUESTION_CHARS)];
    const left = questions.length - i - 1;
    if (m.dialogWaiting({ questions: left ? [...next, m.dialogMore({ count: left })] : next }).length > MAX_MESSAGE) {
      return m.dialogWaiting({ questions: [...fitted, m.dialogMore({ count: questions.length - i })] });
    }
    fitted.push(next[i]);
  }
  return m.dialogWaiting({ questions: fitted });
}

// Cuts by code points, so an emoji is never split.
function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}${ELLIPSIS}` : s;
}
