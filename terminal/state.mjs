// Telegram's maximum plain-text message is 4096 characters. Text is pasted,
// never submitted: Enter is a separate, revision-bound action.
export const MAX_TEXT = 4096;
export const KEYS = Object.freeze({ up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r', escape: '\x1b', tab: '\t', backspace: '\x7f', interrupt: '\x03' });

export class TerminalState {
  constructor(generation, read, write, bracketedPaste = () => true) {
    this.generation = generation;
    this.read = read;
    this.write = write;
    this.bracketedPaste = bracketedPaste;
    this.revision = 0;
    this.screen = '';
  }
  snapshot() {
    const screen = this.read();
    if (screen !== this.screen) { this.screen = screen; this.revision++; }
    return { generation: this.generation, revision: this.revision, screen: this.screen };
  }
  input(input) {
    const current = this.snapshot();
    if (!input || input.generation !== current.generation || input.revision !== current.revision) return { ok: false, error: 'stale-screen' };
    let data;
    if (typeof input.key === 'string' && Object.hasOwn(KEYS, input.key) && input.text === undefined) data = KEYS[input.key];
    else if (input.key === undefined && typeof input.text === 'string' && input.text.length > 0 && input.text.length <= MAX_TEXT && !/[\x00-\x1f\x7f]/.test(input.text)) data = this.bracketedPaste() ? `\x1b[200~${input.text}\x1b[201~` : input.text;
    else return { ok: false, error: 'invalid-input' };
    // Consume the revision before the PTY can report new output.
    this.revision++;
    this.write(data);
    return { ok: true };
  }
}

const normalized = text => text.replace(/[│┃]/g, ' ').replace(/\s+/g, ' ').trim();
export function resolvedQuestion(screen, entries) {
  if (!screen.includes('Enter to select') || !screen.includes('Esc to cancel')) return false;
  // Only the modal below its separator counts; older answers in the terminal
  // history must not cancel a genuinely unanswered question.
  const lines = screen.split('\n');
  const footer = lines.findIndex(line => line.includes('Enter to select'));
  const header = lines.findIndex((line, index) => index < footer && line.includes('Submit') && /←|→|\[ \]/.test(line));
  let start = header >= 0 ? header + 1 : footer;
  if (header < 0) while (start > 0 && !/─{8}/.test(lines[start - 1])) start--;
  if (start === 0) return false;
  const modal = normalized(lines.slice(start, footer).join('\n'));
  const questions = new Map();
  const finished = new Set();
  for (const entry of entries) for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
    if (block.type === 'tool_use' && block.name === 'AskUserQuestion') questions.set(block.id, block.input?.questions ?? []);
    if (block.type === 'tool_result') finished.add(block.tool_use_id);
  }
  for (const [id, items] of questions) for (const item of items) {
    const question = normalized(item.question ?? '');
    if (question && modal.includes(question) && !finished.has(id)) return false;
  }
  return [...questions].some(([id, items]) => finished.has(id) && items.some(item => {
    const question = normalized(item.question ?? '');
    return question.length > 0 && modal.includes(question);
  }));
}
