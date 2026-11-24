import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { readSessionMode, SessionStore } from "../src/hub/sessions.ts";
import { tempDir } from "./helpers.ts";

// What a hook that cannot reach the hub may know about a session: the mode the hub persisted, read without
// touching the file.
describe("readSessionMode", () => {
  const record = (enabled: boolean) => ({ title: "t", project: "p", enabled });

  test("tells whether the mode of the session is on or off in the file the store wrote", () => {
    const file = join(tempDir(), "sessions.json");
    const store = new SessionStore(file);
    store.set("on", record(true));
    store.set("off", record(false));
    expect(readSessionMode(file, "on")).toBe(true);
    expect(readSessionMode(file, "off")).toBe(false);
  });

  test("is unknown for a session the file does not have and for a missing file", () => {
    const dir = tempDir();
    const file = join(dir, "sessions.json");
    expect(readSessionMode(file, "x")).toBeUndefined();
    writeFileSync(file, JSON.stringify({ other: record(true) }));
    expect(readSessionMode(file, "x")).toBeUndefined();
  });

  test("is unknown for an unreadable file, and leaves it where and as it was", () => {
    const dir = tempDir();
    const file = join(dir, "sessions.json");
    for (const text of ["{ not json", JSON.stringify({ x: { title: "t" } }), "[]"]) {
      writeFileSync(file, text);
      expect(readSessionMode(file, "x")).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe(text);
      expect(readdirSync(dir)).toEqual(["sessions.json"]);
    }
  });
});
