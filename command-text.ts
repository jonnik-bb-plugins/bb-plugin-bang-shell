// Picks the command a message action runs: the highlighted text, or, from the
// per-message action button, the first shell code block in the message.

const SHELL_LANGUAGES = new Set(["", "sh", "bash", "zsh", "shell", "console", "terminal", "fish"]);

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
