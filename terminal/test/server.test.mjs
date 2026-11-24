import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRelay } from '../server.mjs';
import { promises as fs } from 'node:fs';

test('the independent relay authenticates requests, rejects replay, and survives a client disconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'raf-terminal-'));
  const writes = [];
  let output;
  const child = { pid: 99, onData(fn) { output = fn; }, onExit() {}, write(text) { writes.push(text); }, kill() {} };
  let relay;
  try {
    relay = await startRelay({ session: 'test-session', cwd: home, command: 'fake', args: [], home, spawn: () => child, terminate: async () => {} });
    await assert.rejects(startRelay({ session: 'test-session', cwd: home, command: 'fake', args: [], home, spawn: () => child, terminate: async () => {} }), /already owns/);
    const url = `http://127.0.0.1:${relay.port}`;
    assert.equal((await fetch(url + '/screen')).status, 401);
    const headers = { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' };
    output('Choose an option\r\n1. Allow\r\n2. Deny');
    const first = await (await fetch(url + '/screen', { headers })).json();
    assert.match(first.screen, /Choose an option/);
    const body = JSON.stringify({ generation: first.generation, revision: first.revision, key: 'down' });
    assert.equal((await fetch(url + '/input', { method: 'POST', headers, body })).status, 200);
    assert.equal((await fetch(url + '/input', { method: 'POST', headers, body })).status, 409);
    assert.deepEqual(writes, ['\x1b[B']);
    const record = JSON.parse(await readFile(join(home, '.agent-rig/terminals/test-session.json'), 'utf8'));
    assert.equal(record.port, relay.port);
    const secondClient = await (await fetch(url + '/screen', { headers })).json();
    assert.equal(secondClient.generation, first.generation);
    assert.equal(secondClient.status, 'running');
    assert.equal((await fetch(url + '/input', { method: 'POST', headers, body: '{}' })).status, 409);
  } finally {
    await relay?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('recovery rechecks output arriving during transcript I/O before sending Escape', async () => {
  const home = await mkdtemp(join(tmpdir(), 'raf-recovery-'));
  const transcript = join(home, 'history.jsonl');
  const question = 'Which branch should be used?';
  await fs.writeFile(transcript, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { questions: [{ question }] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ask', content: 'Answered' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const writes = [];
  let emit;
  const child = { pid: 99, onData(fn) { emit = fn; }, onExit() {}, write(data) { writes.push(data); }, kill() {} };
  const originalOpen = fs.open;
  let relay;
  try {
    relay = await startRelay({ session: 'recovery-test', cwd: home, home, transcript, command: 'fake', args: [], spawn: () => child, terminate: async () => {} });
    const modal = value => `\x1b[2J\x1b[H────────────────\r\n← [ ] Choice √ Submit →\r\n${value}\r\n1. First\r\n2. Second\r\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel`;
    emit(modal(question));
    fs.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (path === transcript) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          emit(modal('A new unanswered prompt'));
          return result;
        };
      }
      return handle;
    };
    const snapshot = await relay.snapshot();
    assert.deepEqual(writes, []);
    assert.equal(snapshot.recoveries, 0);
    assert.match(snapshot.screen, /A new unanswered prompt/);
  } finally {
    fs.open = originalOpen;
    await relay?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('a stale lock whose PID was reused is reclaimed without killing the unrelated process', async () => {
  const home = await mkdtemp(join(tmpdir(), 'raf-lock-'));
  const directory = join(home, '.agent-rig/terminals');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(directory, 'reused-pid.lock'), JSON.stringify({ pid: process.pid, generation: 'old', argv: ['/old/terminal/main.mjs', 'old-launch'] }));
  let relay;
  try {
    relay = await startRelay({ session: 'reused-pid', cwd: home, home, command: 'fake', args: [],
      processCommand: async () => '/a/different/program',
      spawn: () => ({ pid: 99, onData() {}, onExit() {}, write() {}, kill() {} }), terminate: async () => {} });
    assert.notEqual(relay.generation, 'old');
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { await relay?.close(); await rm(home, { recursive: true, force: true }); }
});
