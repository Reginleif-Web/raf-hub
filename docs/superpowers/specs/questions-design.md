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
terminal) only when the owner chose the terminal (the mode is off) or the dialog is going away anyway; every other end,
on the hub side and on the hook side, is a refusal (`deny`) with a reason that tells the agent what to do. An explicit
`none` that reaches the hook while the persisted mode is still on is itself such an end, see below. The table under
"End of the wait without an answer" lists every path.

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
three and says what to do. A graceful stop of the hub (`Hub.stop`) denies the polls, see "Graceful stop" below. Pressing a button
of an ended poll answers "The poll is outdated" and removes the buttons, as with permissions.

**Several questions.** One call can have up to 4 questions. They arrive one by one: the next one comes
after the previous one is answered. The agent gets all the answers at once, when all are answered.

A poll with several questions may end for a technical reason after some of its questions were answered (the hub stops,
the window is gone, the connection is lost, the hook's time limit). Those answers are not lost: the deny names each
answered question with its answer and tells the agent to ask only the unanswered ones, see "Answers carried by a
technical end". The owner's own end drops everything: "✖️ Cancel", a message with "!" and turning the mode off carry no
answers, as before.

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
collects them with the same quiet window and the same longest wait as incoming batches; both stand still while a photo
of the answer downloads. A
message belongs to the question shown when it came; if that question is over once its photo is downloaded, the message
goes to the agent. The answer message gets the same ✍
"not yet read" reaction as an ordinary incoming message; when the agent gets the answers, the hub removes it. If the poll
ended without answers to the agent (cancel, move to the terminal), the ✍ stays: the agent did not read that message.
A technical end that carries the answer in its deny (the hub's own ends) removes it too, because the agent has the
answer. Where the hub cannot know, the old rule stands: an answer already sent to a streaming hook keeps its ✍ while the
poll waits, and comes off only when the hub itself decides the poll (the allow, or a deny that carries it). If the hook
ends the wait by itself afterwards (a lost connection, the time limit), the hub does not know whether the agent got
the answer, so the ✍ stays; this is a known limit, not a loss of the answer.
Commands (`/info`, `/compact`, `/pwsh` and so on) do not count as an answer, work as usual and do not
close the poll; `/stop` ends the session, and its poll becomes outdated.

**Cancel.** "✖️ Cancel" closes the poll: the hook answers `permissionDecision: "deny"` with the reason
"The user cancelled the question in Telegram. Do not ask it again; end your turn and wait for their
message." The agent ends the turn. The button ends only the poll that is shown; a poll of the same session that waits
behind it is then shown the same way as after an answer.

**A message with "!" while a poll is open.** It closes all the polls of the session, the shown one and those waiting, the same way as cancel, and the message itself
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
(`QUESTION_DEADLINE_MS`, `src/hook/question-limits.ts`: 86 340 000 ms against `timeout` 86400 s = 86 400 000 ms in
`hooks.json`, a margin of 60 s; the packaging test "the hook's deadline is a little under its timeout in hooks.json"
reads both and fails when the deadline is not below the timeout or the margin is not 60 s), and when the parent process is gone (checked every 2 s with the signal
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

**Answer stream.** The hub on Windows is usually killed, not stopped, so it cannot hand the answers over when it ends.
Instead it sends each accepted answer to the hook at once, over the response that is already open. A hook of the new
version announces this with the request header `x-question-stream: 1` (`QUESTION_STREAM_HEADER`). The body of a
streaming response is then lines, each ended by a newline: zero or more answer frames
`{"answered":{"question":"<question text>","answer":"<answer>"}}` and the decision JSON (`allow`, `deny` or `none`) as
the last line; the first chunk is still the single space. A hub writes a frame only when the request announced the
stream; a frame counts as accepted only if the write succeeded. The hook reads the body as lines
(`readLines`, `src/hook/question-lines.ts`): bytes are decoded as a stream, so a chunk cut anywhere, inside a UTF-8
character too, gives the same lines; a line is taken only once its newline came; what remains after the last newline when the body
ends is the decision of an older hub that sends no newline. A line that is an answer frame is kept (by question text,
in a `Map`); any other line is the decision.

**One rule for every technical end.** A technical end is any end of the wait that the hub did not decide: the hub
cannot be reached, the connection dropped or closed before the headers, the answer has an error status, the body is not
a valid decision, or the hook's own time limit ran out. One function in the hook (`technicalEnd`, `src/hook/question.ts`)
decides all of them, in this order:

1. The parent process is gone: silent, nothing reads the output.
2. The hub accepted the poll (the header was seen): a refusal with an English reason.
3. Otherwise the persisted Telegram mode of the session is read (`readSessionMode`, read-only): on, a refusal; off,
   unknown or the file unreadable, silent, the dialog opens in the terminal. An explicit `none` takes the same step 3.

The reason (`src/hook/question-reasons.ts`) never makes the agent loop. A lost connection and the time limit need an
outside event per round, so they say: the hub took the question, nothing was answered, nothing was asked in the
terminal, and if the answer is still needed, ask again with a single `AskUserQuestion` call. An end that would repeat
by itself (hub not reached, error status, unreadable answer, `none` with the mode on) says: do not call again, write
the question as plain text and end the turn.

An explicit `none` from the hub opens the terminal dialog (the hook stays silent) only when the persisted mode is not
on. The hub writes the mode off synchronously (`SessionStore.setEnabled` saves the file before it answers the polls
none), so a `none` that is the owner's choice of the terminal always finds the mode off. A `none` that finds the mode
on comes from a hub that answers none for another reason, and is a refusal with the plain-text reason. A session that is missing from the file, or a
file that cannot be read, stays silent, as in step 3. So with the mode on the hook never falls through to the terminal
dialog except when nobody reads its output.

**Mixed versions.** A new hook with a hub that sends no header (an older hub) never saw an acceptance, so step 3
decides every end by the persisted mode. An explicit `none` from an older hub with the mode on is read
the same way as from a new one (a refusal). An old hook with a new hub parses the body as JSON as before: it does not
send the stream header, so the hub sends no frames, the body is the space and one JSON, and the hub's own technical ends
still name the answers in the deny (the hub builds the whole text). A new hook with an older hub gets no frames and
the texts are exactly as before; its own ends then carry no answers, since it received none.

**Hub unreachable.** The request fails before any response (connection refused, or the connection closed before the
headers) or the answer has an error status. The persisted mode is the `sessions.json` of the state directory; the hook
never writes it and never renames a corrupt file. Mode on: refusal with the reason that the hub is unreachable and the
agent should write the question as plain text in its reply and end its turn, with no retry loop (a repeated
`AskUserQuestion` would hit the same dead hub). Mode off, session unknown, or the file unreadable: silent, the dialog
opens in the terminal. The hook's own time limit before any response (an older hub held the request) takes the ended
reason of the rule above; a gone parent is silent.

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
| Mode off at the request, or turned off while open | none (owner chose the terminal); the hook is silent only because the persisted mode is already off | moved to the terminal |
| An explicit none while the persisted mode is on | deny, write the question as plain text and end the turn (printed by the hook) | nothing |
| Esc, window closed (request aborted) | none, for that poll only (the hook is gone and prints nothing) | ended on the terminal side, /terminal or answer there if the agent still waits |
| The hook's own time limit after acceptance | deny, ask again (printed by the hook); the request is aborted, so the hub sees the same end as above | same |
| Session being started (`isStarting`) or being stopped at the request, mode off | none, no acceptance header (the session ends and the dialog goes with it) | nothing |
| Session being started or being stopped at the request, mode on | deny, the session is being stopped or restarted, do not ask again now (`SESSION_RESTARTING_REASON`), no acceptance header | nothing |
| Session stopped or cleaned up while open (`capturePending`), mode off | none (the session ends and the dialog goes with it) | moved to the terminal |
| Session stopped or cleaned up while open (`capturePending`), mode on | deny, the session is being stopped or restarted, do not ask again now | closed because the session is being stopped or restarted |
| "✖️ Cancel" button | deny, cancelled (the shown poll only; the next waiting poll is shown) | poll cancelled |
| A message with "!" | deny, cancelled (all polls of the session) | poll cancelled |
| The window moves to another session and no other window holds this one | deny, ask again (`windowGone`), all polls of the session; the dialog state of the session is released | closed, agent asked to ask again |
| Hub stops gracefully | deny, ask again (`hubStopping`), all polls; a `/question` that comes while the hub stops gets the same at once | closed, agent asked to ask again |
| The window of the session is gone, or a button is pressed with no connected window | deny, ask again (`windowGone`) | same |
| Telegram did not accept the poll message | deny, plain-text advice (`NOT_SHOWN_REASON`): do not call the tool again, write the question as plain text and end the turn; the next poll is shown | the existing "Telegram rejected" notice; the poll message was never sent, so it has no outcome line |
| Hub crash or restart without a graceful stop after acceptance | deny, ask again (printed by the hook: connection lost) | nothing (the hub is gone) |
| The body of the answer is unreadable after acceptance | deny, write the question as plain text and end the turn (printed by the hook) | nothing |
| Hub unreachable at the request or answers with an error status, mode on in `sessions.json` | deny, write the question as plain text and end the turn (printed by the hook) | nothing (the hub is gone) |
| Hub unreachable, closed the connection before acceptance or answered with an error status, mode off or unknown | none by silence: the hook prints nothing | nothing |
| The parent process of the hook is gone | none by silence: nothing reads the output | ended on the terminal side |

In the rows above, every deny from `hubStopping`, `windowGone`, `notShown`, the hook's connection lost, its time limit
and an unreadable end names the answers already given when there are any (see "Answers carried by a technical end");
the rows for cancel, "!", mode off and session restart carry none.

A denied poll from the hub tells the agent why the question got no answer in Telegram, that nothing was answered and
nothing was asked in the terminal, and to ask again with a single `AskUserQuestion` call. A refusal printed by the
hook says the hub took the question, with the same facts. Pressing a button of a closed
poll answers "The poll is outdated" and removes the buttons.

The ask-again advice is given only for ends that need an outside event before the next round: a hub restart
(`hubStopping`), a lost window (`windowGone`), the hook's 24 h limit, an owner's press or cancel. A rejection by Telegram
is the one end that could repeat on every new call with no outside event, so it is not an ask-again: the agent is told to
write the question as plain text.

**Answers carried by a technical end.** One text builder, `reasonWithAnswers` (`src/shared/question-answers.ts`), puts
the answers into the reason of every technical end: `hubStopping`, `windowGone`, `notShown` on the hub side;
`connectionLost`, `timeLimit` and an unreadable end after acceptance on the hook side. The producer of the deny builds
the whole text and nobody appends to it later: the hub in `finishPoll` (the end takes a function of the answers, so
there is one place for every hub-side end), the hook from the frames it received; the hook prints a deny the hub sent
as it is, so the answers are never added twice, whichever version is on either side. With no answers the text is exactly
the old one. With answers it is the opening sentence of the end, then `Already answered in Telegram, question and
answer:` and one line `- "<question>": "<answer>"` per answered question, then the instruction to ask only the
unanswered ones (for the plain-text ends: do not call `AskUserQuestion` for them, write only them as plain text). It
never says that nothing was answered when something was. The text is for the agent, so it is English. Question and
answer are JSON strings: a newline or a quote in a typed answer cannot be taken for the text around it, and the hook's
output stays valid JSON. Answers are never cut, however long.

When every question of the call was answered before the end and only the decision is missing, the hook's end is the
allow with those answers instead of a deny. A frame for a question the call did not ask does not count toward that.
The owner's cancel, the mode turned off and a session restart carry nothing.

**A text answer waiting when the poll ends.** An owner's text that the hub took as the answer to a question (it waits in
its answer group for the quiet time of a batch) must reach the agent, whatever ends the poll, and before any later
message of the owner in the same session's flow of messages. `finishPoll`, the one place every poll ends, flushes the
group of the poll at every end that is not the answer itself (cancel, a closed or lost window, the hook's abort, the mode
turned off, `notShown`, the bulk ends of the session); the advance to the next question of a multi-question poll flushes
it too. A flush of a group that is already gone is a no-op. This promises no order against the answers of later polls:
an answer goes back to the agent as the result of its tool call, a message goes through the channel, and Claude Code reads
a channel message only after the tool result, so the agent sees the answers of a poll before the words that ended an
earlier one.

**Words waiting in an answer group and a hub that is killed.** The quiet window of a group lasts up to 10 s, and a
hub killed meanwhile would lose the words that only lived in memory. So the words go into the terminal inbox
(`terminalInbox`, the same file that holds any topic message not yet seen by the agent) from the moment they join
the group, and are marked seen only once the agent has them:
- when they became an accepted answer that was written to the hook as a frame (the frame is written first, then the
  words are marked seen; a kill between the two writes errs toward a duplicate, never a loss);
- when the poll is decided (`finishPoll` marks what is left of its answers, for a hook that gets no frames), or when
  they are delivered as an ordinary message and the agent reports it saw them.

So after a kill the next hub delivers words that were only waiting, once, and does not deliver an accepted answer
again. A frame that could not be written (the hook is gone) marks nothing seen. Nothing stays after the poll: the
stream is dropped in `finishPoll` and the held ids are released.

**A reply to a question that is still being sent.** A reply belongs to the question only if it came after the question
message, which the hub tells by message ids. While the question message is on its way its id is not known yet, so a
message that arrives meanwhile waits for the send to settle (answer groups stand still, as during a photo download) and is
then attributed by the id; if the send failed there is no id and the message is an ordinary one. If the poll ended or moved
to the next question in the meantime, the message goes to the agent.

**Graceful stop.** `Hub.stop` runs in this order, and a message that reaches delivery after the last step is not handled:
1. The hub stops taking updates, and a `/question` of a session with the mode on is refused at once with the
   `hubStopping` advice (the next hub could not answer it).
2. Words waiting as an answer to the last question of a poll answer it; so do words waiting for a question that is already
   over (they go on to the agent). Words waiting for an earlier question would only open the next question, which the
   next hub cannot take, so they are not applied: the poll ends in step 3 and the words go to the agent.
3. Every other poll ends in the same tick with the `hubStopping` refusal, the waiting ones too; the words of the groups
   they hold go into batches.
4. Batches are flushed, in a loop, while the windows are still connected.
5. Delivery is closed, with nothing awaited between the last empty check of the batches and the closing. After that a
   message that would start a batch, an answer group, a hold or a launch is not handled: the poller does not save the
   offset for its update, and the next hub gets the update from Telegram again. Commands already executed are not
   repeated by the next hub (only delivery throws that way).
Stop does not wait for downloads or commands that are still running, except those a batch send already needs.

Known facts about the terminal side, not more: the hub sees an Esc or a killed hook only as an aborted request, so it cannot
tell the time limit, Esc and a restart apart; `sendInterrupt` writes a prompt to the window's messaging socket and is
documented as ending the turn as Esc does, but whether it closes an open `AskUserQuestion` dialog, and whether Esc
kills the hook, has not been verified, because a live probe needs the container with tmux
(`scripts/claude-probe-terminal.ts`).

**A dialog the owner does not see.** A dialog can sit in the terminal with no poll in Telegram: it opened while
Telegram mode was off, or the hook gave up. Claude Code queues every topic message behind it, so the owner would get
silence. When a message of the owner is delivered to the window of an interactive (`cli`) session with the mode on,
the topic gets one warning notice if all of this holds:

- the main transcript holds an `AskUserQuestion` call with no `tool_result`, and nothing since has overtaken it: no
  interrupt, no input typed in the terminal, no message of the hub taken, no end of a turn, no record of another agent
  message (the agent cannot go on while a dialog is open). Records of subagents are never read, and the window follows
  the transcript from its end, so a call made before `--resume` and a huge prefix are never seen or read;
- the hub took no poll for the call. The hook sends its `tool_use_id`; the hub notes every call it took (polls that
  ended in a refusal included) before the hook returns, which is before Claude Code writes the call to the transcript.
  A poll the owner sent to the terminal by turning the mode off is no longer a call the hub took. A call missing from that set is therefore no hub poll, however short ago it was written, so no
  timer decides it. A session whose hook sent no id (an older hook) is never warned, as its calls cannot be told apart;
- the session holds no open or queued poll, and no terminal supervisor owns it (the supervised terminal shows such a
  dialog itself). Whether a supervisor owns the session is a synchronous local check (`TerminalRelay.supervised`): its
  descriptor exists and the supervisor pid it records is alive; a descriptor that exists but cannot be read counts as
  supervised. It is not a request to the supervisor, because a request that fails for a moment would give a false
  warning. Nothing is awaited between the check and the notice, so the call is marked warned only when the notice is
  sent.

The notice quotes the question texts, says that the session waits on a dialog in its terminal and that messages wait
behind it, and that it must be answered on the PC (a session started with `/run` has `/terminal`). One notice per
call, kept until the session's last window closes. The window reads only what the tailer already has, at the moment
of the message; nothing polls.

The notice is always one Telegram message within `MAX_MESSAGE` (`dialogWarning`, `src/hub/questions.ts`): each
question is cut to 300 characters by code points (an emoji is never split), and questions that no longer fit are
replaced by one last line, "…and N more" (`dialogMore`), that counts them.

**Bounds and release of the dialog state.** The set of calls the hub took (`taken`) and the set of calls already warned
about (`warnedDialogs`) hold the newest 200 call ids per session (the same number as the ids of one batch). Beyond
that the oldest ids go, but never the id of a poll that is still open (`trimCalls`). Ids kept only because their polls
were open stay over the bound, so the same trim runs again whenever a poll ends, for both sets. The state of a session (its polls, `taken`,
`anonymousAsk`, `warnedDialogs`) is released by one function in two cases: the last window of the session closes, and a
window moves to another session while no other window holds the first (all polls of the first end with the
`windowGone` refusal, as for a close). A resume of the same session id ends nothing, and neither does a window whose
session another window still holds. A session without a window keeps dialog state only while it has an open poll.

Gaps, none of them a false notice: a dialog not yet flushed to the transcript at that moment is missed until the next
message; the owner may answer on the PC between the check and the notice; a notice is not repeated for a call, even if
the first was missed; sessions of the SDK entrypoints are not covered. A hub that dies after acceptance is not
reconnected: the hook denies and the agent asks again, which reaches the restarted hub if it is back by then.

**Buttons.** Labels are cut to 64 characters; `callback_data` is
`q:<key>:<question number>:<action>`, the key is 8 hex characters, as with permissions. Pressing a button of a
question that is not the current one counts as outdated.

**State.** The hub keeps open polls in memory. A graceful stop denies them (ask again, naming the answers already given);
a crash drops the connection, and the hook, which saw the acceptance, denies with the same advice and the answers it
received as frames, see the table. The answers survive a kill on the hook side (the frames) and the words waiting in a
group survive it in the terminal inbox; nothing else of a poll is kept across a hub restart.
