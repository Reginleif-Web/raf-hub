import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ptyCommand } from '../command.mjs';

test('Windows batch shims keep a quoted executable and literal validated arguments', () => {
  assert.deepEqual(ptyCommand('C:\\tools space\\cswap.cmd', ['run', '2', '--share-history'], 'win32', 'cmd.exe'), {
    command: 'cmd.exe', args: '/d /v:off /s /c ""C:\\tools space\\cswap.cmd" "run" "2" "--share-history""',
  });
  assert.throws(() => ptyCommand('C:\\cswap.cmd', ['run', '2 & calc'], 'win32'), /shell syntax/);
  assert.deepEqual(ptyCommand('/bin/claude', ['literal & argument'], 'linux'), { command: '/bin/claude', args: ['literal & argument'] });
});
