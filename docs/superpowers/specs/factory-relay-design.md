# Link to the Agent Factory (factory relay)

The hub can serve as the Telegram side of the Agent Factory API (spec: `docs/agent-factory/api.md`,
`governance.md`, `security.md` of the factory repository). The link is one object, `FactoryRelay`
(`plugin/src/hub/factory-relay.ts`), built in `main.ts` from `loadFactorySettings()`. With no settings it is not
built, and every hook in `hub.ts` is a no-op: the hub behaves as it did before the link existed (test
"not configured: unchanged").

## Settings

Set by the owner; see the README section "Optional: link to the Agent Factory". Secrets (URL, hub token, relay token,
button keys) come only from the environment or the state-dir `.env`; the non-secret numbers and the gate command
come from the `factory` object of `config.json`. Three parts switch on independently: the API link (URL and hub token),
the gate (a non-empty command) and the buttons (at least one client key).

## What goes to the factory

- Messages, polls and states are mirrored to `/hub/messages`, `/hub/polls`, `/hub/states` as `{session_ref, key, kind,
  content}`. `session_ref` is the hub session id. Keys are stable per item (`msg:<sourceId>`,
  `poll:<pollKey>:<index>`, `state:<n>`), so a repeat is the same item (`hub-key`).
- Every item goes through a durable, ordered queue (`factory-queue.json`, next to the machine outbox). A failure stops
  the flush and retries on the next one; a 4xx other than 408 and 429 drops the item. A down factory never blocks the
  hub, and the queue does not hold back a rig restart.
- A poll answered in Telegram is reported once to `/hub/polls/{id}/result` (`hub-once`). An answer that came from the
  factory is not reported back. Custom text answers are not reported as a poll result.
- Conversation states are `active`, `waiting`, `permission_wait`, `ended`.

## Poll registration and captures (relay role)

With the relay token, a poll is registered with `POST /registry/polls` before it is shown (bounded by the registry
timeout, fail open: a refusal or a timeout shows the poll unregistered). The returned `display_line` is prepended to
the poll text. Each press of a registered poll is captured with `POST /registry/captures`
(`press_id = tg:<callbackId>`, one capture per option of a multi-select with `:<i>` appended, `option_index`
0-based). A repeat answers 409 `press_replayed` and is not an error.

## Answers from the factory

The hub reads `GET /hub/poll-answers?state=pending` every `pollAnswerIntervalMs` and applies an answer as if it was
pressed in Telegram, then reports `POST /hub/poll-answers/{id}/result` with `applied`, or `refused` and a reason.

## The gate

`/question` runs the configured gate first, with or without Telegram mode. The command gets JSON on standard input
and prints a verdict; the inquiry id is `tool_input.metadata.source`. `pass:false` denies the call with the reason and
the records; anything else (bad exit code, bad output, timeout) lets the question pass, and a warning is logged.

## Buttons keyed by client (D5)

A client sends a message with buttons through `POST /buttons/send`, reads its presses with `GET /buttons/presses` and
acknowledges one with `POST /buttons/presses/{seq}/ack`. A client is known by the headers `x-hub-client` and
`x-hub-client-key`; the key opens that client's buttons only. With no keys configured these routes answer the same
404 as before.

- A send is idempotent per `[client, chat, key]`; a different payload under the same key is refused.
- The hub makes one callback token per button. A token is taken once and only while its window is open; the second
  press is `used`, a late one `expired`, a press id the client already registered is `press_replayed`.
- A press by someone the hub's allow-list does not know never reaches the store. A refused press answers the callback
  with a refusal text and removes the keyboard, except `used`, which keeps it.
- The second confirmation for dangerous actions is the client's job, not the hub's.
- The press store is `buttons.json`; a restart does not make a taken button free again.

## Foreign prompts

The table `PROMPT_HANDLING` (`factory-prompts.ts`) lists the prompt kinds and what the factory gets of
each. A tool permission prompt from a third-party tool, or a text that only looks like an approval, never becomes a
poll or a message for the factory or for the chat: the factory sees only the state `permission_wait`, with no text,
tool name or arguments (test `client-foreign-prompt`). Adding a kind without a decision in the table fails that test.

## Decisions the factory spec leaves open

The wire form of `/buttons/*`, the header names, the gate command protocol, the key forms above, the config names and
the defaults (poll-answer interval 5 s, request timeout 10 s, registry and gate timeout 3 s, press window 10 min) are
the hub's own choices. They live in code and in this file; change them here first.

## Tests

`plugin/test/factory-relay.test.ts` runs the real hub against a faked factory API, a faked gate and a faked Telegram,
on the manual clock. Groups: `hub-key`, `hub-once`, `button-replay`, `client-foreign-prompt`, the registry and gate,
and "not configured: unchanged".
