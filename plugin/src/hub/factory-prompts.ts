// The one place that lists which prompts the factory link serves and which it does not (api.md, foreign prompts).
// Test `client-foreign-prompt` holds this list: adding a kind here without a decision there fails it.
//
// served   : the hub shows the prompt in Telegram with controls and the factory sees it as a poll or as buttons.
// factory  : what the factory side gets about it.
//   "poll"    a /hub/polls item (a session poll the hub arbitrates; the answer travels back through poll-answers)
//   "buttons" the client's own buttons through /buttons/*; the hub only carries the press
//   "state"   only the conversation state `permission_wait`: no text, no tool name, no arguments
//   "message" an ordinary /hub/messages item shown without controls
export type PromptKind = "session-poll" | "factory-decision" | "factory-confirmation" | "tool-permission" | "lookalike-text";

export type PromptHandling = { served: boolean; factory: "poll" | "buttons" | "state" | "message" };

export const PROMPT_HANDLING: Record<PromptKind, PromptHandling> = {
  "session-poll": { served: true, factory: "poll" },
  "factory-decision": { served: true, factory: "buttons" },
  "factory-confirmation": { served: true, factory: "buttons" },
  "tool-permission": { served: false, factory: "state" },
  "lookalike-text": { served: false, factory: "message" },
};

// The conversation states of api.md the hub reports; `permission_wait` is the only one that carries a foreign prompt.
export const FACTORY_STATES = ["active", "waiting", "permission_wait", "ended"] as const;
export type FactoryState = (typeof FACTORY_STATES)[number];
