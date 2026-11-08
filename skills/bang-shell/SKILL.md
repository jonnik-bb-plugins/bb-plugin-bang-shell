---
name: bang-shell
description: Explains the Bang Shell plugin — user messages starting with `!` run as shell commands in the thread's environment, and the agent receives the command with its output.
---

# Bang Shell

When the user sends a message that starts with `!` (for example `!git status`),
the plugin holds it in the thread's queue (card "Running: <command>"), runs the
command in a terminal of the thread's environment on the host where the session
runs, then replaces the message text with the command and its output tail and
sends it. The agent receives two fenced blocks, the command and then its output:

    ```sh
    git status
    ```

    ```
    <output>
    ```

A zero exit code is implied. A non-zero one ends the output block as
`[exit N]`; a command still running ends it with a "still running" note.

Treat that output as the user's own terminal result: read it, then answer
whatever the user asked about it (often nothing beyond the command itself).

- If the command is still running after `waitSeconds` (default 30), the message
  carries the output so far and the command keeps running in the thread's
  Terminal panel.
- Only messages typed by a human run commands; agent-to-agent messages and
  retries pass through unchanged.
- Settings (`bb plugin config bang-shell`, reload the plugin after a change):
  `enabled` (true), `prefix` (`!`), `waitSeconds` (30, 0 = do not wait),
  `outputTailChars` (3000), `pollIntervalMs` (200), `terminalCols` (120),
  `terminalRows` (32), `titleMaxChars` (60).
