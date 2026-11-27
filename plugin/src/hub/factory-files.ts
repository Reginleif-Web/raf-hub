// Durable JSON files of the factory link: read with a schema, written atomically, an unreadable file moved aside.
import type { Timers } from "../shared/timers.ts";
import type { z } from "zod";

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// A missing file is the normal first start; any other failure keeps the bytes under `.corrupt-<time>` and starts empty.
export function loadJson<T>(file: string, schema: z.ZodType<T>, empty: () => T, warn: (text: string) => void, timers: Timers, what: string): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") warn(`${what} unreadable: ${String(error)}`);
    return empty();
  }
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    try { renameSync(file, `${file}.corrupt-${timers.now()}`); warn(`${what} unreadable: ${String(error)}`); } catch {}
    return empty();
  }
}

// Write to a temporary directory next to the file, then rename over it: a crash leaves the old file or the new one, never half.
export function saveJson(file: string, data: unknown): void {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, ".factory-"));
  try {
    const staged = join(temporary, "data.json");
    writeFileSync(staged, JSON.stringify(data));
    renameSync(staged, file);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
