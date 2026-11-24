import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TerminalRelay } from "../src/hub/terminal-relay.ts";

// Whether a terminal supervisor owns a session, as a synchronous local check: its descriptor exists and the pid it
// records is alive.
describe("TerminalRelay.supervised", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "supervised-")); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  // The request fails for every call: the answer must not depend on reaching the supervisor.
  const relay = () => new TerminalRelay({ directory, request: async () => { throw new Error("unreachable"); },
    show: () => {}, connected: () => false, known: () => true, warn: () => {} });
  const descriptor = (session: string, content: string) => writeFileSync(join(directory, `${session}.json`), content);
  // The pid of a process that has finished: no process holds it now.
  const deadPid = (): number => Bun.spawnSync([process.execPath, "--version"]).pid;

  test("no descriptor means no supervisor", () => {
    expect(relay().supervised("s1")).toBe(false);
  });

  test("a descriptor with a live supervisor pid is supervised, whatever the supervisor answers", () => {
    descriptor("s1", JSON.stringify({ pid: process.pid }));
    expect(relay().supervised("s1")).toBe(true);
  });

  test("a descriptor with a dead supervisor pid is not supervised", () => {
    descriptor("s1", JSON.stringify({ pid: deadPid() }));
    expect(relay().supervised("s1")).toBe(false);
  });

  test("a descriptor that cannot be read or understood counts as supervised", () => {
    descriptor("s1", "{ being rewrit");
    descriptor("s2", "");
    descriptor("s3", JSON.stringify({ port: 1 }));
    descriptor("s4", "null");
    for (const session of ["s1", "s2", "s3", "s4"]) expect(relay().supervised(session)).toBe(true);
  });

  test("a name that is no session id is not supervised", () => {
    descriptor("s1", JSON.stringify({ pid: process.pid }));
    for (const session of ["", "../s1", "s1/..", "a".repeat(129)]) expect(relay().supervised(session)).toBe(false);
  });
});
