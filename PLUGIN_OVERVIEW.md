Type `!` followed by a command in any thread's composer to run it in a terminal
on the machine where that thread's session runs.

## What you get

- `!ls -la`, `!git status`, `!df -h` run in the thread's working directory.
- The message waits in the queue while the command runs, then goes to the
  agent with the command, its output and exit code, so the session can use it.
- Commands that take longer keep running in the thread's Terminal panel.

## How it works

The plugin checks every message before it is dispatched. A message typed by a
person that starts with `!` is held in the queue; the plugin opens a terminal
in the thread's environment (on its host, local or remote), runs the command,
replaces the message text with the command and its output, and sends it. Messages from agents are never executed.

Settings: turn the feature off, change the prefix, how long to wait for output,
how much output to show, and the terminal size.
