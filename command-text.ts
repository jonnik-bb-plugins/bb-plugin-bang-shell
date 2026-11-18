// Picks the command a message action runs: the highlighted text, or, from the
// per-message action button, the first shell code block in the message.

const SHELL_LANGUAGES = new Set(["", "sh", "bash", "zsh", "shell", "console", "terminal", "fish"]);

/** Non-empty shell info strings, for registrations that require a language. */
export const SHELL_FENCE_LANGUAGES = [...SHELL_LANGUAGES].filter((language) => language !== "");

const PYTHON_FENCE_LANGUAGES = ["python", "py", "python3"];
/** Every language the Run button may be registered for; settings pick the active subset. */
export const RUN_FENCE_LANGUAGES = [...SHELL_FENCE_LANGUAGES, ...PYTHON_FENCE_LANGUAGES];

export const DEFAULT_RUN_BUTTON_LANGUAGES = "sh, bash, zsh, shell, console, terminal";
const RUN_BUTTON_SHELL_CHOICES = new Set(SHELL_FENCE_LANGUAGES);

/**
 * Shell languages whose code blocks get the Run button. Lowercased, deduped,
 * unknown entries dropped; "none" turns the shell button off; an empty result
 * or a non-string falls back to the default.
 */
export function parseRunButtonLanguages(value: unknown): string[] {
  if (typeof value === "string" && value.trim().toLowerCase() === "none") return [];
  const parse = (text: string) => [
    ...new Set(
      text
        .toLowerCase()
        .split(/[\s,]+/)
        .filter((entry) => RUN_BUTTON_SHELL_CHOICES.has(entry)),
    ),
  ];
  const parsed = typeof value === "string" ? parse(value) : [];
  return parsed.length > 0 ? parsed : parse(DEFAULT_RUN_BUTTON_LANGUAGES);
}

/** Languages the Run button is enabled for, from the plugin's effective settings. */
export function enabledRunLanguages(values: Record<string, unknown> | undefined): Set<string> {
  if (!values) return new Set();
  const enabled = new Set(parseRunButtonLanguages(values.runButtonLanguages));
  if (values.runPythonBlocks === true) for (const language of PYTHON_FENCE_LANGUAGES) enabled.add(language);
  return enabled;
}

/** First fenced code block whose info string is empty or a shell language, without its fences. */
export function firstShellBlock(markdown: string): string | null {
  const fence = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n`]*)\n([\s\S]*?)\n {0,3}\2[`~]*[ \t]*$/gm;
  for (const match of markdown.matchAll(fence)) {
    const language = match[3].trim().split(/\s+/)[0].toLowerCase();
    if (SHELL_LANGUAGES.has(language)) return stripPrompts(match[4]);
  }
  return null;
}

/** Drops a leading `$ ` prompt from console-style lines so copied transcripts run as commands. */
function stripPrompts(block: string): string {
  const lines = block.split("\n");
  if (!lines.some((line) => /^\s*\$ /.test(line))) return block;
  return lines
    .filter((line) => /^\s*\$ /.test(line))
    .map((line) => line.replace(/^\s*\$ /, ""))
    .join("\n");
}

/** The command a code block's Run button sends: prompts dropped, trimmed; null when empty. */
export function codeBlockCommand(code: string): string | null {
  return stripPrompts(code).trim() || null;
}

/**
 * The command a code block's Run button sends for its language: shell blocks as
 * `codeBlockCommand`, python as a heredoc into `python3 -` (prompts kept);
 * null for other languages or empty code.
 */
export function codeFenceCommand(language: string, code: string): string | null {
  const lang = language.trim().toLowerCase();
  if (RUN_BUTTON_SHELL_CHOICES.has(lang)) return codeBlockCommand(code);
  if (!PYTHON_FENCE_LANGUAGES.includes(lang)) return null;
  const body = code.trimEnd();
  if (!body.trim()) return null;
  const lines = new Set(body.split("\n"));
  let delimiter = "BB_PY_EOF";
  for (let n = 2; lines.has(delimiter); n += 1) delimiter = `BB_PY_EOF${n}`;
  return `python3 - <<'${delimiter}'\n${body}\n${delimiter}`;
}

export function pickCommand(selectedText: string | undefined, messageText: string): string | null {
  const selected = selectedText?.trim();
  if (selected) return selected;
  const block = firstShellBlock(messageText)?.trim();
  return block ? block : null;
}

/**
 * Strips markdown that bb's "Add to chat" (or a copy from a rendered message)
 * wraps around a command: blockquote markers, a fenced block, one inline code
 * span, and `$ ` prompts. Plain shell text comes back unchanged.
 */
export function normalizeCommand(text: string): string {
  let current = text.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = unwrapOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function unwrapOnce(text: string): string {
  const lines = text.split("\n");
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length > 0 && nonEmpty.every((line) => /^\s*>/.test(line))) {
    return lines.map((line) => line.replace(/^\s*> ?/, "")).join("\n").trim();
  }
  const fenced = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1[`~]*$/.exec(text);
  if (fenced) return fenced[2].trim();
  const inline = /^(`+)([^`][\s\S]*?)\1$/.exec(text);
  if (inline && !inline[2].includes(inline[1])) return inline[2].trim();
  if (nonEmpty.length > 0 && nonEmpty.every((line) => /^\s*\$ /.test(line))) {
    return lines.map((line) => line.replace(/^\s*\$ /, "")).join("\n").trim();
  }
  return text;
}
