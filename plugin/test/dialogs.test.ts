import { describe, expect, test } from "bun:test";
import { OpenDialogs } from "../src/transcript/dialogs.ts";

const question = (text: string) => ({ question: text, header: "H", options: [{ label: "A", description: "" }], multiSelect: false });
const ask = (id: string, messageId: string, ...texts: string[]) => ({
  type: "assistant",
  isSidechain: false,
  message: { id: messageId, role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: texts.map(question) } }], stop_reason: "tool_use" },
});
const tool = (id: string, messageId: string, name = "Bash") => ({
  type: "assistant",
  isSidechain: false,
  message: { id: messageId, role: "assistant", content: [{ type: "tool_use", id, name, input: {} }], stop_reason: "tool_use" },
});
const text = (messageId: string, body: string, stop = "tool_use") => ({
  type: "assistant",
  isSidechain: false,
  message: { id: messageId, role: "assistant", content: [{ type: "text", text: body }], stop_reason: stop },
});
const result = (id: string) => ({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

function tracker(...recs: unknown[]) {
  const d = new OpenDialogs();
  for (const r of recs) d.see(r);
  return d;
}

describe("OpenDialogs", () => {
  test("a question call without a result is open, with its question texts", () => {
    expect(tracker(ask("u1", "m1", "Which colour?", "Which size?")).open()).toEqual([{ id: "u1", questions: ["Which colour?", "Which size?"] }]);
  });

  test("a result with the call's id closes it, the result of another call does not", () => {
    expect(tracker(ask("u1", "m1", "Q?"), result("other")).open().map(d => d.id)).toEqual(["u1"]);
    expect(tracker(ask("u1", "m1", "Q?"), result("u1")).open()).toEqual([]);
  });

  test("a call in a sidechain record is ignored", () => {
    expect(tracker({ ...ask("u1", "m1", "Q?"), isSidechain: true }).open()).toEqual([]);
  });

  test("a call without questions is not a dialog", () => {
    expect(tracker(ask("u1", "m1")).open()).toEqual([]);
    expect(tracker({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "u1", name: "AskUserQuestion", input: {} }] } }).open()).toEqual([]);
  });

  test("other tools and malformed records are ignored", () => {
    expect(tracker(tool("u1", "m1"), null, "x", 5, { type: "assistant" }, { type: "assistant", message: { id: "m1", content: "x" } }).open()).toEqual([]);
  });

  test("an interrupt, typed input, a channel message and the end of a turn each clear it", () => {
    const interrupted = { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } };
    const typed = { type: "user", isSidechain: false, origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: "hi" } };
    const closed = { type: "system", subtype: "turn_duration", durationMs: 1 };
    const channel = { type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: '<channel source="telegram-hub" message_id="5">x</channel>', commandMode: "prompt", origin: { kind: "channel", server: "plugin:telegram-hub:telegram-hub" } } };
    for (const rec of [interrupted, typed, closed, channel, text("m2", "done", "end_turn")]) {
      expect(tracker(ask("u1", "m1", "Q?"), rec).open()).toEqual([]);
    }
  });

  test("a later message of the agent drops it, a later record of the same message does not", () => {
    expect(tracker(ask("u1", "m1", "Q?"), tool("u2", "m1")).open().map(d => d.id)).toEqual(["u1"]);
    expect(tracker(ask("u1", "m1", "Q?"), text("m2", "next")).open()).toEqual([]);
    expect(tracker(ask("u1", "m1", "Q?"), tool("u2", "m2")).open()).toEqual([]);
  });

  test("clear forgets every open dialog", () => {
    const d = tracker(ask("u1", "m1", "Q?"));
    d.clear();
    expect(d.open()).toEqual([]);
  });
});
