// Preloaded into the question hook by packaging.test.ts: the response body breaks, like the connection of a killed
// hub, once the hook has read TEST_CUT_AFTER bytes of it and asks for more. A real socket cut right after the data
// can drop what the client has not read yet, so it says nothing certain about what the hook does with what it read.
const cutAfter = Number(process.env.TEST_CUT_AFTER);
const realFetch = globalThis.fetch;

globalThis.fetch = Object.assign(
  async (...args: Parameters<typeof realFetch>) => {
    const res = await realFetch(...args);
    const reader = res.body?.getReader();
    let read = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        // Asked for only when the hook takes the next chunk (no chunk is kept ahead), so the one before was read.
        pull: async controller => {
          if (read >= cutAfter) return controller.error(new Error("the connection was cut"));
          const chunk = await reader?.read();
          if (!chunk || chunk.done) return controller.close();
          read += chunk.value.length;
          controller.enqueue(chunk.value);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: res.status, headers: res.headers });
  },
  { preconnect: realFetch.preconnect },
);
