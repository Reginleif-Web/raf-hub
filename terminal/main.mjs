import { startRelay } from './server.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Matches Rig's two-second initial launch failure-detection grace.
const CONNECT_TIMEOUT_MS = 2000;

try {
  const options = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8'));
  if (!/^[\w-]{1,128}$/.test(options.session)) throw new Error('Invalid session');
  // Keep a completed screen available until the next /run, then retire only
  // that exited supervisor. A running session is never replaced here.
  try {
    const record = JSON.parse(await readFile(join(options.home ?? homedir(), '.agent-rig', 'terminals', `${options.session}.json`), 'utf8'));
    if (record.session === options.session && Number.isInteger(record.port) && record.port > 0 && record.port < 65536 && /^[a-f0-9]{64}$/.test(record.token)) {
      const url = `http://127.0.0.1:${record.port}`;
      const headers = { authorization: `Bearer ${record.token}` };
      const screen = await (await fetch(url + '/screen', { headers, signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })).json();
      if (screen.status === 'exited' && screen.generation === record.generation) await fetch(url + '/dispose', { method: 'POST', headers, signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    }
  } catch { /* The exclusive process lock makes the final liveness decision. */ }
  const relay = await startRelay(options);
  const stop = () => { relay.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  console.error(`Terminal supervisor: ${error.message}`);
  process.exit(1);
}
