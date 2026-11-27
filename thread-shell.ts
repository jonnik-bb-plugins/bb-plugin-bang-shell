// Protocol of the per-thread interactive shell: the setup line that makes the
// shell announce when a command starts and ends, and the parsing of those
// announcements. The marks are private OSC sequences, invisible in the panel:
//   ESC ] 7777 ; <nonce> ; S BEL        a command starts executing
//   ESC ] 7777 ; <nonce> ; E ; <n> BEL  the prompt is back, last command exited with n
// Design and rationale: docs/proposals/thread-shell.md.
import { randomBytes, randomInt } from "node:crypto";

const ESC = "\u001b";
const BEL = "\u0007";
const TERMINAL_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

export const newNonce = () => randomBytes(6).toString("hex");

/** A caller-chosen terminal id (`term_` + 10 characters); an id stays taken after the terminal is closed. */
export const newTerminalId = () =>
  `term_${Array.from({ length: 10 }, () => TERMINAL_ID_ALPHABET[randomInt(TERMINAL_ID_ALPHABET.length)]).join("")}`;

/**
 * One line typed into a fresh shell. zsh gets `preexec`/`precmd` hooks, bash
 * 4.4+ gets `PS0`/`PROMPT_COMMAND`; any other shell prints no mark and is
 * reported unsupported. The leading space keeps it out of history, the
 * trailing clear keeps it out of the panel.
 */
export function setupLine(nonce: string, disablePager: boolean): string {
  const pager = disablePager ? " export PAGER=cat GIT_PAGER=cat;" : "";
  return (
    ` __bs_n=${nonce}; __bs_s(){ printf "\\033]7777;%s;S\\007" "$__bs_n"; }; ` +
    `__bs_e(){ local s=$?; printf "\\033]7777;%s;E;%d\\007" "$__bs_n" "$s"; return $s; }; ` +
    `if [ -n "$ZSH_VERSION" ]; then preexec_functions+=(__bs_s); precmd_functions=(__bs_e $precmd_functions); ` +
    `elif [ -n "$BASH_VERSION" ] && [ $((BASH_VERSINFO[0]*100+BASH_VERSINFO[1])) -ge 404 ]; then ` +
    `PS0=$'\\033]7777;'"$__bs_n"$';S\\007'; PROMPT_COMMAND="__bs_e\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; ` +
    `bind 'set enable-bracketed-paste on'; fi;${pager} printf "\\033[H\\033[2J\\033[3J"\r`
  );
}

/**
 * A command as one bracketed paste, so a multi-line block reaches the shell as
 * one unit and `read` takes keyboard input, not the block's next line. ESC is
 * dropped so the block cannot end the paste early.
 */
export const pasteInput = (command: string) => `${ESC}[200~${command.replaceAll(ESC, "")}${ESC}[201~\r`;

function markPattern(nonce: string): RegExp {
  return new RegExp(`${ESC}\\]7777;${nonce};(?:(S)|E;(\\d+))${BEL}`, "g");
}

export type ShellMark = { kind: "S" } | { kind: "E"; status: number };

/** The last mark in `text`, or null when it has none. */
export function lastMark(text: string, nonce: string): ShellMark | null {
  let last: ShellMark | null = null;
  for (const m of text.matchAll(markPattern(nonce))) last = m[1] ? { kind: "S" } : { kind: "E", status: Number(m[2]) };
  return last;
}

/**
 * Output of one command from a stream that begins at its write: everything
 * after the first start mark up to the next end mark. With no start mark the
 * shell never ran it (a parse error), so the end mark closes the job with
 * everything seen since the write. A mark split across chunks is carried over.
 */
export class JobScanner {
  started = false;
  done = false;
  exitCode: number | null = null;
  output = "";
  private carry = "";
  private readonly pattern: RegExp;
  private readonly head: string;
  private readonly maxChars: number;

  constructor(nonce: string, maxChars: number) {
    this.pattern = markPattern(nonce);
    this.head = `${ESC}]7777;${nonce};`;
    this.maxChars = maxChars;
  }

  push(chunk: string): void {
    if (this.done) return;
    const text = this.carry + chunk;
    this.carry = "";
    let from = 0;
    for (const m of text.matchAll(this.pattern)) {
      this.take(text.slice(from, m.index));
      from = m.index + m[0].length;
      if (m[1]) {
        if (!this.started) this.output = "";
        this.started = true;
      } else {
        this.done = true;
        this.exitCode = Number(m[2]);
        return;
      }
    }
    const rest = text.slice(from);
    const esc = rest.lastIndexOf(ESC);
    if (esc >= 0 && this.mayBecomeMark(rest.slice(esc))) {
      this.carry = rest.slice(esc);
      this.take(rest.slice(0, esc));
    } else {
      this.take(rest);
    }
  }

  private mayBecomeMark(tail: string): boolean {
    if (this.head.startsWith(tail)) return true;
    return tail.startsWith(this.head) && /^[SE;\d]*$/.test(tail.slice(this.head.length));
  }

  private take(text: string): void {
    const next = this.output + text;
    this.output = next.length > this.maxChars ? next.slice(next.length - this.maxChars) : next;
  }
}
