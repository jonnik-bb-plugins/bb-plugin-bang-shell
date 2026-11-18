# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] - 2026-11-18

### Added

- One-click **Run in terminal** button on fenced code blocks in assistant
  messages. The languages that get a button are set by `runButtonLanguages`
  (default `sh`, `bash`, `zsh`, `shell`, `console`, `terminal`; `fish` is also
  supported; `none` turns the button off).
- Opt-in `runPythonBlocks` setting (default off): `python`, `py` and `python3`
  blocks get the button too and run as a `python3` heredoc.
- Windows support proposal in `docs/proposals/windows-support.md`. The plugin
  is POSIX-only for now.

## [0.3.0] - 2026-11-09

### Added

- **Run in terminal** from highlighted text in a message: it appears in the
  assistant text-selection menu (next to Add to chat) and in each message's
  action bar. It runs the selection, or the message's first shell code block,
  through the composer with the same trust path as the keyboard shortcut, and
  restores your unfinished draft afterwards.
- README section explaining why to use the plugin: run agent-proposed commands
  that need access the agent's sandbox must not have, so the agent only sees
  the output.

### Fixed

- Run in terminal now works with an empty composer; it was blocked with "Type a
  message first." unless a draft already existed.
- Commands are cleaned of surrounding markdown (blockquote `>`, inline code,
  fenced blocks, `$ ` prompts). A quoted `` `cmd` `` no longer reaches the
  shell with an unclosed backtick and hangs as "still running".

## [0.2.2] - 2026-11-09

### Fixed

- Default shortcut is now `Mod+Alt+Enter`. `Mod+Shift+Enter` is bb's built-in
  `terminal.open` binding, so the plugin command was never triggered.

## [0.2.1] - 2026-11-08

### Added

- `disablePager` setting (default on): commands run with `PAGER=cat` and
  `GIT_PAGER=cat`, so `git log` or `man` print instead of waiting in a pager.

### Fixed

- Stray `=` and `>` characters from `less` and terminal escape sequences no
  longer appear in command output.
- The plugin now uses a valid bb icon (`Terminal`) instead of falling back to
  the default glyph.

## [0.2.0] - 2026-11-08

### Changed

- **BREAKING:** commands run only when sent with the composer's **Run in
  terminal** action (`Mod+Shift+Enter` at this version, or the Send menu).
  Plain Enter on a `!cmd` message is refused with a hint. Messages from
  agents, core and other plugins never run. The old plain-`!` behavior is
  available behind `requireRunAction=false`.
- A command runs at most once: failed updates, rechecks, reloads and
  cancel-and-resend never re-run it.

### Fixed

- Held messages no longer get stuck: every wait carries a deadline and the
  plugin rechecks on load.
- Command output is bounded, size limits are enforced, and poll failures are
  handled.

### Security

- Command text is no longer written to logs and the output block is labelled.
- README documents the trust model, including that bb does not authenticate
  the action's marker for raw local API clients.

## [0.1.0] - 2026-11-08

### Added

- Initial release. A message starting with a configurable prefix (default `!`)
  runs as a shell command in a terminal of the thread's environment, on the
  host where the session runs. The command and its output are sent to the
  agent as two blocks. All tunables are plugin settings.

[0.4.0]: https://github.com/jonnik-bb-plugins/bb-plugin-bang-shell/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jonnik-bb-plugins/bb-plugin-bang-shell/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/jonnik-bb-plugins/bb-plugin-bang-shell/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jonnik-bb-plugins/bb-plugin-bang-shell/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jonnik-bb-plugins/bb-plugin-bang-shell/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jonnik-bb-plugins/bb-plugin-bang-shell/releases/tag/v0.1.0
