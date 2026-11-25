import { describe, expect, test } from "bun:test";

import { readLines } from "../src/hook/question-lines.ts";

const enc = new TextEncoder();

// A body that gives out the given byte pieces one by one; an Error piece makes the read fail.
function body(pieces: (Uint8Array | Error)[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const p = pieces[i++];
      if (p === undefined) c.close();
      else if (p instanceof Error) c.error(p);
      else c.enqueue(p);
    },
  });
}

async function lines(b: ReadableStream<Uint8Array> | null): Promise<string[]> {
  const out: string[] = [];
  await readLines(b, l => out.push(l));
  return out;
}

describe("readLines", () => {
  // Russian words built from code points: only the Russian catalog may hold Cyrillic literals.
  const question = String.fromCodePoint(0x41a, 0x430, 0x43a, 0x43e, 0x439, 0x20, 0x446, 0x432, 0x435, 0x442, 0x3f);
  const answer = String.fromCodePoint(0x421, 0x438, 0x43d, 0x438, 0x439);
  const text = `{"answered":{"question":"${question}","answer":"${answer}"}}\n{"decision":"allow"}\n`;

  test("gives the same lines when the bytes are cut at any place, inside a UTF-8 character included", async () => {
    const all = enc.encode(text);
    const expected = text.split("\n");
    for (let k = 0; k <= all.length; k++) {
      expect(await lines(body([all.slice(0, k), all.slice(k)]))).toEqual(expected);
    }
  });

  test("gives the same lines when every byte comes alone", async () => {
    const all = enc.encode(text);
    expect(await lines(body([...all].map(b => Uint8Array.of(b))))).toEqual(text.split("\n"));
  });

  test("the rest after the last newline is the last line (a hub that sends no newline)", async () => {
    expect(await lines(body([enc.encode(' {"decision":"none"}')]))).toEqual([' {"decision":"none"}']);
  });

  test("a body that is missing gives one empty line", async () => {
    expect(await lines(null)).toEqual([""]);
  });

  test("a read that fails throws, after the complete lines before it were given out", async () => {
    const out: string[] = [];
    await expect(readLines(body([enc.encode("a\nb"), new Error("cut")]), l => out.push(l))).rejects.toThrow("cut");
    expect(out).toEqual(["a"]);
  });
});
