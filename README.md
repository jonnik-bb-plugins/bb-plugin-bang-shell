# bb-plugin-bang-shell

Runs `!command` messages as shell commands in the thread's environment, on the
host where the session runs, then sends the message to the agent with the
command and its output in place of the `!command` text. See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md).

```sh
npm install --include=dev
bb plugin install .
bb plugin config bang-shell
bb plugin reload bang-shell   # settings are read at load
```

## Settings

| Key               | Default | Meaning                                                        |
| ----------------- | ------- | -------------------------------------------------------------- |
| `enabled`         | `true`  | Run prefixed messages as commands                              |
| `prefix`          | `!`     | Message prefix that marks a command                            |
| `waitSeconds`     | `30`    | Wait for output before sending the message; 0 = no wait        |
| `outputTailChars` | `3000`  | Last N output characters shown                                 |
| `pollIntervalMs`  | `200`   | Terminal poll interval while waiting                           |
| `terminalCols`    | `120`   | Terminal width                                                 |
| `terminalRows`    | `32`    | Terminal height                                                |
| `titleMaxChars`   | `60`    | Terminal tab title length                                      |

Invalid numbers fall back to the default.
