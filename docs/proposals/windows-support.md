# Windows support

Status: proposed

## Problem

Bang Shell assumes the thread's terminal runs a POSIX shell. bb also runs on
Windows, where the terminal's shell is likely PowerShell or cmd. This is
unverified: which shell bb's `terminals.create` with
`start: {mode: "command"}` uses on Windows must be determined first.

POSIX assumptions in the code:

- `server.ts` `NO_PAGER_PREFIX` (`export PAGER=cat GIT_PAGER=cat; `) is
  prepended to every command while `disablePager` is on (the default). In
  PowerShell or cmd this is a syntax or unknown-command error, so every command
  fails by default.
- `command-text.ts` `codeFenceCommand` wraps Python blocks in a POSIX heredoc
  (`python3 - <<'BB_PY_EOF' ... BB_PY_EOF`), which neither PowerShell nor cmd
  understands.
- `$ ` prompt stripping assumes POSIX transcripts; PowerShell prompts look like
  `PS C:\dir>` and cmd prompts like `C:\dir>`.

## Goals

- The whole plugin works on Windows hosts: composer run, selection/message
  action, shell code-block button, pager suppression, Python blocks.
- A Run button on PowerShell code blocks (languages `powershell`, `pwsh`,
  `ps1`), behind a new `runPowerShellBlocks` setting (default `false`, like
  `runPythonBlocks`).

## Options

### (a) Detect the host shell, render per-shell text

Learn the terminal host's platform/shell server-side, then render the pager
prefix and wrappers per shell:

- POSIX: `export PAGER=cat GIT_PAGER=cat; `
- PowerShell: `$env:PAGER='cat'; $env:GIT_PAGER='cat'; `
- cmd: `set PAGER=cat&& set GIT_PAGER=cat&& `

Python wrapper per shell (PowerShell here-string piped to `python -`, cmd has no
clean equivalent).

Open point: how the server learns the platform when the terminal is on another
machine than the plugin server. Candidates: a bb API exposing the environment's
OS/shell; running a probe command in the terminal first and parsing the reply;
a manual `shell` setting as a fallback.

Pros: the agent sees readable commands. Cons: needs reliable detection; one
renderer per shell to maintain.

### (b) `pwsh -NoProfile -EncodedCommand <base64>`

Works from any shell where `pwsh` exists, so no detection is needed for
PowerShell blocks. Cons: the agent would see base64 instead of code.
Mitigation: put the original code in the message sent to the agent, and run only
the encoded form in the terminal. Requires PowerShell 7 (or `powershell.exe`
for Windows PowerShell 5.1) to be on PATH.

### (c) Temp script file

Write the block to a temp file and run it with the interpreter (`python3 file`,
`pwsh -File file`). Avoids heredoc and quoting problems in every shell. Cons:
needs a writable temp path on the terminal's host (which may differ from the
plugin server's host), and cleanup of the file.

## Recommendation (tentative)

(a) for pager suppression and shell commands, since the prefix is needed for
every command anyway; (b) for PowerShell blocks if detection proves unreliable;
(c) only if neither covers Python on cmd. Decide after the open questions are
answered.

## Open questions

- Which shell does `terminals.create` with `start: {mode: "command"}` use on
  Windows? Is it configurable by the user?
- Can the server read the terminal host's platform and shell from bb, including
  for remote environments?
- Does `PAGER=cat` do anything useful on Windows (Git for Windows ships its own
  `cat`; native `more` is the default pager elsewhere)?
- Is the Python launcher `python3`, `python` or `py` on typical Windows hosts?
- Output cleanup (escape codes, prompt echo) may differ with ConPTY.

## Verification plan

Needs a Windows host running bb. For each shell (PowerShell, cmd) check:

1. Plain command (`dir` / `Get-ChildItem`) runs and its output reaches the agent.
2. Multi-line command from the composer runs completely.
3. Pager suppression: `git log` in a repository prints without waiting.
4. Python block via the Run button runs and returns output.
5. PowerShell block via the Run button runs (with `runPowerShellBlocks` on).
6. Output capture and the exit code are reported correctly, including a failing
   command.

Also rerun `npm test` with unit tests for each renderer, and confirm POSIX
behaviour is unchanged.

## Non-goals

- Supporting shells other than POSIX sh family, PowerShell and cmd.
- Translating commands between shells.
- Changing the security model (`requireRunAction`).
- Installing Python or PowerShell on the host.
