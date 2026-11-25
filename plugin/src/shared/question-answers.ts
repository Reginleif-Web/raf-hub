// The one place that puts the answers a poll already got into the reason of a technical end (the hub stopping,
// the window gone, the question not shown, the connection lost, the hook's time limit). The producer of the
// deny builds the whole text with this and nobody appends to it later: the hub for the ends it sees, the hook
// for the ends only it sees, so an old hook or an old hub never adds the answers twice. The text is for the
// agent, so it is English.
//
// The answers are never cut: a typed answer is the owner's own words. Each is a JSON string, so a newline or a
// quote in it cannot be taken for the text around it, and the hook's output stays valid JSON for Claude Code.

// What a reason says without answers (exactly as it always did), and with them: the sentence that opens it,
// and the instruction that tells the agent to ask or write only the questions that are still open.
export type ReasonTexts = { without: string; withAnswers: string; askRest: string };

export function reasonWithAnswers(texts: ReasonTexts, answers: Record<string, string> | undefined): string {
  const entries = Object.entries(answers ?? {});
  if (!entries.length) return texts.without;
  const lines = entries.map(([question, answer]) => `- ${JSON.stringify(question)}: ${JSON.stringify(answer)}`);
  return `${texts.withAnswers} Already answered in Telegram, question and answer:\n${lines.join("\n")}\n${texts.askRest}`;
}
