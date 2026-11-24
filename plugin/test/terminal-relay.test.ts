import { expect, test } from "bun:test";
import { TerminalRelay, type TerminalSnapshot } from "../src/hub/terminal-relay.ts";
import { rigRunSchema } from "../src/hub/rig-session.ts";

const snapshot: TerminalSnapshot = { session: "s1", generation: "generation", revision: 1, screen: "Trust this folder?", status: "running", recoveries: 0 };

test("remote startup can finish its launch call while the terminal awaits its owner", () => {
  expect(rigRunSchema.parse({ session: "s1", pid: 42, mode: null, account: null, terminal: true }).terminal).toBe(true);
});

test("terminal input uses the displayed generation and revision; a duplicate button is consumed", async () => {
  const actions: unknown[] = [];
  const frames: { buttons: { text: string; data: string }[][] }[] = [];
  const relay = new TerminalRelay({ directory: "/unused", request: async (_sid, input) => { if (input) actions.push(input); return { ...snapshot }; },
    show: (_sid, _text, _entities, buttons) => frames.push({ buttons }), connected: () => false, known: () => true, warn: () => {} });
  await relay.command("s1", "");
  const enter = frames[0].buttons.flat().find(button => button.text === "Enter")!;
  expect(await relay.press(enter.data)).toBe("Sent");
  expect(await relay.press(enter.data)).toBe("Request outdated; use /terminal");
  expect(actions).toEqual([{ generation: "generation", revision: 1, key: "enter" }]);
});

test("a text message becomes terminal input only through the explicit terminal command", async () => {
  const actions: unknown[] = [];
  const frames: { text: string; data: string }[][][] = [];
  const relay = new TerminalRelay({ directory: "/unused", request: async (_sid, input) => { if (input) actions.push(input); return { ...snapshot }; },
    show: (_sid, _text, _entities, buttons) => { frames.push(buttons); }, connected: () => false, known: () => true, warn: () => {} });
  await relay.command("s1", "");
  await expect(relay.command("s1", "text literal answer")).rejects.toThrow("Text");
  expect(actions).toEqual([]);
  const chooseText = frames.at(-1)!.flat().find(button => button.text === "Text")!;
  await relay.press(chooseText.data);
  await relay.command("s1", "text literal answer");
  expect(actions).toEqual([{ generation: "generation", revision: 1, text: "literal answer" }]);
});
