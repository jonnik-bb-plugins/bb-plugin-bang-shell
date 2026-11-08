Run a shell command from a thread's composer on the machine where that thread's
session runs, and hand the command and its output to the agent.

## What you get

- Send `git status`, `!ls -la` or a multi-line script with **Mod+Shift+Enter**
  or **Send menu → Run in terminal**; it runs in the thread's working directory.
- The message waits in the queue while the command runs, then goes to the agent
  as a command block and an output block, so the session can use the result.
- Commands that take longer keep running in the thread's Terminal panel.

## How it works

The plugin checks every message before it is dispatched. A message sent with
its Run in terminal action is held; the plugin opens a terminal in the thread's
environment (on its host, local or remote), runs the command once, replaces the
message text with the command and its output, and sends it. Plain messages
starting with `!` are refused with a hint instead of reaching the agent.

Messages from agents, other plugins and `bb thread tell` do not run. The
action's marker is not authenticated by bb, so a process that can reach bb's
local API could still forge it; README explains the limits. Settings control
the prefix, how long to wait, how much output to send and the terminal size;
a legacy mode lets plain `!` messages run, with the risks explained in README.
