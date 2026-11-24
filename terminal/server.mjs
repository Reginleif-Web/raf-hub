import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { createServer as createOwnershipServer } from 'node:net';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { TerminalState, MAX_TEXT, resolvedQuestion } from './state.mjs';
import { ptyCommand } from './command.mjs';

const { Terminal } = headless;
// A viewport fits Claude's menus and remains readable as a Telegram document.
export const COLS = 100;
export const ROWS = 35;
// JSON can escape every input character as six bytes, plus the envelope.
const MAX_REQUEST_BYTES = MAX_TEXT * 6 + 1024;
// Same reverse-reading block as Rig's session transcript mode reader.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
// Same process-start observation window as Rig's detached-launch grace.
const PROCESS_QUERY_MS = 2000;

async function processCommand(pid) {
  if (process.platform === 'linux') return (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
  const command = process.platform === 'win32' ? 'powershell.exe' : 'ps';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]
    : ['-p', String(pid), '-o', 'command='];
  return new Promise((resolve, reject) => execFile(command, args, { windowsHide: true, timeout: PROCESS_QUERY_MS }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

export async function startRelay(options) {
  const { session, cwd, command, args, transcript } = options;
  if (!/^[\w-]{1,128}$/.test(session) || typeof command !== 'string' || !Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('Invalid terminal launch');
  const directory = join(options.home ?? homedir(), '.agent-rig', 'terminals');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${session}.json`);
  const lockFile = join(directory, `${session}.lock`);
  const generation = randomUUID();
  // A kernel-owned named pipe disappears on process death. It serializes
  // Windows stale-file recovery as well as normal concurrent launches.
  let ownership;
  const closeOwnership = async () => {
    const owner = ownership;
    ownership = undefined;
    if (owner) await new Promise(resolve => owner.close(resolve));
  };
  if (process.platform === 'win32') {
    ownership = createOwnershipServer(socket => socket.destroy());
    const identity = createHash('sha256').update(`${directory.toLowerCase()}\0${session}`).digest('hex');
    try {
      await new Promise((resolve, reject) => {
        ownership.once('error', reject);
        ownership.listen(`\\\\.\\pipe\\raf-terminal-${identity}`, resolve);
      });
    } catch { throw new Error('A terminal supervisor already owns this session'); }
  }
  let lock;
  try {
   try { lock = await fs.open(lockFile, 'wx', 0o600); }
   catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid terminal owner record');
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; else throw probe; }
    if (alive && Array.isArray(owner.argv) && owner.argv.length >= 2 && owner.argv.every(value => typeof value === 'string')) {
      const actual = await (options.processCommand ?? processCommand)(owner.pid);
      const scriptMatches = actual.replaceAll('\\', '/').toLowerCase().includes(owner.argv[0].replaceAll('\\', '/').toLowerCase());
      alive = scriptMatches && actual.includes(owner.argv[1]);
    }
    if (alive) throw new Error('A terminal supervisor already owns this session');
    await fs.unlink(lockFile);
    lock = await fs.open(lockFile, 'wx', 0o600);
   }
   await lock.writeFile(JSON.stringify({ pid: process.pid, generation, argv: process.argv.slice(1) }));
   await lock.close();
  } catch (error) {
    await lock?.close().catch(() => {});
    await closeOwnership();
    throw error;
  }
  const token = randomBytes(32).toString('hex');
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
  let child;
  let status = 'starting';
  let exitCode = null;
  let closed = false;
  let output = Promise.resolve();
  let recoveredScreen;
  let recoveries = 0;
  const screen = () => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: ROWS }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n').trimEnd();
  };
  const state = new TerminalState(generation, screen, data => child.write(data), () => terminal.modes.bracketedPasteMode);
  const drainOutput = async () => {
    for (;;) {
      const pending = output;
      await pending;
      if (pending === output) return;
    }
  };
  const authorization = `Bearer ${token}`;
  const authorized = header => typeof header === 'string' && Buffer.byteLength(header) === Buffer.byteLength(authorization) && timingSafeEqual(Buffer.from(header), Buffer.from(authorization));
  const answer = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  const removeOwnedRecords = async () => {
    for (const path of [file, lockFile]) {
      try { if (JSON.parse(await fs.readFile(path, 'utf8')).generation === generation) await fs.unlink(path); } catch {}
    }
  };
  async function snapshot() {
    await drainOutput();
    let current = state.snapshot();
    if (status === 'running' && transcript && current.screen.includes('Enter to select') && current.screen !== recoveredScreen) {
      let handle;
      try {
        handle = await fs.open(transcript, 'r');
        const { size } = await handle.stat();
        const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
        const bytes = Buffer.alloc(size - start);
        await handle.read(bytes, 0, bytes.length, start);
        const lines = bytes.toString('utf8').split('\n').slice(start === 0 ? 0 : 1);
        const entries = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        await drainOutput();
        current = state.snapshot();
        if (resolvedQuestion(current.screen, entries)) {
          recoveredScreen = current.screen;
          // No options are chosen. Escape only closes the already-completed modal.
          if (state.input({ ...current, key: 'escape' }).ok) { recoveries++; current = state.snapshot(); }
        }
      } catch (error) { if (error.code !== 'ENOENT') console.error(`Terminal recovery probe: ${error.message}`); }
      finally { await handle?.close(); }
    }
    return { session, ...current, status, exitCode, pid: child?.pid ?? null, recoveries };
  }
  const server = createServer(async (req, res) => {
    try {
      if (!authorized(req.headers.authorization)) return answer(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET' && req.url === '/screen') return answer(res, 200, await snapshot());
      if (req.method === 'POST' && req.url === '/dispose') {
        if (status !== 'exited') return answer(res, 409, { error: 'terminal-still-running' });
        await removeOwnedRecords();
        await closeOwnership();
        answer(res, 200, { ok: true });
        setImmediate(() => { void close(); });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/input') return answer(res, 404, { error: 'not-found' });
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_REQUEST_BYTES) return answer(res, 413, { error: 'input-too-large' });
        chunks.push(chunk);
      }
      await drainOutput();
      if (status !== 'running') return answer(res, 409, { error: 'terminal-exited' });
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return answer(res, 400, { error: 'invalid-json' }); }
      const result = state.input(input);
      answer(res, result.ok ? 200 : 409, result);
    } catch (error) { answer(res, 500, { error: 'terminal-error' }); console.error(error.message); }
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    if (status !== 'exited' && child) {
      if (options.terminate) await options.terminate(child);
      else if (process.platform === 'win32') {
        // node-pty 1.1 can double-close a ConPTY handle if kill races with
        // natural exit. Stop this exact child tree through the OS instead.
        await new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
          if (!error || error.code === 128) resolve();
          else reject(error);
        }));
      } else child.kill();
    }
    await new Promise(resolve => server.close(resolve));
    terminal.dispose();
    await removeOwnedRecords();
    await closeOwnership();
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const env = { ...process.env, ...(options.env ?? {}), TERM: 'xterm-256color' };
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID']) delete env[key];
    // The bundled ConPTY closes its session without the system ConPTY's
    // asynchronous process-list query racing with process termination.
    const executable = ptyCommand(command, args);
    child = (options.spawn ?? pty.spawn)(executable.command, executable.args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env, useConpty: true, useConptyDll: true });
    terminal.onData(data => child.write(data));
    child.onData(data => { output = output.then(() => new Promise(resolve => terminal.write(data, resolve))); });
    child.onExit(event => { status = 'exited'; exitCode = event.exitCode; });
    status = 'running';
    const record = { schemaVersion: 1, session, generation, pid: process.pid, childPid: child.pid, port, token, cwd };
    const staged = `${file}.${generation}.tmp`;
    await fs.writeFile(staged, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(staged, file);
    return { port, token, generation, close, snapshot };
  } catch (error) { await close(); throw error; }
}
