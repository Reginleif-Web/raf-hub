import { expect, test } from "bun:test";
import { join } from "path";
import { TerminalInbox, transcriptMessageIds } from "../src/hub/terminal-inbox.ts";
import { tempDir } from "./helpers.ts";
import { topicMsg } from "./fake-telegram.ts";

test("startup messages survive a hub restart in order and disappear only when seen", () => {
  const file = join(tempDir(), "inbox.json");
  const first = topicMsg({ chatId: "-1", threadId: 24, fromId: "7", text: "first" }).message!;
  const second = { ...first, message_id: first.message_id + 1, text: "second" };
  const inbox = new TerminalInbox(file);
  inbox.add("s1", second);
  inbox.add("s1", first);
  inbox.add("s1", first);
  const restored = new TerminalInbox(file);
  expect(restored.entries()).toEqual([["s1", [first, second]]]);
  restored.seen([first.message_id]);
  expect(new TerminalInbox(file).entries()).toEqual([["s1", [second]]]);
  restored.seen([second.message_id]);
  expect(new TerminalInbox(file).entries()).toEqual([]);
});

test("durable channel entries retire an acknowledgement lost during a hub restart", () => {
  const tag = '<channel source="plugin:telegram-hub:telegram-hub" chat_id="-1" message_id="12" message_ids="12,15">hello</channel>';
  const origin = { kind: "channel", server: "plugin:telegram-hub:telegram-hub" };
  const rows = [
    { type: "user", isMeta: true, origin, message: { content: tag } },
    { type: "user", message: { content: [{ type: "tool_result", content: tag.replace('12', '13') }] } },
    { type: "assistant", message: { content: [{ type: "text", text: tag.replace('12', '14') }] } },
    { type: "user", isMeta: true, origin, message: { content: tag.replace('chat_id="-1"', 'chat_id="-2"') } },
  ];
  expect(transcriptMessageIds(rows.map(row => JSON.stringify(row)).join('\n'), "-1")).toEqual([12, 15]);
});
