// What the question hook tells the agent when the wait for the Telegram answer ends for a technical reason
// and the owner may be away from the terminal, so its dialog must not open on its own. The text is for the
// agent, so it is English like askAgainReason in the hub.

export type EndedWhy = "connectionLost" | "timeLimit";

const ENDED_WHY: Record<EndedWhy, string> = {
  connectionLost: "the connection to the Telegram hub was lost while the question waited for an answer",
  timeLimit: "the time limit of the question hook ran out while the question waited for an answer",
};

// The hub had accepted the poll; it may have been shown or still waited behind another one, but an answer
// cannot reach this call any more.
export function endedReason(why: EndedWhy): string {
  return `The Telegram hub took the question, but ${ENDED_WHY[why]}. Nothing was answered and nothing was asked in the terminal. If the answer is still needed, ask it again with a single AskUserQuestion call.`;
}

// The hub did not answer, answered with an error status or something unreadable, or answered "none" while
// the session is in Telegram mode. A retry would hit the same wall, so the agent is told to put the question
// in its text, which reaches the topic once the hub is back.
export const HUB_UNREACHABLE_REASON =
  "The Telegram hub is unreachable or could not take the question, so the question got no answer in Telegram, and nothing was asked in the terminal. Do not call AskUserQuestion again. Write the question as plain text in your reply and end your turn; the owner answers in a normal message.";
