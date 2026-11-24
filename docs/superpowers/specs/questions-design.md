# telegram-hub: agent polls in Telegram

Basis: `telegram-hub-design.md` (data flows, permission requests) and
`hub-iteration-2-design.md` (buttons, `callback_query`).

Hub texts quoted below are English by default and Russian when rig's language is ru, see `language-design.md`.

## Why

When an agent calls the built-in `AskUserQuestion` tool, the dialog with options appears only in the
terminal. The user in Telegram does not see it and cannot answer: the session just stands still. The workaround
(a message with "!") interrupts the turn and loses the question itself.

The poll arrives in the topic as a message with buttons: the answer options, "✏️ Own option", "✖️ Cancel".

## How Claude Code lets you answer

Documented (code.claude.com/docs/en/hooks.md, "Tools that require user interaction"): a
`PreToolUse` hook on `AskUserQuestion` can collect the answers itself and return
`permissionDecision: "allow"` together with `updatedInput`. `updatedInput` replaces the tool input
as a whole, so it carries the whole original `tool_input` (the `questions` array and any other fields) and an
added `answers` object: question text → label of the chosen option; with multiple choice the
labels are separated by commas. Then the dialog is not shown in the terminal, and the agent gets the answers as the result of the
tool. `"allow"` without `updatedInput` does not work for this tool.

Claude Code cannot keep a poll alive in the terminal and in Telegram at the same time (relaying channel
permissions does not apply to `AskUserQuestion`). So the poll lives in one place.

If the hook did not finish within its `timeout`, Claude Code discards its output and goes on the usual way,
that is, shows the dialog in the terminal. All the "fallback" cases below rely on this.

## Behavior

**Principle.** While Telegram mode is on, a question never ends silently in a terminal dialog the owner cannot see,
and an answer belongs to exactly one `AskUserQuestion` call. So a poll ends with "no decision" (the dialog opens in the
terminal) only when the owner chose the terminal or the dialog is going away anyway; every other end, on the hub side
and on the hook side, is a refusal (`deny`) with a reason that tells the agent what to do. The table under "End of the
wait without an answer" lists every path.

**Where the poll is.** Telegram mode is on: the poll is only in the topic; in the terminal, while waiting, the hook's
status line "Waiting for an answer in Telegram" (`statusMessage`). Mode is off: the hook decides nothing, the dialog is in the
terminal, as before. If the mode is switched off while a poll is open (`tg_disable`), the owner chose the terminal: the
polls of the session end with no decision, the dialog opens in the terminal, and the message in the topic
is marked "⌛ The poll was moved to the terminal (/terminal shows it here)".

**Time limit.** The poll waits for an answer for 24 hours (hook `timeout` 86400 s). When it expires, the hook ends by
itself with a refusal (the agent is told to ask again if the answer is still needed), and the message in the topic is
marked "⌛ The poll ended on the terminal side (Esc, the time limit or a restart). If the agent still waits for an
answer, it may be a dialog in the terminal: /terminal shows it here, or answer it there", and the buttons are removed.
The hub cannot tell the time limit from Esc or a restart (it only sees the request abort), so the one line names all
three and says what to do. A graceful stop of the hub (`Hub.stop`) denies the polls, see the table. Pressing a button
of an ended poll answers "The poll is outdated" and removes the buttons, as with permissions.

**Several questions.** One call can have up to 4 questions. They arrive one by one: the next one comes
after the previous one is answered. The agent gets all the answers at once, when all are answered.

**Message.** With sound. Text: the question header (`header`), the question itself, below it the numbered
options with descriptions. If an option has a `preview` (a code sample, a mockup), it goes under the option
as a code block, cut to 700 characters. The message is always one, within the Telegram limit (4096
characters) with room for the result line: if the text is longer than 3700 characters, previews are dropped, and if it is still
longer without them, the text is cut with "…". The edited message with the result line also stays
within 4096. With several questions the header has a number: "Question 2 of 3". Buttons: one per option,
"number. label", each in its own row; then a row "✏️ Own option" and "✖️ Cancel".

**Single choice.** Pressing an option is the answer.

**Multiple choice** (`multiSelect`). Pressing toggles the option; a selected one is shown with "☑️"
at the start of the label. A button "✅ Done" is added; with no options selected it answers with the hint
"Pick at least one option" and sends nothing.

**Custom answer.** The button "✏️ Own option" answers in the topic "Write the answer in the next message".
The user's next message in the topic becomes the answer to the current question. A message
sent without pressing the button while the poll is open counts the same way: the agent will not read it anyway while it
waits for the answer. This is any message, with media too: `answers` gets the text or caption and the same
file marks as in incoming batches ("(photo: path)", "(kind: name, file_id: X)"). Only a message sent after the question message
counts as an answer (its `message_id` is greater);
a message older than the question or sent while the question is not yet shown goes to the agent as an ordinary
incoming message. Several messages sent together (an album, a couple of lines in a row) are one answer: the hub
collects them with the same quiet window as incoming batches. The answer message gets the same ✍
"not yet read" reaction as an ordinary incoming message; when the agent gets the answers, the hub removes it. If the poll
ended without answers to the agent (cancel, move to the terminal), the ✍ stays: the agent did not read that message.
Commands (`/info`, `/compact`, `/pwsh` and so on) do not count as an answer, work as usual and do not
close the poll; `/stop` ends the session, and its poll becomes outdated.

**Cancel.** "✖️ Cancel" closes the poll: the hook answers `permissionDecision: "deny"` with the reason
"The user cancelled the question in Telegram. Do not ask it again; end your turn and wait for their
message." The agent ends the turn. Polls of the same session that wait behind it are closed the same way: the owner
cancelled the questions of that step, not one call.

**A message with "!" while a poll is open.** It closes the polls of the session the same way as cancel, and the message itself
goes to the agent as an ordinary incoming message: without "!" and without an interrupt (the agent is waiting for the answer, there is nothing to interrupt, and
an interrupt would break the turn that starts with the denial). A lone "!" only closes the poll and sends the agent
nothing.

**After the answer.** The question message is edited: the buttons are removed, at the bottom "✅ <answer>" (with
multiple choice, the labels separated by commas; for a custom answer, its text, cut like a quote in the
reply context), "✖️ Poll cancelled" or "⌛ The poll was moved to the terminal".

**Polls of one session are served one after another.** An agent may call `AskUserQuestion` several times in one
step (parallel tool calls), and each call has its own hook and its own request. The hub keeps the polls of a session
in arrival order: only the first is shown; the others wait unseen (no message, no catch-up) until the one before them
ends, then the next is shown the same way. A newer poll never ends an older one, and every answer goes to the hook of
the poll it was given for. The MCP server instructions also ask the agent to make one `AskUserQuestion` call per step
and put every question of the step into that call (it takes up to 4); this only lowers the chance of a queue, the
queue is the guarantee. When the hook of a waiting poll ends, only that poll leaves the queue. A press on a button of a
poll that is not shown yet counts as outdated.

## How it works

**Hook.** A `command` hook `PreToolUse` with `matcher: "AskUserQuestion"` (`src/hook/question.ts`, `timeout`
86400, `statusMessage`). The hook reads `session_id` and `tool_input` from stdin (documented), sends
`POST /question` to the hub with `{messagingSocket, session_id, tool_input}` and waits for the answer (`fetch` with
`timeout: false`, otherwise Bun drops an idle request after 5 minutes). The wait ends by itself in two
cases, even if Claude Code never killed the hook: at the hook's own limit, one minute less than `timeout`
(`src/hook/question-limits.ts`), and when the parent process is gone (checked every 2 s with the signal
`kill(pid, 0)`, without starting processes). Then the hook aborts the request. The hub answers
`{decision: "allow", answers}`, `{decision: "deny", reason}` or `{decision: "none"}`. The hook prints the
decision for allow and deny (it waits for the stdout write to finish before exiting, so a long answer is not
cut); on none it stays silent and the dialog opens in the terminal. An `mcp_tool` hook was not chosen: the wait
would run into MCP request timeouts, while a `command` hook has a single limit, its `timeout`.

**Acceptance signal.** Once the hub has accepted a poll (mode on, session known, not starting) it answers at once
with the response header `x-question-accepted: 1` (`QUESTION_ACCEPTED_HEADER`, `src/shared/protocol.ts`) and a first
body chunk of one space, which makes Bun send the headers right away; the body is a streamed response, and when the
poll ends the decision JSON follows the space and the stream closes. A JSON parser skips the leading space, so a hook
that does not know the header reads the body unchanged. A hub that refuses or has no session answers a plain JSON
`none` without the header. Aborting the request after the headers still reaches the hub (`req.signal`) and ends the
poll with none and "ended on the terminal side".

**After acceptance the hook never ends silently by accident.** If the hook saw the header, then every technical end
that follows is a refusal with an English reason: the connection dropped, the hub was killed, the body is not a
valid decision, or the hook's own time limit ran out. The reason says: the hub took the question, nothing
was answered, nothing was asked in the terminal, and if the answer is still needed, ask again with a single
`AskUserQuestion` call (`src/hook/question-reasons.ts`). An explicit `none` from the hub stays silent (the dialog
opens in the terminal). When the parent process is gone nothing reads the output, so the hook exits silently.

**Mixed versions.** A new hook with a hub that sends no header (an older hub) never saw an acceptance, so it behaves
as before: every technical end is silent. An old hook with a new hub parses the body as JSON as before.

**Hub unreachable.** If the request fails before any response (connection refused, or the connection closed before
the headers) or the answer has an error status, the hook reads the persisted Telegram mode of the session read-only (`readSessionMode`, the
`sessions.json` of the state directory; it never writes, never renames a corrupt file). Mode on: refusal with the
reason that the hub is unreachable and the agent should write the question as plain text in its reply and end its
turn, with no retry loop (a repeated `AskUserQuestion` would hit the same dead hub). Mode off, session unknown, or
the file unreadable: silent, the dialog opens in the terminal. A deadline or a gone parent before any response is
silent.

**Session.** The hub finds the session by the window with this `messagingSocket`, otherwise by `session_id`. Mode off
or no session: none. The hub removes its idle timeout from the request and keeps it open until the poll
ends.

**Text before the question.** Claude Code writes the agent's step (the text and the `AskUserQuestion` call) to the transcript
only after the PreToolUse hook has finished, that is, after the user's answer. So text
written in the same step as the question reaches the topic only after the poll, and no waiting in the window
can fix that. To make the explanation arrive above the poll, the agent has a separator tool,
`tg_before_question`: no arguments, does nothing and answers "Now call AskUserQuestion.". The agent
writes the explanation, calls `tg_before_question` and only in the next step (not in parallel in the same one)
calls `AskUserQuestion`. Claude Code writes the separator step to the transcript at once, and the relay
sends the text before it, as before any tool call. The MCP server instructions and the description of the tool
itself say so. Before showing the question the hub still sends the session window a `catchUp`: the window
reads the transcript to the end at once, sends the hub the not yet sent text before the call (as before
`tg_send_file`) and answers `caughtUp`. The hub waits for the answer up to 1 s (an old window does not know `catchUp` and
does not answer, then the poll simply goes after the pause) and puts the question in the send queue behind the
messages already there, so the separator text, if the window read it late, still ends up above the
poll. A poll closed during the wait is not shown.

**Answers.** `answers`: question text → option label; with multiple choice the labels in option order
separated by ", "; a custom answer is the message text (or caption) and file marks separated by a space; several messages
of one answer are separated by a blank line, in the order sent.

**End of the wait without an answer.** Every way a poll ends without an answer, and what the hook gets. Rule: with
the mode on, the hub itself never returns "none" when the owner did not choose the terminal and the dialog would
outlive the hub's knowledge of it.

| Path | Decision | Topic message |
|---|---|---|
| Mode off at the request, or turned off while open | none (owner chose the terminal) | moved to the terminal |
| Esc, window closed (request aborted) | none, for that poll only (the hook is gone and prints nothing) | ended on the terminal side, /terminal or answer there if the agent still waits |
| The hook's own time limit after acceptance | deny, ask again (printed by the hook); the request is aborted, so the hub sees the same end as above | same |
| Session being started (`isStarting`) at the request | none, no acceptance header (the session ends and the dialog goes with it) | nothing |
| Session stopped or cleaned up while open (`capturePending`) | none (the session ends and the dialog goes with it) | moved to the terminal |
| Cancel button or "!" | deny, cancelled (all polls of the session) | poll cancelled |
| Hub stops gracefully | deny, ask again (`hubStopping`), all polls | closed, agent asked to ask again |
| The window of the session is gone, or a button is pressed with no connected window | deny, ask again (`windowGone`) | same |
| Telegram did not accept the poll message | deny, ask again (`notShown`); the next poll is shown | same |
| Hub crash or restart without a graceful stop after acceptance | deny, ask again (printed by the hook: connection lost) | nothing (the hub is gone) |
| The body of the answer is unreadable after acceptance | deny, ask again (printed by the hook) | nothing |
| Hub unreachable at the request or answers with an error status, mode on in `sessions.json` | deny, write the question as plain text and end the turn (printed by the hook) | nothing (the hub is gone) |
| Hub unreachable, closed the connection before acceptance or answered with an error status, mode off or unknown | none by silence: the hook prints nothing | nothing |
| The parent process of the hook is gone | none by silence: nothing reads the output | ended on the terminal side |

A denied poll from the hub tells the agent why the question got no answer in Telegram, that nothing was answered and
nothing was asked in the terminal, and to ask again with a single `AskUserQuestion` call. A refusal printed by the
hook says the hub took the question, with the same facts. Pressing a button of a closed
poll answers "The poll is outdated" and removes the buttons.

Known facts about the terminal side, not more: the hub sees an Esc or a killed hook only as an aborted request, so it cannot
tell the time limit, Esc and a restart apart; `sendInterrupt` writes a prompt to the window's messaging socket and is
documented as ending the turn as Esc does, but whether it closes an open `AskUserQuestion` dialog, and whether Esc
kills the hook, has not been verified, because a live probe needs the container with tmux
(`scripts/claude-probe-terminal.ts`).

**Open.** The hub has no signal that proves "a question went to the terminal and the session has not moved while owner
messages wait": no hook-side or window-side report says that a dialog is open. So nothing closes a stale terminal
dialog by itself. A hub that dies after acceptance is not reconnected: the hook denies and the agent asks again, which
reaches the restarted hub if it is back by then.

**Buttons.** Labels are cut to 64 characters; `callback_data` is
`q:<key>:<question number>:<action>`, the key is 8 hex characters, as with permissions. Pressing a button of a
question that is not the current one counts as outdated.

**State.** The hub keeps open polls in memory. A graceful stop denies them (ask again); a crash drops the connection,
and the hook, which saw the acceptance, denies with the same advice, see the table.
