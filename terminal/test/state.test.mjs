import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalState, resolvedQuestion } from '../state.mjs';

test('input is bound to the displayed screen and consumed once', () => {
  let screen = 'Trust this folder?';
  const writes = [];
  const state = new TerminalState('generation-one', () => screen, data => writes.push(data));
  const first = state.snapshot();
  assert.equal(state.input({ generation: first.generation, revision: first.revision, key: 'down' }).ok, true);
  assert.equal(state.input({ generation: first.generation, revision: first.revision, key: 'enter' }).ok, false);
  assert.deepEqual(writes, ['\x1b[B']);
  const second = state.snapshot();
  screen = 'A different question';
  assert.equal(state.input({ generation: second.generation, revision: second.revision, key: 'enter' }).ok, false);
  const fresh = state.snapshot();
  assert.equal(state.input({ ...fresh, generation: 'old-generation', key: 'enter' }).ok, false);
  assert.equal(writes.length, 1);
});

test('invalid input never becomes shell text or control characters', () => {
  const writes = [];
  const state = new TerminalState('generation', () => 'Prompt', value => writes.push(value));
  const screen = state.snapshot();
  for (const extra of [{ key: 'arbitrary' }, { text: 'x\x1b[201~\r' }, { key: 'enter', text: 'x' }, {}]) {
    assert.equal(state.input({ ...screen, ...extra }).ok, false);
  }
  assert.equal(state.input({ ...screen, text: 'a literal answer' }).ok, true);
  assert.deepEqual(writes, ['\x1b[200~a literal answer\x1b[201~']);
});

test('a terminal without bracketed-paste support receives literal text without control sequences', () => {
  const writes = [];
  const state = new TerminalState('one', () => 'Answer:', text => writes.push(text), () => false);
  assert.equal(state.input({ ...state.snapshot(), text: 'yes' }).ok, true);
  assert.deepEqual(writes, ['yes']);
});

test('only a resolved question actually visible in the modal can be recovered', () => {
  const question = 'Which route should be used?';
  const ask = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'AskUserQuestion', input: { questions: [{ question }] } }] } };
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'Answered' }] } };
  const screen = `History\n────────────────\n${question}\n1. Left\n2. Right\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel`;
  assert.equal(resolvedQuestion(screen, [ask]), false);
  assert.equal(resolvedQuestion(screen, [ask, result]), true);
  assert.equal(resolvedQuestion(screen.replace(question, 'An unanswered question'), [ask, result]), false);
  assert.equal(resolvedQuestion(`Answered history: ${question}\n────────────────\nAn unanswered question\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel`, [ask, result]), false);
  assert.equal(resolvedQuestion(`Old answered history\n────────────────\n← [ ] Route √ Submit →\n${question}\n1. Left\n2. Right\n────────────────\n3. Chat about this\n────────────────\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel`, [ask, result]), true);
});
