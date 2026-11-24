// The AskUserQuestion calls of the main transcript that have no result yet and
// that nothing since has overtaken: the questions a session may be waiting on
// in its terminal. Fed with every record of the main transcript, in order.
//
// A call is open from its tool_use record until its tool_result. The agent
// cannot go on while a dialog is open, so any later sign of the session's life
// shows that the call is not (or no longer) held: an interrupt, input typed in
// the terminal, a message of ours taken, the end of a turn, or a record of
// another agent message. Records of subagents (sidechains) never count; the
// parser already drops them.
import { arr, field, isObject, str } from "../shared/guards.ts";
import { parseRecord } from "./parse.ts";

export const ASK_TOOL = "AskUserQuestion";

export type OpenDialog = { id: string; questions: string[] };

type Entry = OpenDialog & { messageId: string };

export class OpenDialogs {
  private entries = new Map<string, Entry>();

  see(rec: unknown): void {
    if (!isObject(rec) || rec.isSidechain === true) return;
    if (rec.type === "user") this.close(rec);
    for (const ev of parseRecord(rec)) {
      switch (ev.kind) {
        case "interrupted":
        case "terminal_input":
        case "channel_seen":
        case "turn_closed":
        case "turn_end":
          this.entries.clear();
          break;
        case "text":
        case "tool_use":
          for (const [id, e] of this.entries) if (e.messageId !== ev.messageId) this.entries.delete(id);
          break;
      }
    }
    if (rec.type === "assistant") this.add(rec);
  }

  // The calls that still wait, oldest first.
  open(): OpenDialog[] {
    return [...this.entries.values()].map(({ id, questions }) => ({ id, questions }));
  }

  clear(): void {
    this.entries.clear();
  }

  private close(rec: Record<string, unknown>): void {
    for (const block of arr(field(rec.message, "content"))) {
      if (field(block, "type") === "tool_result") {
        const id = str(field(block, "tool_use_id"));
        if (id) this.entries.delete(id);
      }
    }
  }

  private add(rec: Record<string, unknown>): void {
    const messageId = str(field(rec.message, "id"));
    if (!messageId) return;
    for (const block of arr(field(rec.message, "content"))) {
      if (field(block, "type") !== "tool_use" || field(block, "name") !== ASK_TOOL) continue;
      const id = str(field(block, "id"));
      const questions = arr(field(field(block, "input"), "questions")).map(q => str(field(q, "question"))).filter((q): q is string => !!q);
      if (id && questions.length) this.entries.set(id, { id, messageId, questions });
    }
  }
}
