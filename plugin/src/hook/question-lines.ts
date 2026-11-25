// Reads the response of /question as lines, whatever way the network cuts it into chunks: a chunk may end inside a
// line or inside a UTF-8 character, so bytes are decoded as a stream and a line is given out only once its newline
// has come. What is left after the last newline when the body ends (the whole JSON of a hub that sends no newline)
// is given out as the last line. A read that fails throws; the lines given out before it stand.
export async function readLines(body: ReadableStream<Uint8Array> | null, onLine: (line: string) => void): Promise<void> {
  const reader = body?.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const feed = (text: string) => {
    pending += text;
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      onLine(line);
    }
  };
  for (;;) {
    const chunk = await reader?.read();
    if (!chunk || chunk.done) break;
    // stream: a character cut between two chunks is completed by the next one.
    feed(decoder.decode(chunk.value, { stream: true }));
  }
  feed(decoder.decode());
  const last = pending;
  pending = "";
  onLine(last);
}
