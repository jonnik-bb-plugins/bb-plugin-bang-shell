# bb-plugin-bang-shell

Run a message as a shell command in the thread's environment, on the host where
the session runs, and send the command and its output to the agent.
See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md).

## Usage

Type the command in a thread's composer, then send it with
**Mod+Shift+Enter** (rebindable in keyboard settings) or **Send menu → Run in
terminal**. The leading `!` is optional with these actions: `!git status` and
`git status` both run `git status`. Pressing plain Enter on a message that
starts with `!` is refused with a hint, so nothing runs by accident.

The message waits in the queue (card "Running: …") while the command runs, then
goes to the agent as two blocks:

````
```sh
git status
```

```output
<last outputTailChars characters of the output>
```
````

A zero exit code is implied; a non-zero one, a still-running command, a lost
terminal or a start failure is the last line of the output block.
Multi-line messages run as a script.

## Install

```sh
npm install --include=dev
bb plugin install .
bb plugin config bang-shell
bb plugin reload bang-shell   # settings are read at load
```

## Settings

| Key                | Default | Range     | Meaning                                                                 |
| ------------------ | ------- | --------- | ----------------------------------------------------------------------- |
| `enabled`          | `true`  |           | Run commands at all                                                     |
| `requireRunAction` | `true`  |           | Only run messages sent with the Run in terminal action (see Security)   |
| `prefix`           | `!`     | 1–4 chars | Command marker; no spaces, must not start with `` ` `` `/` `$` `@` `#`  |
| `waitSeconds`      | `30`    | 0–3600    | Wait for output before sending; the command keeps running afterwards    |
| `outputTailChars`  | `3000`  | 1–30000   | Last N output characters sent                                           |
| `pollIntervalMs`   | `200`   | 50–10000  | Terminal poll interval while waiting                                    |
| `terminalCols`     | `120`   | 20–500    | Terminal width                                                          |
| `terminalRows`     | `32`    | 5–200     | Terminal height                                                         |
| `titleMaxChars`    | `60`    | 1–200     | Terminal tab title length                                               |
| `disablePager`     | `true`  |           | Run with `PAGER=cat GIT_PAGER=cat` so `git log` and `man` do not wait in a pager |

Out-of-range numbers are clamped; non-numbers and invalid prefixes fall back to
the default.

## Security

- **Who can run a command.** By default only a message submitted with this
  plugin's Run in terminal action, typed by a person: messages that bb marks
  as coming from an agent, from core or from another plugin's
  `bb.sdk.threads.send` never run, and `bb thread tell` cannot attach the
  action's marker, so `!…` sent that way is refused.
- **What the marker does not stop.** bb accepts the action's marker
  (`pluginSubmission`) from any client of its local HTTP API and does not
  verify that the composer set it. A process on this machine that can reach
  the bb API — including an agent's shell, which has `BB_SERVER_URL` — can
  forge it with a hand-written request and run a command; so can another
  plugin that posts to bb's loopback API directly. The gate stops accidents,
  prompt-injected `bb thread tell` calls and `bb.sdk.threads.send`; it is not a
  boundary against code already running as you. Closing that gap needs bb
  itself to authenticate the marker.
- **Legacy mode.** With `requireRunAction` off, any human-looking message
  starting with the prefix runs, and bb marks messages sent with
  `bb thread tell` as human-typed: **any agent can then run commands with one
  CLI call.** Leave it on unless you accept that.
- **What runs.** The command runs with your account's full rights in the
  thread's environment, outside the agent's permission mode — like typing it
  into that thread's terminal.
- **At most once.** Nothing runs while the dispatch hooks are still deciding:
  the command starts only after bb has queued the held message. It runs once;
  the job is tied to that queued message, and a failed message update, a
  re-check or a plugin reload never starts it again. If the plugin restarts
  between queueing and starting the terminal, the message reports "not re-run"
  instead of guessing. If the output cannot be attached after five tries, the
  message stays held with an explanation. If you edit the held message while
  the command runs, your edit is kept and sent as typed, without the output.
  Cancelling the held message, or sending it by hand, stops the plugin from
  touching it; the command itself keeps running in the thread's Terminal
  panel.
- **Output is untrusted.** The agent receives the output as part of your
  message, in a block labelled `output`. Output from untrusted sources (web
  pages, files) can contain text that looks like instructions; the bundled
  skill tells agents to treat that block as data.
- **Where data goes.** The command and up to `outputTailChars` characters of
  output become a message in the thread (sent to the agent's provider). While
  held, the command is also shown on the queued card ("Running: …") and kept in
  the plugin's storage until the message is sent or cancelled (24 h at most).
  The plugin log records thread ids, command lengths and error types, never
  the command text or output.

## Limits

- The first message of a new thread cannot be a command: the environment does
  not exist yet.
- Commands longer than 8000 characters are refused; run a script file instead.
- If bb or another plugin refuses a Run in terminal submission, sending the
  same command again with the action is refused for up to a minute.
- If you group a held command with other queued messages, the group is sent
  when the command's message is.

## Development

```sh
npm run typecheck
npm test
bb plugin build
```
