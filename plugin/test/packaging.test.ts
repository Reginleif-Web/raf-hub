import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { PLATFORM } from "../src/shared/platform.ts";
import { z } from "zod";
import { QUESTION_DEADLINE_MS } from "../src/hook/question-limits.ts";
import { isAlive } from "../src/shared/process-alive.ts";
import { Hub } from "../src/hub/hub.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { freePort, memLogger, must, tempDir, waitFor, wsClient } from "./helpers.ts";

const PLUGIN = resolve(import.meta.dir, "..");
const REPO = resolve(PLUGIN, "..");
const HOOK = join(PLUGIN, "src", "hook", "session-start.ts");
const STOP_HOOK = join(PLUGIN, "src", "hook", "stop.ts");
const STOP_FAILURE_HOOK = join(PLUGIN, "src", "hook", "stop-failure.ts");
const QUESTION_HOOK =join(PLUGIN, "src", "hook", "question.ts");
const SLOW_READER_MS = 500;
const TEST_DEADLINE_MS = 300;
const MS_PER_SECOND = 1000;
// How far under the hooks.json timeout the hook's own deadline may sit.
const DEADLINE_MARGIN_MAX_MS = 5 * 60_000;
const PARENT_GONE_WAIT_MS = 10_000;
const PARENT_GONE_TEST_MS = 30_000;
// Starts the hook with its own stdin, prints its pid and lives on until killed.
// Detached, so the hook outlives it, as it would outlive a dead Claude Code.
const PARENT_SCRIPT = "const c = require(\"child_process\").spawn(process.execPath, [process.env.HOOK_PATH], { stdio: [\"inherit\", \"ignore\", \"ignore\"], detached: true, windowsHide: true }); console.log(c.pid); await Bun.sleep(1e9);";
// The same, with the hook's stdout going to the file OUT_PATH, to see whether the hook printed anything.
const PARENT_SCRIPT_TO_FILE = "const fd = require(\"fs\").openSync(process.env.OUT_PATH, \"w\"); const c = require(\"child_process\").spawn(process.execPath, [process.env.HOOK_PATH], { stdio: [\"inherit\", fd, \"ignore\"], detached: true, windowsHide: true }); console.log(c.pid); await Bun.sleep(1e9);";

// Async on purpose: an in-process hub must keep serving while the hook runs.
async function runHook(port: number, input: object, socket = "pipe-H") {
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, HOOK], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    env: { ...process.env, TELEGRAM_HUB_PORT: String(port), CLAUDE_CODE_MESSAGING_SOCKET: socket },
    windowsHide: true,
  });
  const stdout = await new Response(proc.stdout).text();
  const status = await proc.exited;
  return { status, stdout, ms: Date.now() - started };
}

describe("SessionStart hook", () => {
  let hub: Hub | undefined;
  const clients: { close(): void }[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await hub?.stop();
  });

  test("tells the hub which session the window now runs", async () => {
    const dir = tempDir();
    hub = new Hub({ port: 0, sessionsFile: join(dir, "s.json"), outboxFile: join(dir, "o.json"), filesDir: join(dir, "files"), inboxDir: dir, api: undefined, config: () => ({ allowFrom: [], turnEndChime: "" }), idleMs: 60_000, log: memLogger(), onExit() {} });
    hub.start();
    const port = hub.port;
    const c = await wsClient(port, { type: "hello", v: PROTOCOL_VERSION, windowKey: "pipe-H", sessionId: "old", cwd: "C:\\p" });
    clients.push(c);
    const r = await runHook(port, { session_id: "new", transcript_path: "C:\\t\\new.jsonl", cwd: "C:\\p", hook_event_name: "SessionStart", source: "clear" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const sw = await c.next("switchSession");
    expect(sw).toMatchObject({ sessionId: "new", transcriptPath: "C:\\t\\new.jsonl" });
  });

  test("exits quietly and quickly when no hub is running", async () => {
    const port = await freePort();
    const r = await runHook(port, { session_id: "s", transcript_path: "t", cwd: "c" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ms).toBeLessThan(3000);
  });

  test("survives garbage input", async () => {
    const port = await freePort();
    const r = spawnSync(process.execPath, [HOOK], { input: "not json", env: { ...process.env, TELEGRAM_HUB_PORT: String(port) }, encoding: "utf8", windowsHide: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("Stop hook", () => {
  let hub: Hub | undefined;
  const clients: { close(): void }[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await hub?.stop();
  });

  // The state dir holds a config whose chime command adds its kind as a line to a file.
  function chimeSetup() {
    const dir = tempDir();
    const marker = join(dir, "chimed.txt");
    const script = join(dir, "chime.ts");
    writeFileSync(script, `import { appendFileSync } from "fs";\nappendFileSync(${JSON.stringify(marker)}, (process.argv[2] ?? "") + "\\n");\n`);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], turnEndChime: `"${process.execPath}" "${script}" {kind}` }));
    const chimes = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(l => l !== "") : []);
    return { dir, chimes };
  }

  async function runStop(port: number, input: object, stateDir: string, socket = "pipe-S") {
    const proc = Bun.spawn([process.execPath, STOP_HOOK], {
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      env: { ...process.env, TELEGRAM_HUB_PORT: String(port), TELEGRAM_HUB_STATE_DIR: stateDir, CLAUDE_CODE_MESSAGING_SOCKET: socket },
      windowsHide: true,
    });
    const stdout = await new Response(proc.stdout).text();
    return { status: await proc.exited, stdout };
  }

  test("tells the window how the turn ended, without a sound of its own", async () => {
    const { dir, chimes } = chimeSetup();
    hub = new Hub({ port: 0, sessionsFile: join(dir, "s.json"), outboxFile: join(dir, "o.json"), filesDir: join(dir, "files"), inboxDir: dir, api: undefined, config: () => ({ allowFrom: [], turnEndChime: "" }), idleMs: 60_000, log: memLogger(), onExit() {} });
    hub.start();
    const port = hub.port;
    const c = await wsClient(port, { type: "hello", v: PROTOCOL_VERSION, windowKey: "pipe-S", sessionId: "s", cwd: "C:\\p" });
    clients.push(c);
    const r = await runStop(port, { session_id: "s", hook_event_name: "Stop", last_assistant_message: "\u0413\u043e\u0442\u043e\u0432\u043e. \u0414\u0430\u043b\u044c\u0448\u0435?", background_tasks: [{ id: "t" }] }, dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(await c.next("turnEnd")).toEqual({ type: "turnEnd", final: true, kind: "ask" });
    // A hook with no hub to tell chimes; by then a chime of the first would be heard too.
    expect((await runStop(await freePort(), { session_id: "s", last_assistant_message: "\u0413\u043e\u0442\u043e\u0432\u043e." }, dir)).status).toBe(0);
    if (!PLATFORM.sound) {
      expect(chimes()).toEqual([]);
      return;
    }
    await waitFor(() => chimes().length > 0, 5000, "chime");
    expect(chimes()).toEqual(["done"]);
  });

  test("the StopFailure hook tells the window its turn ended on an API error", async () => {
    const dir = tempDir();
    hub = new Hub({ port: 0, sessionsFile: join(dir, "s.json"), outboxFile: join(dir, "o.json"), filesDir: join(dir, "files"), inboxDir: dir, api: undefined, config: () => ({ allowFrom: [], turnEndChime: "" }), idleMs: 60_000, log: memLogger(), onExit() {} });
    hub.start();
    const port = hub.port;
    const c = await wsClient(port, { type: "hello", v: PROTOCOL_VERSION, windowKey: "pipe-F", sessionId: "s", cwd: "C:\\p" });
    clients.push(c);
    const input = { session_id: "s", hook_event_name: "StopFailure", error: "server_error", last_assistant_message: "API Error: Connection lost mid-response." };
    const proc = Bun.spawn([process.execPath, STOP_FAILURE_HOOK], {
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      env: { ...process.env, TELEGRAM_HUB_PORT: String(port), CLAUDE_CODE_MESSAGING_SOCKET: "pipe-F" },
      windowsHide: true,
    });
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await proc.exited).toBe(0);
    expect(await c.next("turnFailed")).toEqual({ type: "turnFailed" });
  });

  test("with no hub a final turn plays the chime itself, an intermediate one does not", async () => {
    const port = await freePort();
    const { dir, chimes } = chimeSetup();
    const quiet = await runStop(port, { session_id: "s", last_assistant_message: "\u0416\u0434\u0443.", background_tasks: [{ id: "t" }] }, dir);
    expect(quiet.status).toBe(0);
    const loud = await runStop(port, { session_id: "s", last_assistant_message: "\u0413\u043e\u0442\u043e\u0432\u043e." }, dir);
    expect(loud.status).toBe(0);
    expect(loud.stdout).toBe("");
    if (!PLATFORM.sound) {
      expect(chimes()).toEqual([]);
      return;
    }
    await waitFor(() => chimes().length > 0, 5000, "chime");
    expect(chimes()).toEqual(["done"]);
  });

  test("survives garbage input", async () => {
    const port = await freePort();
    const r = spawnSync(process.execPath, [STOP_HOOK], { input: "not json", env: { ...process.env, TELEGRAM_HUB_PORT: String(port) }, encoding: "utf8", windowsHide: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("AskUserQuestion hook", () => {
  const QUESTIONS = [{ question: "\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?", header: "\u0426\u0432\u0435\u0442", options: [{ label: "\u0421\u0438\u043d\u0438\u0439", description: "" }, { label: "\u041a\u0440\u0430\u0441\u043d\u044b\u0439", description: "" }], multiSelect: false }];
  const INPUT = { session_id: "s", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } };
  let server: { stop(force?: boolean): void } | undefined;
  let hub: Hub | undefined;
  const clients: { close(): void }[] = [];
  afterEach(async () => {
    server?.stop(true);
    server = undefined;
    for (const c of clients.splice(0)) c.close();
    await hub?.stop();
    hub = undefined;
  });

  // The hook reads the persisted mode of the session from its state dir when the hub is unreachable, so every
  // run gets an empty state dir of its own (never the real one) unless the test gives one.
  async function runQuestion(port: number, input: object, extraEnv: Record<string, string> = {}) {
    const proc = Bun.spawn([process.execPath, QUESTION_HOOK], {
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      env: { ...process.env, TELEGRAM_HUB_STATE_DIR: tempDir(), TELEGRAM_HUB_PORT: String(port), CLAUDE_CODE_MESSAGING_SOCKET: "pipe-Q", ...extraEnv },
      windowsHide: true,
    });
    const stdout = await new Response(proc.stdout).text();
    return { status: await proc.exited, stdout };
  }

  // A state dir whose sessions.json says whether Telegram mode of session "s" is on.
  function stateWithMode(enabled: boolean): string {
    const dir = tempDir();
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({ s: { title: "t", project: "p", enabled } }));
    return dir;
  }

  // The deny the hook prints, as the agent sees it.
  const denyOf = (stdout: string) => {
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("deny");
    return String(out.permissionDecisionReason);
  };
  // What every deny that says "the question was not answered" must tell the agent.
  const expectAskAgain = (reason: string) => {
    expect(reason).toContain("Nothing was answered");
    expect(reason).toContain("nothing was asked in the terminal");
    expect(reason).toContain("single AskUserQuestion call");
  };
  const expectUnreachable = (reason: string) => {
    expect(reason).toContain("unreachable");
    expect(reason).toContain("plain text");
    expect(reason).toContain("end your turn");
    expect(reason).toContain("Do not");
  };

  // A stand-in for a hub that has accepted the poll: the acceptance header and a first chunk go at once; what
  // comes after is up to the test. "drop" breaks the response mid-body, as a killed hub does.
  async function acceptingHub(after: "drop" | "garbage" | "hold" | "none" | "allow") {
    const port = await freePort();
    const seen = { got: 0, aborted: 0 };
    const enc = new TextEncoder();
    if (after === "drop") {
      // Raw HTTP, so the break comes at a fixed point and needs no timer: the headers and one chunk of a
      // chunked body go out, then the socket closes without the terminating chunk.
      let answered = false;
      server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data(socket) {
            if (answered) return;
            answered = true;
            seen.got++;
            socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-question-accepted: 1\r\ntransfer-encoding: chunked\r\n\r\n1\r\n \r\n");
            socket.end();
          },
          open() {},
          close() {},
          error() {},
        },
      });
      return { port, seen };
    }
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        srv.timeout(req, 0);
        seen.got++;
        req.signal.addEventListener("abort", () => seen.aborted++);
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(" "));
            if (after === "garbage") {
              c.enqueue(enc.encode("not json"));
              c.close();
            }
            if (after === "none") {
              c.enqueue(enc.encode(JSON.stringify({ decision: "none" })));
              c.close();
            }
            if (after === "allow") {
              c.enqueue(enc.encode(JSON.stringify({ decision: "allow", answers: { q: "a" } })));
              c.close();
            }
          },
        });
        return new Response(body, { headers: { "content-type": "application/json", "x-question-accepted": "1" } });
      },
    });
    return { port, seen };
  }

  // A stand-in hub that answers /question with the given decision and keeps the bodies it got.
  async function fakeHub(decision: object) {
    const port = await freePort();
    const bodies: unknown[] = [];
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (new URL(req.url).pathname !== "/question") return new Response("no", { status: 404 });
        bodies.push(await req.json());
        return Response.json(decision);
      },
    });
    return { port, bodies };
  }

  // A stand-in hub that holds /question until the hook drops it.
  async function holdingHub() {
    const port = await freePort();
    const seen = { got: 0, aborted: 0 };
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        srv.timeout(req, 0);
        seen.got++;
        return new Promise<Response>(resolve => {
          req.signal.addEventListener("abort", () => {
            seen.aborted++;
            resolve(new Response("gone"));
          });
        });
      },
    });
    return { port, seen };
  }

  test("the hook stops waiting at its own deadline", async () => {
    const { port, seen } = await holdingHub();
    const proc = Bun.spawn([process.execPath, QUESTION_HOOK], {
      stdin: new Blob([JSON.stringify(INPUT)]),
      stdout: "pipe",
      env: { ...process.env, TELEGRAM_HUB_PORT: String(port), TELEGRAM_HUB_QUESTION_DEADLINE_MS: String(TEST_DEADLINE_MS) },
      windowsHide: true,
    });
    const stdout = await new Response(proc.stdout).text();
    expect({ status: await proc.exited, stdout }).toEqual({ status: 0, stdout: "" });
    await waitFor(() => seen.aborted === 1);
  });

  test("the hook stops waiting when its parent is gone", async () => {
    const { port, seen } = await holdingHub();
    // A parent that starts the hook and then lives on until killed.
    const parent = Bun.spawn([process.execPath, "-e", PARENT_SCRIPT], {
      stdin: new Blob([JSON.stringify(INPUT)]),
      stdout: "pipe",
      env: { ...process.env, TELEGRAM_HUB_PORT: String(port), HOOK_PATH: QUESTION_HOOK },
      windowsHide: true,
    });
    const reader = parent.stdout.getReader();
    const first = await reader.read();
    const hookPid = Number(new TextDecoder().decode(first.value).trim());
    try {
      await waitFor(() => seen.got === 1);
      parent.kill();
      await parent.exited;
      await waitFor(() => seen.aborted === 1, PARENT_GONE_WAIT_MS);
      await waitFor(() => !isAlive(hookPid), PARENT_GONE_WAIT_MS);
    } finally {
      if (isAlive(hookPid)) process.kill(hookPid);
    }
  }, PARENT_GONE_TEST_MS);

  test("the hook's deadline is a little under its timeout in hooks.json", () => {
    const hooks = z
      .object({ hooks: z.object({ PreToolUse: z.array(z.object({ matcher: z.string(), hooks: z.array(z.object({ timeout: z.number() })) })) }) })
      .parse(JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8")));
    const timeoutMs = must(hooks.hooks.PreToolUse.find(h => h.matcher === "AskUserQuestion")?.hooks[0]).timeout * MS_PER_SECOND;
    expect(QUESTION_DEADLINE_MS).toBeLessThan(timeoutMs);
    expect(QUESTION_DEADLINE_MS).toBeGreaterThan(timeoutMs - DEADLINE_MARGIN_MAX_MS);
  });

  test("an answer from the topic allows the tool with the questions and the answers", async () => {
    const { port, bodies } = await fakeHub({ decision: "allow", answers: { "\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?": "\u0421\u0438\u043d\u0438\u0439" } });
    const r = await runQuestion(port, INPUT);
    expect(r.status).toBe(0);
    expect(bodies).toEqual([{ messagingSocket: "pipe-Q", session_id: "s", tool_input: { questions: QUESTIONS } }]);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Answered in Telegram",
        updatedInput: { questions: QUESTIONS, answers: { "\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?": "\u0421\u0438\u043d\u0438\u0439" } },
      },
    });
  });

  test("the allowed input keeps every field of the original tool input", async () => {
    const { port, bodies } = await fakeHub({ decision: "allow", answers: { "\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?": "\u0421\u0438\u043d\u0438\u0439" } });
    const toolInput = { questions: QUESTIONS, metadata: { source: "x" } };
    const r = await runQuestion(port, { ...INPUT, tool_input: toolInput });
    expect(bodies).toEqual([{ messagingSocket: "pipe-Q", session_id: "s", tool_input: toolInput }]);
    expect(JSON.parse(r.stdout).hookSpecificOutput.updatedInput).toEqual({ ...toolInput, answers: { "\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?": "\u0421\u0438\u043d\u0438\u0439" } });
  });

  test("a large answer reaches stdout whole before the hook exits", async () => {
    const big = "\u0436".repeat(2_000_000);
    const { port } = await fakeHub({ decision: "allow", answers: { "\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?": big } });
    const proc = Bun.spawn([process.execPath, QUESTION_HOOK], {
      stdin: new Blob([JSON.stringify(INPUT)]),
      stdout: "pipe",
      env: { ...process.env, TELEGRAM_HUB_PORT: String(port), CLAUDE_CODE_MESSAGING_SOCKET: "pipe-Q" },
      windowsHide: true,
    });
    // A slow reader: the pipe fills up before anything is read.
    await Bun.sleep(SLOW_READER_MS);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(JSON.parse(stdout).hookSpecificOutput.updatedInput.answers["\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?"]).toBe(big);
  });

  test("a cancel in the topic denies the tool with the hub's reason", async () => {
    const { port } = await fakeHub({ decision: "deny", reason: "cancelled" });
    const r = await runQuestion(port, INPUT);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "cancelled" } });
  });

  test("none, a broken answer or no hub leave the dialog to the terminal", async () => {
    for (const decision of [{ decision: "none" }, { decision: "allow" }]) {
      const { port } = await fakeHub(decision);
      const r = await runQuestion(port, INPUT);
      expect(r).toEqual({ status: 0, stdout: "" });
      server?.stop(true);
    }
    expect(await runQuestion(await freePort(), INPUT)).toEqual({ status: 0, stdout: "" });
  });

  test("the real hub decides nothing for a session with the mode off", async () => {
    const dir = tempDir();
    hub = new Hub({ port: 0, sessionsFile: join(dir, "s.json"), outboxFile: join(dir, "o.json"), filesDir: join(dir, "files"), inboxDir: dir, api: undefined, config: () => ({ allowFrom: [], turnEndChime: "" }), idleMs: 60_000, log: memLogger(), onExit() {} });
    hub.start();
    const port = hub.port;
    clients.push(await wsClient(port, { type: "hello", v: PROTOCOL_VERSION, windowKey: "pipe-Q", sessionId: "s", cwd: "C:\\p" }));
    expect(await runQuestion(port, INPUT)).toEqual({ status: 0, stdout: "" });
  });

  test("survives garbage input", async () => {
    const port = await freePort();
    const r = spawnSync(process.execPath, [QUESTION_HOOK], { input: "not json", env: { ...process.env, TELEGRAM_HUB_PORT: String(port) }, encoding: "utf8", windowsHide: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  // Once the hub has accepted the poll the owner may be away, so a silent terminal dialog would block the
  // session: every technical end of the wait is a deny that tells the agent to ask again.
  describe("after the hub accepted the poll", () => {
    test("an answer still arrives after the first chunk", async () => {
      const { port } = await acceptingHub("allow");
      const r = await runQuestion(port, INPUT);
      expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "allow", updatedInput: { answers: { q: "a" } } });
    });

    test("a connection lost while waiting denies with the ask-again reason", async () => {
      const { port } = await acceptingHub("drop");
      const r = await runQuestion(port, INPUT);
      expect(r.status).toBe(0);
      expectAskAgain(denyOf(r.stdout));
    });

    test("an unreadable answer denies with the plain-text reason, which cannot loop", async () => {
      const { port } = await acceptingHub("garbage");
      const r = await runQuestion(port, INPUT);
      expect(r.status).toBe(0);
      expectUnreachable(denyOf(r.stdout));
    });

    test("the hook's own time limit denies with the ask-again reason and ends the poll in the hub", async () => {
      const { port, seen } = await acceptingHub("hold");
      const r = await runQuestion(port, INPUT, { TELEGRAM_HUB_QUESTION_DEADLINE_MS: String(TEST_DEADLINE_MS) });
      expect(r.status).toBe(0);
      expectAskAgain(denyOf(r.stdout));
      await waitFor(() => seen.aborted === 1);
    });

    test("an explicit none leaves the dialog to the terminal only while the persisted mode is not on", async () => {
      const { port } = await acceptingHub("none");
      expect(await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(false) })).toEqual({ status: 0, stdout: "" });
      expect(await runQuestion(port, INPUT)).toEqual({ status: 0, stdout: "" });
      expectUnreachable(denyOf((await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(true) })).stdout));
    });

    test("the parent gone is silent, the poll still ends in the hub", async () => {
      const { port, seen } = await acceptingHub("hold");
      const out = join(tempDir(), "hook-stdout.txt");
      const parent = Bun.spawn([process.execPath, "-e", PARENT_SCRIPT_TO_FILE], {
        stdin: new Blob([JSON.stringify(INPUT)]),
        stdout: "pipe",
        env: { ...process.env, TELEGRAM_HUB_STATE_DIR: tempDir(), TELEGRAM_HUB_PORT: String(port), HOOK_PATH: QUESTION_HOOK, OUT_PATH: out },
        windowsHide: true,
      });
      const reader = parent.stdout.getReader();
      const hookPid = Number(new TextDecoder().decode((await reader.read()).value).trim());
      try {
        await waitFor(() => seen.got === 1);
        parent.kill();
        await parent.exited;
        await waitFor(() => seen.aborted === 1, PARENT_GONE_WAIT_MS);
        await waitFor(() => !isAlive(hookPid), PARENT_GONE_WAIT_MS);
        expect(readFileSync(out, "utf8")).toBe("");
      } finally {
        if (isAlive(hookPid)) process.kill(hookPid);
      }
    }, PARENT_GONE_TEST_MS);
  });

  // A hub that streams sends each accepted answer as a line at once, so a hub killed later (it is usually killed,
  // not stopped) has already told the hook what the owner answered. The hook puts those answers into the deny
  // of any technical end, and asks the agent only for the questions that are still open.
  describe("with the answer stream", () => {
    const Q1 = QUESTIONS[0].question;
    // A Russian word built from code points: only the Russian catalog may hold Cyrillic literals.
    const A1 = String.fromCodePoint(0x421, 0x438, 0x43d, 0x438, 0x439);
    const Q2 = "Which size?";
    const TWO = { ...INPUT, tool_input: { questions: [QUESTIONS[0], { question: Q2, header: "Size", options: [{ label: "S", description: "" }, { label: "L", description: "" }], multiSelect: false }] } };
    const bytes = (s: string) => new TextEncoder().encode(s);
    const frame = (question: string, answer: string) => `${JSON.stringify({ answered: { question, answer } })}\n`;
    // The line cut inside its first Cyrillic letter: the lead byte of a two-byte character in one piece, the rest in the next.
    const splitInsideLetter = (line: string) => {
      const b = bytes(line);
      const k = b.findIndex(x => x >= 0x80) + 1;
      return [b.slice(0, k), b.slice(k)];
    };
    const listed = (q: string, a: string) => `- ${JSON.stringify(q)}: ${JSON.stringify(a)}`;
    const expectCarries = (reason: string, q: string, a: string) => {
      expect(reason).toContain(listed(q, a));
      expect(reason).not.toContain("Nothing was answered");
      expect(reason).toContain("nothing was asked in the terminal");
    };

    // A raw HTTP hub that took the poll: the headers, a first chunk " " and then the given pieces, each its own
    // HTTP chunk. "cut" ends the socket without the closing chunk (a killed hub), "close" ends the body properly,
    // "hold" leaves it open. seen.request is the request head the hook sent.
    async function rawHub(pieces: Uint8Array[], end: "cut" | "close" | "hold") {
      const port = await freePort();
      const seen = { got: 0, request: "" };
      const parts: Uint8Array[] = [bytes(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-question-accepted: 1\r\ntransfer-encoding: chunked\r\n\r\n`)];
      for (const p of [bytes(" "), ...pieces]) parts.push(bytes(`${p.length.toString(16)}\r\n`), p, bytes("\r\n"));
      if (end === "close") parts.push(bytes("0\r\n\r\n"));
      const out = Buffer.concat(parts);
      let off = 0;
      let ended = false;
      const pump = (socket: { write(d: Uint8Array): number; end(): void }) => {
        while (off < out.length) {
          const n = socket.write(out.subarray(off));
          if (n <= 0) return;
          off += n;
        }
        if (end !== "hold" && !ended) {
          ended = true;
          socket.end();
        }
      };
      server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data(socket, data) {
            if (seen.got++) return;
            seen.request = Buffer.from(data).toString("latin1");
            pump(socket);
          },
          drain: pump,
          open() {},
          close() {},
          error() {},
        },
      });
      return { port, seen };
    }

    test("a cut after one of two answers carries the answer and asks only for the rest", async () => {
      const { port, seen } = await rawHub(splitInsideLetter(frame(Q1, A1)), "cut");
      const r = await runQuestion(port, TWO);
      expect(r.status).toBe(0);
      expect(seen.request).toMatch(/x-question-stream: 1/i);
      const reason = denyOf(r.stdout);
      expectCarries(reason, Q1, A1);
      expect(reason).toContain("only the unanswered ones");
      expect(reason).toContain("single AskUserQuestion call");
    });

    test("the time limit after an answer carries it", async () => {
      const { port } = await rawHub([bytes(frame(Q1, A1))], "hold");
      const r = await runQuestion(port, TWO, { TELEGRAM_HUB_QUESTION_DEADLINE_MS: String(TEST_DEADLINE_MS) });
      const reason = denyOf(r.stdout);
      expectCarries(reason, Q1, A1);
      expect(reason).toContain("time limit");
      expect(reason).toContain("single AskUserQuestion call");
    });

    test("an unreadable end after an answer carries it and asks the rest as plain text", async () => {
      const { port } = await rawHub([bytes(frame(Q1, A1)), bytes("not json\n")], "close");
      const reason = denyOf((await runQuestion(port, TWO)).stdout);
      expectCarries(reason, Q1, A1);
      expect(reason).toContain("plain text");
      expect(reason).toContain("Do not call AskUserQuestion again");
    });

    test("an explicit none after an answer, with the mode on, carries it", async () => {
      const { port } = await rawHub([bytes(frame(Q1, A1)), bytes(`${JSON.stringify({ decision: "none" })}\n`)], "close");
      const reason = denyOf((await runQuestion(port, TWO, { TELEGRAM_HUB_STATE_DIR: stateWithMode(true) })).stdout);
      expectCarries(reason, Q1, A1);
      expect(reason).toContain("plain text");
    });

    test("a very long typed answer is never cut and the output stays valid JSON", async () => {
      const long = String.fromCodePoint(0x436).repeat(2_000_000);
      // The body stays open until the hook's own limit, so the whole line is read before the end (a cut can drop
      // what the client has not read yet, which says nothing about the answer's size).
      const { port } = await rawHub([bytes(frame(Q1, long))], "hold");
      const r = await runQuestion(port, TWO, { TELEGRAM_HUB_QUESTION_DEADLINE_MS: String(TEST_DEADLINE_MS) });
      const reason = denyOf(r.stdout);
      // toBe, not toContain: a failing toContain would print the 4 MB text.
      expect(reason.includes(listed(Q1, long))).toBe(true);
    });

    test("every question answered before the cut is an allow with the answers", async () => {
      const { port } = await rawHub([bytes(frame(Q1, A1)), bytes(frame(Q2, "L"))], "cut");
      const r = await runQuestion(port, TWO);
      expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "allow", updatedInput: { answers: { [Q1]: A1, [Q2]: "L" } } });
    });

    test("an answer to a question the call did not ask does not make an allow", async () => {
      const { port } = await rawHub([bytes(frame("Other?", "x"))], "cut");
      const reason = denyOf((await runQuestion(port, INPUT)).stdout);
      expect(reason).toContain(listed("Other?", "x"));
    });

    test("the decision line ends with a newline and wins over the frames", async () => {
      const decision = { decision: "allow", answers: { [Q1]: "Final" } };
      const { port } = await rawHub([bytes(frame(Q1, A1)), bytes(`${JSON.stringify(decision)}\n`)], "close");
      expect(JSON.parse((await runQuestion(port, INPUT)).stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "allow", updatedInput: { answers: { [Q1]: "Final" } } });
    });

    test("a deny the hub sent is printed as it is, whatever frames came before", async () => {
      const { port } = await rawHub([bytes(frame(Q1, A1)), bytes(`${JSON.stringify({ decision: "deny", reason: "Hub reason." })}\n`)], "close");
      expect(denyOf((await runQuestion(port, TWO)).stdout)).toBe("Hub reason.");
    });

    test("a cut with no frame keeps the texts exactly as they were", async () => {
      const { port } = await rawHub([], "cut");
      const reason = denyOf((await runQuestion(port, TWO)).stdout);
      expectAskAgain(reason);
      expect(reason).not.toContain("Already answered");
    });
  });

  // An old hub sends no acceptance header. While the session's Telegram mode is on, the owner may be away, so a
  // lost answer is a deny that tells the agent to ask again; with the mode off or unknown the hook stays silent.
  describe("with a hub that does not announce acceptance", () => {
    // An older hub also answers none for technical reasons while the mode is on (a second call ended the first
    // poll, the window went away, the hub was stopping), so none alone never opens the dialog.
    test("an explicit none denies with the plain-text reason when the mode is on, and stays silent otherwise", async () => {
      const { port } = await fakeHub({ decision: "none" });
      expectUnreachable(denyOf((await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(true) })).stdout));
      expect(await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(false) })).toEqual({ status: 0, stdout: "" });
      expect(await runQuestion(port, INPUT)).toEqual({ status: 0, stdout: "" });
    });

    test("an explicit none with the session missing from the file or the file unreadable stays silent", async () => {
      const { port } = await fakeHub({ decision: "none" });
      const unknown = tempDir();
      writeFileSync(join(unknown, "sessions.json"), JSON.stringify({ other: { title: "t", project: "p", enabled: true } }));
      const broken = tempDir();
      writeFileSync(join(broken, "sessions.json"), "{ not json");
      for (const dir of [unknown, broken]) expect(await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: dir })).toEqual({ status: 0, stdout: "" });
    });

    test("a broken answer denies with the plain-text reason when the mode is on, and stays silent otherwise", async () => {
      const { port } = await fakeHub({ decision: "allow" });
      expectUnreachable(denyOf((await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(true) })).stdout));
      expect(await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(false) })).toEqual({ status: 0, stdout: "" });
      expect(await runQuestion(port, INPUT)).toEqual({ status: 0, stdout: "" });
    });

    test("a request held until the hook's limit denies with the ask-again reason when the mode is on, and stays silent otherwise", async () => {
      const { port } = await holdingHub();
      const limit = { TELEGRAM_HUB_QUESTION_DEADLINE_MS: String(TEST_DEADLINE_MS) };
      expectAskAgain(denyOf((await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(true), ...limit })).stdout));
      expect(await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(false), ...limit })).toEqual({ status: 0, stdout: "" });
      expect(await runQuestion(port, INPUT, limit)).toEqual({ status: 0, stdout: "" });
    });

    // Without the acceptance header the hub never took the poll, so asking again would meet the same cut: no loop.
    test("a response cut off before its body ends and before acceptance denies with the plain-text reason when the mode is on", async () => {
      const port = await freePort();
      // Raw HTTP: the headers (no acceptance header) and one chunk go out, then the socket closes mid-body.
      const listener = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data(socket) {
            socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n1\r\n \r\n");
            socket.end();
          },
          open() {},
          close() {},
          error() {},
        },
      });
      try {
        expectUnreachable(denyOf((await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(true) })).stdout));
        expect(await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(false) })).toEqual({ status: 0, stdout: "" });
      } finally {
        listener.stop(true);
      }
    });

    test("the parent gone is silent even with the mode on", async () => {
      const { port, seen } = await holdingHub();
      const out = join(tempDir(), "hook-stdout.txt");
      const parent = Bun.spawn([process.execPath, "-e", PARENT_SCRIPT_TO_FILE], {
        stdin: new Blob([JSON.stringify(INPUT)]),
        stdout: "pipe",
        env: { ...process.env, TELEGRAM_HUB_STATE_DIR: stateWithMode(true), TELEGRAM_HUB_PORT: String(port), HOOK_PATH: QUESTION_HOOK, OUT_PATH: out },
        windowsHide: true,
      });
      const reader = parent.stdout.getReader();
      const hookPid = Number(new TextDecoder().decode((await reader.read()).value).trim());
      try {
        await waitFor(() => seen.got === 1);
        parent.kill();
        await parent.exited;
        await waitFor(() => seen.aborted === 1, PARENT_GONE_WAIT_MS);
        await waitFor(() => !isAlive(hookPid), PARENT_GONE_WAIT_MS);
        expect(readFileSync(out, "utf8")).toBe("");
      } finally {
        if (isAlive(hookPid)) process.kill(hookPid);
      }
    }, PARENT_GONE_TEST_MS);

    test("an answer from an old hub is read as before", async () => {
      const { port } = await fakeHub({ decision: "deny", reason: "cancelled" });
      expect(denyOf((await runQuestion(port, INPUT)).stdout)).toBe("cancelled");
    });
  });

  // The hub cannot be reached at all: whether the owner is waiting in Telegram is in the persisted mode.
  describe("when the hub is unreachable", () => {
    test("with the mode on it denies and tells the agent to write the question as plain text", async () => {
      const r = await runQuestion(await freePort(), INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(true) });
      expect(r.status).toBe(0);
      expectUnreachable(denyOf(r.stdout));
    });

    test("a hub that took the connection and closed it before accepting counts as unreachable", async () => {
      const port = await freePort();
      const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data: s => void s.end(), open() {}, close() {}, error() {} } });
      try {
        const r = await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(true) });
        expectUnreachable(denyOf(r.stdout));
      } finally {
        listener.stop(true);
      }
    });

    test("a hub that answers with an error status denies with the mode on and stays silent with it off", async () => {
      const port = await freePort();
      server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("broken", { status: 500 }) });
      expectUnreachable(denyOf((await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(true) })).stdout));
      expect(await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: stateWithMode(false) })).toEqual({ status: 0, stdout: "" });
    });

    test("with the mode off, a missing file or a session the file does not know it stays silent", async () => {
      const port = await freePort();
      const unknown = tempDir();
      writeFileSync(join(unknown, "sessions.json"), JSON.stringify({ other: { title: "t", project: "p", enabled: true } }));
      for (const dir of [stateWithMode(false), tempDir(), unknown]) {
        expect(await runQuestion(port, INPUT, { TELEGRAM_HUB_STATE_DIR: dir })).toEqual({ status: 0, stdout: "" });
      }
    });

    test("an unreadable sessions file stays silent and is left exactly as it was", async () => {
      const dir = tempDir();
      const file = join(dir, "sessions.json");
      writeFileSync(file, "{ not json");
      expect(await runQuestion(await freePort(), INPUT, { TELEGRAM_HUB_STATE_DIR: dir })).toEqual({ status: 0, stdout: "" });
      expect(readFileSync(file, "utf8")).toBe("{ not json");
      expect(readdirSync(dir)).toEqual(["sessions.json"]);
    });
  });
});

describe("plugin packaging", () => {
  // The parts of the manifests the tests read.
  const marketplace = z.object({ name: z.string(), plugins: z.array(z.object({ name: z.string(), source: z.string() })) });
  const manifest = z.object({ name: z.string(), mcpServers: z.record(z.string(), z.object({ command: z.string() })) });
  const pkgJson = z.object({ scripts: z.record(z.string(), z.string()) });
  const hooksJson = z.object({
    hooks: z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), hooks: z.array(z.looseObject({ command: z.string().optional() })) }))),
  });
  const json = <T>(p: string, schema: z.ZodType<T>) => schema.parse(JSON.parse(readFileSync(p, "utf8")));

  test("marketplace lists the plugin directory", () => {
    const m = json(join(REPO, ".claude-plugin", "marketplace.json"), marketplace);
    expect(m.name).toBe("telegram-hub");
    const entry = must(m.plugins.find(p => p.name === "telegram-hub"), "telegram-hub entry");
    expect(existsSync(join(REPO, entry.source, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  test("plugin manifest, MCP server and hook point at real files", () => {
    const plugin = json(join(PLUGIN, ".claude-plugin", "plugin.json"), manifest);
    expect(plugin.name).toBe("telegram-hub");
    expect(plugin.mcpServers["telegram-hub"].command).toBe("bun");
    // The MCP server lives in the manifest: a .mcp.json in the plugin directory is also a project MCP server for a
    // session working there, which asks for approval at launch and then fails (CLAUDE_PLUGIN_ROOT is unset there).
    expect(existsSync(join(PLUGIN, ".mcp.json"))).toBe(false);
    const pkg = json(join(PLUGIN, "package.json"), pkgJson);
    expect(pkg.scripts.start).toContain("src/plugin/main.ts");
    expect(existsSync(join(PLUGIN, "src", "plugin", "main.ts"))).toBe(true);
    const hooks = json(join(PLUGIN, "hooks", "hooks.json"), hooksJson);
    const cmd = hooks.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain("src/hook/session-start.ts");
    expect(existsSync(HOOK)).toBe(true);
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain("src/hook/stop.ts");
    expect(existsSync(STOP_HOOK)).toBe(true);
    expect(hooks.hooks.StopFailure[0].hooks[0].command).toContain("src/hook/stop-failure.ts");
    expect(existsSync(STOP_FAILURE_HOOK)).toBe(true);
    // The questions hook waits as long as a poll may stay open: 24 hours.
    const question = hooks.hooks.PreToolUse[0];
    expect(question.matcher).toBe("AskUserQuestion");
    expect(question.hooks[0]).toMatchObject({ type: "command", timeout: 86400, statusMessage: "Waiting for an answer in Telegram" });
    expect(question.hooks[0].command).toContain("src/hook/question.ts");
    expect(existsSync(QUESTION_HOOK)).toBe(true);
  });

  // Session actions are rig's job: the plugin ships no hooks module of its own.
  test("no hooks module", () => {
    const raw = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8"));
    expect(raw.modules).toBeUndefined();
    expect(existsSync(join(PLUGIN, "src", "mod"))).toBe(false);
  });

  // The mode turns off only by request, so no hook notes a change of the mode to the agent.
  test("no PostToolBatch or UserPromptSubmit hook", () => {
    const hooks = json(join(PLUGIN, "hooks", "hooks.json"), hooksJson);
    expect(hooks.hooks.PostToolBatch).toBeUndefined();
    expect(hooks.hooks.UserPromptSubmit).toBeUndefined();
  });
});

const ps = spawnSync("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", windowsHide: true });
const hasPowerShell = ps.status === 0;

describe.skipIf(!hasPowerShell)("PowerShell wrappers", () => {
  const script = join(REPO, "scripts", "telegram-hub-profile.ps1");
  function args(fn: string, list: string[]): string {
    const quoted = list.map(a => `'${a.replace(/'/g, "''")}'`).join(",");
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `$global:TelegramHubClaudeExe='x'; $global:TelegramHubCswapExe='y'; . '${script}'; (${fn} @(${quoted})) -join '|'`],
      { encoding: "utf8", windowsHide: true },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  }
  const CH = "--dangerously-load-development-channels|plugin:telegram-hub@telegram-hub";

  test("claude gets the channel flag for interactive sessions", () => {
    expect(args("Get-TelegramHubClaudeArgs", [])).toBe(CH);
    expect(args("Get-TelegramHubClaudeArgs", ["--resume", "abc"])).toBe(`${CH}|--resume|abc`);
  });

  test("claude subcommands and print mode are left alone", () => {
    expect(args("Get-TelegramHubClaudeArgs", ["mcp", "list"])).toBe("mcp|list");
    expect(args("Get-TelegramHubClaudeArgs", ["-p", "hi"])).toBe("-p|hi");
    expect(args("Get-TelegramHubClaudeArgs", ["--version"])).toBe("--version");
  });

  test("cswap run gets the flag after --", () => {
    expect(args("Get-TelegramHubCswapArgs", ["run", "2"])).toBe(`run|2|--|${CH}`);
    expect(args("Get-TelegramHubCswapArgs", ["run", "2", "--", "--resume"])).toBe(`run|2|--|${CH}|--resume`);
  });

  test("other cswap commands pass through", () => {
    expect(args("Get-TelegramHubCswapArgs", ["list"])).toBe("list");
    expect(args("Get-TelegramHubCswapArgs", ["run", "2", "--", "-p", "x"])).toBe("run|2|--|-p|x");
  });
});
