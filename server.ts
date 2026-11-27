// bb-plugin-bang-shell: runs a message as a shell command in a terminal of the
// thread's environment, then sends the command and its output to the agent.
// Trust model, lifecycle and at-most-once execution: README.md, "Security".
import { createHash, randomUUID } from "node:crypto";
import type {
  BbPluginApi,
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import { DEFAULT_RUN_BUTTON_LANGUAGES, TERMINAL_REVEAL_CHANNEL, THREAD_SHELL_TITLE, normalizeCommand } from "./command-text.ts";
import { JobScanner, lastMark, newNonce, newTerminalId, pasteInput, setupLine } from "./thread-shell.ts";

type ThreadQueuedMessage = MessageDispatchHookContext["queuedMessages"][number];

/** Key the composer action puts in `experimental_data`. */
export const SUBMISSION_KEY = "bangShell";
export const SUBMISSION_VERSION = 1;
/** Same key: run in the thread's persistent shell instead of a fresh terminal. */
export const SHELL_SUBMISSION_VERSION = 2;

export const DEFAULTS = {
  prefix: "!",
  waitSeconds: 30,
  threadShellWaitSeconds: 600,
  outputTailChars: 3000,
  pollIntervalMs: 200,
  terminalCols: 120,
  terminalRows: 32,
  titleMaxChars: 60,
} as const;

export const LIMITS = {
  waitSeconds: [0, 3600],
  threadShellWaitSeconds: [0, 3600],
  outputTailChars: [1, 30_000],
  pollIntervalMs: [50, 10_000],
  terminalCols: [20, 500],
  terminalRows: [5, 200],
  titleMaxChars: [1, 200],
} as const;

/** Keeps a job record (command + message) well under the 256 KB kv value limit. */
export const MAX_COMMAND_CHARS = 8000;

const AUTH_PREFIX = "auth:";
const JOB_PREFIX = "job:";
const ROW_PREFIX = "row:";
const SHELL_PREFIX = "shell:";
/** Bounds for one thread-shell start, each in ms; none is a setting. */
const PROMPT_WAIT_MS = 3000;
const SETUP_WAIT_MS = 5000;
const START_SEEN_WAIT_MS = 3000;
/** Scrollback read to tell whether the shell is idle; more output than this since the last mark counts as busy. */
const TAIL_BYTES = 65_536;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
/** An authorization no queued row picked up within this time was refused by core or another plugin. */
const AUTHORIZED_TTL_MS = 60 * 1000;
const MAX_REWRITE_ATTEMPTS = 5;
const MAX_POLL_FAILURES = 3;
/** A prompt must remain unfinished and quiet across polls before navigation. */
const INPUT_QUIET_MS = 300;
const REASK_MS = 2000;
/** Core may stamp a row slightly before the hook that authorized it ran. */
const ROW_CLOCK_SKEW_MS = 5000;
/** The authorized row is queued right after the hook pass; later rows are other messages. */
const ROW_BIND_WINDOW_MS = 30_000;

/** Prepended to every command so `git log`, `man` and friends print instead of waiting in a pager. */
export const NO_PAGER_PREFIX = "export PAGER=cat GIT_PAGER=cat; ";

// CSI and OSC sequences, then any other escape sequence (`ESC =`, `ESC (B`, …).
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[ -/]*[0-~]/g;

/**
 * A usable prefix: 1–4 characters, no whitespace, and not starting with a
 * character bb or this plugin already gives meaning to (`/` and `$` open the
 * command menus, `@` mentions, `#`, and `` ` `` starts the rewritten message).
 */
export function normalizePrefix(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length < 1 || raw.length > 4 || /\s/.test(raw)) return null;
  if (/^[`/$@#]/.test(raw)) return null;
  return raw;
}

/** The command after `prefix` (strictly at the first character), "" for a bare prefix, else null. */
export function parseBangCommand(text: string, prefix: string): string | null {
  if (prefix === "" || !text.startsWith(prefix)) return null;
  return text.slice(prefix.length).trim();
}

export function cleanTerminalOutput(raw: string): string {
  return raw
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trimEnd();
}

/** Appends and keeps only the last `max` characters. */
export function appendBounded(buffer: string, chunk: string, max: number): string {
  const next = buffer + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Whole number clamped to [min, max]; non-numbers fall back to `fallback`. */
export function wholeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export type Target = "terminal" | "shell";

/** Where this plugin's own submission asks to run, or null for anyone else's. */
export function submissionTarget(
  submission: { pluginId: string; data: unknown } | null | undefined,
  pluginId: string,
): Target | null {
  if (!submission || submission.pluginId !== pluginId) return null;
  const data = submission.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const version = (data as Record<string, unknown>)[SUBMISSION_KEY];
  if (version === SUBMISSION_VERSION) return "terminal";
  return version === SHELL_SUBMISSION_VERSION ? "shell" : null;
}

export function isOwnSubmission(
  submission: { pluginId: string; data: unknown } | null | undefined,
  pluginId: string,
): boolean {
  return submissionTarget(submission, pluginId) !== null;
}

type TextBlock = { type: string; text?: string };

/** The message text the way core builds `ctx.input.text`: text blocks joined by newlines. */
export function messageText(content: readonly TextBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/** Key of a pending authorization: one per thread and message text. */
export function authKey(threadId: string, text: string): string {
  const digest = createHash("sha256").update(text.trim()).digest("hex").slice(0, 40);
  return `${AUTH_PREFIX}${threadId}:${digest}`;
}

/** First text block becomes `message`; other text blocks are dropped; attachments stay. */
export function replaceText<T extends TextBlock>(content: readonly T[], message: string): (T | TextBlock)[] {
  const out: (T | TextBlock)[] = [];
  let placed = false;
  for (const block of content) {
    if (block.type !== "text") {
      out.push(block);
    } else if (!placed) {
      out.push({ ...block, text: message, mentions: [] });
      placed = true;
    }
  }
  if (!placed) out.unshift({ type: "text", text: message, mentions: [] } as TextBlock);
  return out;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

function fenced(info: string, text: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…\n${text.slice(-maxChars)}`;
}

export type Outcome =
  | { kind: "exited"; exitCode: number | null }
  | { kind: "running"; terminalTitle: string }
  | { kind: "disconnected" }
  | { kind: "failed" }
  | { kind: "unknown" }
  | { kind: "busy" }
  | { kind: "unreachable" }
  | { kind: "unsupported" }
  | { kind: "uncertain" };

/**
 * The message the agent receives: a `sh` block with the command, then an
 * `output` block. A zero exit code is implied; anything else is the last line
 * of the output block.
 */
export function formatShellMessage(command: string, output: string, outcome: Outcome): string {
  let note = "";
  switch (outcome.kind) {
    case "exited":
      if (outcome.exitCode !== 0) note = `[exit ${outcome.exitCode ?? "?"}]`;
      break;
    case "running":
      note = `[still running in terminal tab "${outcome.terminalTitle}"; output so far]`;
      break;
    case "disconnected":
      note = "[lost the terminal before the command finished]";
      break;
    case "failed":
      note = "[the terminal could not be started]";
      break;
    case "unknown":
      note = "[plugin restarted while starting the command; it was not re-run and may not have run]";
      break;
    case "busy":
      note = "[not run: thread shell busy]";
      break;
    case "unreachable":
      note = "[not run: could not reach the thread shell; nothing was sent to it]";
      break;
    case "unsupported":
      note = "[not run: the thread shell did not report ready (zsh and bash 4.4+ only); see the Thread shell tab]";
      break;
    case "uncertain":
      note = "[could not confirm the command reached the thread shell; it was not re-run and may not have run]";
      break;
  }
  const shown = [output, note].filter(Boolean).join("\n");
  const blocks = [fenced("sh", command)];
  if (shown) blocks.push(fenced("output", shown));
  return blocks.join("\n\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * auth record (per text, ≤60 s) → row queued → job: starting → running →
 * done → rewritten → row sent → deleted. Only the process that bound a job to
 * its row may start the command.
 */
type JobState = "starting" | "running" | "done" | "rewritten";

interface Authorization {
  id: string;
  threadId: string;
  /** `authKey` of the authorized text; a row whose text no longer matches was edited. */
  textKey: string;
  command: string;
  terminalTitle: string;
  createdAt: number;
  /** Absent on records from before the thread shell: a fresh terminal. */
  target?: Target;
}

/** One per thread; the terminal's marks, not this record, say whether it is idle. */
interface ShellRecord {
  terminalId: string;
  nonce: string;
  state: "starting" | "ready";
  /** Output position of the last plugin write: the shell is busy until an end mark follows it. */
  writeSeq?: number;
}

interface JobRecord extends Authorization {
  state: JobState;
  rowId: string;
  terminalId: string | null;
  message: string | null;
  rewriteAttempts: number;
  /** Thread shell: output position and marks nonce, saved before the command is written. */
  sinceSeq?: number;
  nonce?: string;
  /** Normal run: reveal once and preserve its input grace period across reloads. */
  revealedAt?: number;
}

const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Run commands",
      description: "When off, nothing new is executed and messages go to the agent as usual.",
      default: true,
    },
    requireRunAction: {
      type: "boolean",
      label: "Only run commands sent with the Run in terminal action",
      description:
        "On: plain Enter never runs a command; use Mod+Alt+Enter or Send menu → Run in terminal. Off (legacy): any message starting with the prefix runs, including ones an agent sends with `bb thread tell`. See README, Security.",
      default: true,
    },
    prefix: {
      type: "string",
      label: "Command prefix",
      description:
        "1–4 characters, no spaces, not starting with ` / $ @ #. Optional with the Run in terminal action; required in legacy mode.",
      default: DEFAULTS.prefix,
    },
    waitSeconds: {
      type: "number",
      label: "Seconds to wait for output",
      description: "0–3600. After this the message is sent with the output so far and the running terminal is shown. A recognized input prompt extends the wait using the thread shell timeout.",
      default: DEFAULTS.waitSeconds,
    },
    threadShellWaitSeconds: {
      type: "number",
      label: "Seconds to wait in the thread shell",
      description:
        "0–3600. Wait for a thread shell command to finish, or allow this much time after revealing a normal run's input prompt. Ctrl-C ends the command; after the timeout, send output so far.",
      default: DEFAULTS.threadShellWaitSeconds,
    },
    outputTailChars: {
      type: "number",
      label: "Output characters sent",
      description: "1–30000. Only the last N characters of the output are sent.",
      default: DEFAULTS.outputTailChars,
    },
    pollIntervalMs: {
      type: "number",
      label: "Output poll interval (ms)",
      description: "50–10000.",
      default: DEFAULTS.pollIntervalMs,
    },
    terminalCols: { type: "number", label: "Terminal columns", description: "20–500.", default: DEFAULTS.terminalCols },
    terminalRows: { type: "number", label: "Terminal rows", description: "5–200.", default: DEFAULTS.terminalRows },
    disablePager: {
      type: "boolean",
      label: "Turn off pagers",
      description: "Run commands with PAGER=cat and GIT_PAGER=cat so git log, git diff and man print their output instead of waiting in less.",
      default: true,
    },
    runButtonLanguages: {
      type: "string",
      label: "Run button languages",
      description:
        "Code block languages that get a Run button: sh, bash, zsh, shell, console, terminal, fish (comma or space separated), or none. Read by the app; the server ignores it.",
      default: DEFAULT_RUN_BUTTON_LANGUAGES,
    },
    runPythonBlocks: {
      type: "boolean",
      label: "Run button on Python blocks",
      description: "Also add the Run button to python, py and python3 code blocks (run with python3 in the thread's shell).",
      default: false,
    },
    titleMaxChars: {
      type: "number",
      label: "Terminal title length",
      description: "1–200. Terminal tabs are titled with the command, cut to this length.",
      default: DEFAULTS.titleMaxChars,
    },
  });
  const raw = await settings.get();
  const prefix = normalizePrefix(raw.prefix);
  if (prefix === null) bb.log.warn(`invalid prefix setting; using "${DEFAULTS.prefix}"`);
  const num = (key: keyof typeof LIMITS) =>
    wholeNumber(raw[key], DEFAULTS[key], LIMITS[key][0], LIMITS[key][1]);
  const config = {
    enabled: raw.enabled !== false,
    requireRunAction: raw.requireRunAction !== false,
    prefix: prefix ?? DEFAULTS.prefix,
    waitMs: num("waitSeconds") * 1000,
    threadShellWaitMs: num("threadShellWaitSeconds") * 1000,
    outputTailChars: num("outputTailChars"),
    pollIntervalMs: num("pollIntervalMs"),
    terminalCols: num("terminalCols"),
    terminalRows: num("terminalRows"),
    titleMaxChars: num("titleMaxChars"),
    disablePager: raw.disablePager !== false,
  };
  // Raw PTY text kept while waiting: enough for the tail once escape codes are stripped.
  const rawBufferChars = config.outputTailChars * 4 + 4096;

  let disposed = false;
  bb.onDispose(() => {
    disposed = true;
  });

  const kv = bb.storage.kv;
  const jobKey = (id: string) => `${JOB_PREFIX}${id}`;
  const rowKey = (rowId: string) => `${ROW_PREFIX}${rowId}`;
  const inFlight = new Map<string, Promise<void>>();
  /** Job ids this process bound to a row; only they may start a command. */
  const startable = new Set<string>();
  /** Job ids whose row left the queue. */
  const gone = new Set<string>();
  /** Row ids whose `message.queued` delivery is being handled. */
  const claiming = new Set<string>();

  async function loadAuth(key: string): Promise<Authorization | undefined> {
    const auth = await kv.get<Authorization>(key);
    if (auth && Date.now() - auth.createdAt > AUTHORIZED_TTL_MS) {
      // Never picked up by a queued row: core or another plugin refused the message.
      await kv.delete(key);
      return undefined;
    }
    return auth;
  }

  async function loadJob(id: string): Promise<JobRecord | undefined> {
    const job = await kv.get<JobRecord>(jobKey(id));
    if (job && Date.now() - job.createdAt > JOB_TTL_MS) {
      await dropJob(job);
      return undefined;
    }
    return job;
  }

  async function dropJob(job: JobRecord): Promise<void> {
    await kv.delete(jobKey(job.id));
    await kv.delete(rowKey(job.rowId));
  }

  async function saveJob(job: JobRecord): Promise<void> {
    if (gone.has(job.id)) return;
    await kv.set(jobKey(job.id), job);
  }

  function checkAlive(job: JobRecord): void {
    if (disposed) throw new Error("plugin reloaded");
    if (gone.has(job.id)) throw new Error("message left the queue");
  }

  /** Only the load that bound the job may start it; after a reload whether it started is unknown. */
  function claimStart(job: JobRecord): boolean {
    if (startable.delete(job.id)) return true;
    job.state = "done";
    job.message = formatShellMessage(job.command, "", { kind: "unknown" });
    return false;
  }

  async function startCommand(job: JobRecord): Promise<void> {
    if (!claimStart(job)) return;
    try {
      const terminal = await bb.sdk.terminals.create({
        scope: { kind: "thread", threadId: job.threadId },
        cols: config.terminalCols,
        rows: config.terminalRows,
        title: job.terminalTitle,
        start: { mode: "command", command: (config.disablePager ? NO_PAGER_PREFIX : "") + job.command },
      });
      job.terminalId = terminal.id;
      job.terminalTitle = terminal.title;
      job.state = "running";
    } catch (error) {
      bb.log.warn(`terminal for a command in ${job.threadId} failed to start (${errorKind(error)})`);
      job.state = "done";
      job.message = formatShellMessage(job.command, "", { kind: "failed" });
    }
  }

  async function pollCommand(job: JobRecord): Promise<void> {
    const terminalId = job.terminalId as string;
    const decoder = new TextDecoder();
    let buffer = "";
    let sinceSeq: number | undefined;
    let failures = 0;
    let deadline = Math.max(job.createdAt + config.waitMs, job.revealedAt ? job.revealedAt + config.threadShellWaitMs : 0);
    let quietSince = Date.now();
    const publishReveal = () => {
      checkAlive(job);
      try {
        bb.realtime.publish(TERMINAL_REVEAL_CHANNEL, { threadId: job.threadId, terminalId });
      } catch { /* Navigation is best effort; output delivery must continue. */ }
    };
    for (;;) {
      checkAlive(job);
      let outcome: Outcome | null = null;
      let running = false;
      try {
        const out = await bb.sdk.terminals.output({ terminalId, sinceSeq });
        failures = 0;
        if (out.chunks.some((chunk) => chunk.dataBase64.length > 0)) quietSince = Date.now();
        running = out.status === "running";
        for (const chunk of out.chunks) {
          buffer = appendBounded(
            buffer,
            decoder.decode(Buffer.from(chunk.dataBase64, "base64"), { stream: true }),
            rawBufferChars,
          );
        }
        sinceSeq = out.nextSeq;
        if (out.status === "exited") outcome = { kind: "exited", exitCode: out.exitCode };
        else if (out.status === "disconnected") outcome = { kind: "disconnected" };
      } catch {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) outcome = { kind: "disconnected" };
      }
      checkAlive(job);
      if (running && !job.revealedAt && Date.now() - quietSince >= INPUT_QUIET_MS) {
        const line = buffer.replace(ANSI_PATTERN, "").split(/\r\n?|\n/).at(-1) ?? "";
        if (/(?:\[[yn]\/[yn]\]|\([yn]\/[yn]\)|[?:])\s*$/i.test(line)) {
          job.revealedAt = Date.now();
          await saveJob(job);
          publishReveal();
          deadline = Math.max(deadline, job.revealedAt + config.threadShellWaitMs);
        }
      }
      if (!outcome && Date.now() >= deadline) {
        outcome = { kind: "running", terminalTitle: job.terminalTitle };
      }
      if (outcome) {
        job.state = "done";
        job.message = formatShellMessage(job.command, tail(cleanTerminalOutput(buffer), config.outputTailChars), outcome);
        await saveJob(job);
        if (outcome.kind === "running" && running && !job.revealedAt) publishReveal();
        if (outcome.kind === "exited") {
          await bb.sdk.terminals.close({ terminalId, mode: "force" }).catch(() => {});
        }
        return;
      }
      await sleep(config.pollIntervalMs);
    }
  }

  // ---- thread shell: one interactive terminal per thread, state read from its marks

  const shellKey = (threadId: string) => `${SHELL_PREFIX}${threadId}`;
  const shellChain = new Map<string, Promise<unknown>>();
  /** Threads whose serialized write section is running. */
  const shellHeld = new Set<string>();

  /** One write section per thread at a time; the hook reads `shellHeld` without taking part. */
  function withShellLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const run = (shellChain.get(threadId) ?? Promise.resolve()).then(async () => {
      shellHeld.add(threadId);
      try {
        return await fn();
      } finally {
        shellHeld.delete(threadId);
      }
    });
    shellChain.set(threadId, run.catch(() => {}));
    return run;
  }

  async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
      if (await check().catch(() => false)) return true;
      if (Date.now() >= end || disposed) return false;
      await sleep(config.pollIntervalMs);
    }
  }

  async function readOutput(terminalId: string, args: { sinceSeq?: number; tailBytes?: number }) {
    const out = await bb.sdk.terminals.output({ terminalId, ...args });
    const decoder = new TextDecoder();
    const parts = out.chunks.map((c) => ({ seq: c.seq, text: decoder.decode(Buffer.from(c.dataBase64, "base64"), { stream: true }) }));
    return {
      text: parts.map((p) => p.text).join(""),
      parts,
      nextSeq: out.nextSeq,
      alive: out.status === "running" || out.status === "starting",
    };
  }

  /** bb answers an unknown terminal with HTTP 404 and code `terminal_not_found`. */
  function isNotFound(error: unknown): boolean {
    const e = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown } | null;
    return (
      e?.code === "terminal_not_found" ||
      e?.status === 404 ||
      e?.statusCode === 404 ||
      (typeof e?.message === "string" && /terminal_not_found|\bHTTP 404\b/.test(e.message))
    );
  }

  /** An output error alone proves nothing about the terminal: only a reported exit or "not found" counts as gone. */
  async function terminalState(terminalId: string): Promise<"alive" | "gone" | "unknown"> {
    try {
      return (await readOutput(terminalId, { tailBytes: 1 })).alive ? "alive" : "gone";
    } catch {
      // Ask the terminal itself below.
    }
    try {
      const { status } = await bb.sdk.terminals.get({ terminalId });
      return status === "exited" || status === "disconnected" ? "gone" : "unknown";
    } catch (error) {
      return isNotFound(error) ? "gone" : "unknown";
    }
  }

  /**
   * The thread's shell record when its terminal is alive and set up, undefined
   * when it is gone (the record is dropped), null when it cannot be reached
   * right now (the record stays, nothing is recreated).
   */
  async function liveShell(threadId: string): Promise<ShellRecord | undefined | null> {
    const record = await kv.get<ShellRecord>(shellKey(threadId));
    if (!record) return undefined;
    if (record.state === "ready") {
      const state = await terminalState(record.terminalId);
      if (state === "alive") return record;
      if (state === "unknown") return null;
    }
    // Closed or exited, or a setup that never finished (a reload mid-setup): start over, leaving the terminal to the user.
    await kv.delete(shellKey(threadId));
    return undefined;
  }

  /** A new thread shell with the mark hooks installed, or null when it never reported ready. */
  async function createShell(threadId: string): Promise<ShellRecord | null> {
    const record: ShellRecord = { terminalId: newTerminalId(), nonce: newNonce(), state: "starting" };
    // Saved first so a reload between create and the end of setup cannot lose track of the terminal.
    await kv.set(shellKey(threadId), record);
    try {
      await bb.sdk.terminals.create({
        id: record.terminalId,
        scope: { kind: "thread", threadId },
        cols: config.terminalCols,
        rows: config.terminalRows,
        title: THREAD_SHELL_TITLE,
        start: { mode: "shell" },
      });
      // Typing before the first prompt can be lost to the shell's own startup.
      await until(async () => (await readOutput(record.terminalId, { tailBytes: 1 })).nextSeq > 0, PROMPT_WAIT_MS);
      const line = setupLine(record.nonce, config.disablePager);
      await bb.sdk.terminals.input({ terminalId: record.terminalId, dataBase64: Buffer.from(line).toString("base64") });
    } catch (error) {
      await kv.delete(shellKey(threadId));
      throw error;
    }
    const ready = await until(
      async () => lastMark((await readOutput(record.terminalId, { tailBytes: TAIL_BYTES })).text, record.nonce)?.kind === "E",
      SETUP_WAIT_MS,
    );
    if (!ready) {
      await kv.delete(shellKey(threadId));
      return null;
    }
    record.state = "ready";
    await kv.set(shellKey(threadId), record);
    return record;
  }

  /**
   * Idle means the last mark in the tail is an end mark that follows the
   * plugin's last write: an unterminated heredoc or quote leaves a continuation
   * prompt with no mark at all, so a tail without marks after the write is busy.
   */
  async function readIdle(record: ShellRecord) {
    const out = await readOutput(record.terminalId, { tailBytes: TAIL_BYTES });
    const afterWrite = out.parts.filter((part) => part.seq >= (record.writeSeq ?? 0));
    const mark = lastMark(afterWrite.map((part) => part.text).join(""), record.nonce);
    return { idle: mark?.kind === "E", alive: out.alive, nextSeq: out.nextSeq };
  }

  /** True while a write section runs or the shell is not idle. */
  async function shellBusy(threadId: string): Promise<boolean> {
    if (shellHeld.has(threadId)) return true;
    const record = await kv.get<ShellRecord>(shellKey(threadId));
    if (record?.state !== "ready") return false;
    try {
      const state = await readIdle(record);
      return state.alive && !state.idle;
    } catch {
      return false;
    }
  }

  async function startShellCommand(job: JobRecord): Promise<void> {
    if (!claimStart(job)) return;
    const end = (outcome: Outcome) => {
      job.state = "done";
      job.message = formatShellMessage(job.command, "", outcome);
    };
    await withShellLock(job.threadId, async () => {
      checkAlive(job);
      let shell: ShellRecord | null | undefined;
      try {
        const live = await liveShell(job.threadId);
        if (live === null) return end({ kind: "unreachable" });
        shell = live ?? (await createShell(job.threadId));
        if (!shell) return end({ kind: "unsupported" });
      } catch (error) {
        bb.log.warn(`thread shell in ${job.threadId} failed to start (${errorKind(error)})`);
        return end({ kind: "failed" });
      }
      let state: Awaited<ReturnType<typeof readIdle>>;
      try {
        state = await readIdle(shell);
      } catch {
        return end({ kind: "unreachable" });
      }
      // Re-checked inside the section: the shell may have become busy after the hook looked.
      if (!state.idle) return end({ kind: "busy" });
      job.terminalId = shell.terminalId;
      job.terminalTitle = THREAD_SHELL_TITLE;
      job.nonce = shell.nonce;
      job.sinceSeq = state.nextSeq;
      job.state = "running";
      shell.writeSeq = state.nextSeq;
      // From here the command counts as written: it is never written again, whatever happens next.
      await kv.set(shellKey(job.threadId), shell);
      await saveJob(job);
      try {
        await bb.sdk.terminals.input({ terminalId: shell.terminalId, dataBase64: Buffer.from(pasteInput(job.command)).toString("base64") });
      } catch (error) {
        bb.log.warn(`writing a command to the thread shell in ${job.threadId} failed (${errorKind(error)})`);
        return end({ kind: "uncertain" });
      }
      // Hold the section until the shell reports the start, so a quick second click finds it busy.
      const scan = new JobScanner(shell.nonce, 1);
      let seq = state.nextSeq;
      await until(async () => {
        const out = await readOutput(shell.terminalId, { sinceSeq: seq });
        seq = out.nextSeq;
        scan.push(out.text);
        return scan.started || scan.done || !out.alive;
      }, START_SEEN_WAIT_MS);
    });
  }

  async function pollShellCommand(job: JobRecord): Promise<void> {
    const terminalId = job.terminalId as string;
    const scan = new JobScanner(job.nonce as string, rawBufferChars);
    let sinceSeq = job.sinceSeq;
    let failures = 0;
    let terminalGone = false;
    // Its own cap, not `waitMs`: the user may still be typing into a `read`.
    const deadline = job.createdAt + config.threadShellWaitMs;
    for (;;) {
      checkAlive(job);
      let outcome: Outcome | null = null;
      try {
        const out = await readOutput(terminalId, { sinceSeq });
        failures = 0;
        scan.push(out.text);
        sinceSeq = out.nextSeq;
        if (scan.done) outcome = { kind: "exited", exitCode: scan.exitCode };
        else if (!out.alive) {
          outcome = { kind: "disconnected" };
          terminalGone = true;
        }
      } catch {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          outcome = { kind: "disconnected" };
          terminalGone = (await terminalState(terminalId)) === "gone";
        }
      }
      if (!outcome && Date.now() >= deadline) {
        outcome = scan.started ? { kind: "running", terminalTitle: job.terminalTitle } : { kind: "uncertain" };
      }
      if (outcome) {
        job.state = "done";
        job.message = formatShellMessage(job.command, tail(cleanTerminalOutput(scan.output), config.outputTailChars), outcome);
        await saveJob(job);
        if (terminalGone) {
          const record = await kv.get<ShellRecord>(shellKey(job.threadId));
          if (record?.terminalId === terminalId) await kv.delete(shellKey(job.threadId));
        }
        return;
      }
      await sleep(config.pollIntervalMs);
    }
  }

  async function rewriteMessage(job: JobRecord): Promise<void> {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId: job.threadId });
    const row = rows.find((r) => r.id === job.rowId);
    checkAlive(job);
    if (!row || authKey(job.threadId, messageText(row.content)) !== job.textKey) {
      // Sent, deleted, or edited by the user: leave the row as it is.
      await dropJob(job);
      return;
    }
    try {
      await bb.sdk.threads.queuedMessages.update({
        threadId: job.threadId,
        queuedMessageId: row.id,
        expectedUpdatedAt: row.updatedAt,
        input: replaceText(row.content, job.message ?? "") as typeof row.content,
      });
      job.state = "rewritten";
    } catch (error) {
      // Typically the row is held by a dispatch pass; `onQueued` retries once it is re-queued.
      job.rewriteAttempts += 1;
      bb.log.warn(`could not update a held message in ${job.threadId} (${errorKind(error)})`);
    }
    await saveJob(job);
  }

  async function work(id: string): Promise<void> {
    const job = await loadJob(id);
    if (!job || gone.has(id)) return;
    const shell = job.target === "shell";
    if (job.state === "starting") {
      await (shell ? startShellCommand(job) : startCommand(job));
      await saveJob(job);
    }
    if (job.state === "running") await (shell ? pollShellCommand(job) : pollCommand(job));
    checkAlive(job);
    if (job.state === "done" && job.rewriteAttempts < MAX_REWRITE_ATTEMPTS) await rewriteMessage(job);
  }

  function ensureWork(id: string): void {
    if (inFlight.has(id) || disposed) return;
    const run = work(id)
      .catch((error) => bb.log.warn(`command job stopped (${errorKind(error)})`))
      .finally(() => {
        inFlight.delete(id);
        if (!disposed) void bb.experimental_hooks.recheck("message.dispatch").catch(() => {});
      });
    inFlight.set(id, run);
  }

  /**
   * Binds a pending authorization to the row core just queued and starts it.
   * A bound row being re-queued is the safe moment to retry its rewrite: no
   * dispatch pass holds it then.
   */
  async function onQueued(entry: ThreadQueuedMessage): Promise<void> {
    if (claiming.has(entry.id)) return;
    claiming.add(entry.id);
    try {
      const boundId = await kv.get<string>(rowKey(entry.id));
      if (boundId) {
        const job = await loadJob(boundId);
        if (job?.state === "done" && job.rewriteAttempts < MAX_REWRITE_ATTEMPTS) ensureWork(job.id);
        return;
      }
      if (!config.enabled || entry.waitingOn?.kind !== "plugin") return;
      if (entry.initiator !== "user" || entry.senderThreadId !== null || entry.originPluginId !== null) return;
      const key = authKey(entry.threadId, messageText(entry.content));
      const auth = await loadAuth(key);
      if (!auth) return;
      if (entry.createdAt < auth.createdAt - ROW_CLOCK_SKEW_MS || entry.createdAt > auth.createdAt + ROW_BIND_WINDOW_MS) return;
      const job: JobRecord = { ...auth, state: "starting", rowId: entry.id, terminalId: null, message: null, rewriteAttempts: 0 };
      startable.add(job.id);
      await kv.set(jobKey(job.id), job);
      await kv.set(rowKey(entry.id), job.id);
      await kv.delete(key);
      bb.log.info(`running a ${job.command.length}-character command in ${job.threadId}`);
      ensureWork(job.id);
    } finally {
      claiming.delete(entry.id);
    }
  }

  /** The held row left the queue: cancelled, sent by hand, or sent after its rewrite. */
  async function onRowGone(entry: ThreadQueuedMessage): Promise<void> {
    const id = await kv.get<string>(rowKey(entry.id));
    if (!id) return;
    gone.add(id);
    await kv.delete(jobKey(id));
    await kv.delete(rowKey(entry.id));
  }

  bb.events.on("message.queued", ({ entry }) => void onQueued(entry).catch(() => {}));
  bb.events.on("message.cancelled", ({ entry }) => void onRowGone(entry).catch(() => {}));
  bb.events.on("message.dispatched", ({ entry }) => void onRowGone(entry).catch(() => {}));

  function holdWait(reason: string, delayMs: number | null): MessageDispatchHookDecision {
    return { action: "wait", reason: reason.slice(0, 200), sendAt: delayMs === null ? null : Date.now() + delayMs };
  }

  /** Decision for a row bound to a job. */
  function decideBound(job: JobRecord): MessageDispatchHookDecision {
    if (job.state === "rewritten") return PROCEED;
    if (job.state === "done" && job.rewriteAttempts >= MAX_REWRITE_ATTEMPTS) {
      return holdWait("Bang Shell could not attach the output. Cancel this message; the command already ran.", null);
    }
    // Polling may resume here; rewrites start from `onQueued`, outside the dispatch pass.
    if (job.state !== "done") ensureWork(job.id);
    const delay = job.state === "done" ? REASK_MS * 2 ** job.rewriteAttempts : REASK_MS;
    return holdWait(`Running: ${job.command}`, delay);
  }

  bb.experimental_hooks.on("message.dispatch", async (ctx: MessageDispatchHookContext) => {
    // Rows bound to a job are decided by their jobs, even if the plugin was turned off since.
    // In a group, any bound row still waiting for its output holds the whole group.
    let bound = 0;
    for (const row of ctx.queuedMessages) {
      const id = await kv.get<string>(rowKey(row.id));
      const job = id ? await loadJob(id) : undefined;
      if (!job) continue;
      bound += 1;
      if (job.state !== "rewritten") return decideBound(job);
    }
    if (bound > 0) return PROCEED;
    if (!config.enabled) return PROCEED;

    const text = ctx.input.text;
    const key = authKey(ctx.thread.id, text);
    // Any plugin-held row: when several plugins wait, the first one owns the wait.
    const heldByUs = ctx.queuedMessages.some((m) => m.waitingOn?.kind === "plugin");
    if (heldByUs) {
      // Authorized, but `message.queued` has not bound it yet (or is binding it now).
      const pending = await loadAuth(key);
      if (pending) return holdWait(`Running: ${pending.command}`, REASK_MS);
      // Binding writes the row link before deleting the authorization, so look again.
      for (const row of ctx.queuedMessages) {
        const id = await kv.get<string>(rowKey(row.id));
        const job = id ? await loadJob(id) : undefined;
        if (job) return decideBound(job);
      }
      // Nothing pending: sending the text as-is never executes anything.
      return PROCEED;
    }

    const target = submissionTarget(ctx.experimental_submission, bb.pluginId);
    const own = target !== null;
    if (!own && ctx.queuedMessages.length === 0 && (await kv.get(key))) {
      // Same text sent without the action (plain Enter, an agent): a leftover
      // authorization must not bind to its row.
      await kv.delete(key);
    }
    const human = ctx.initiator === "user" && ctx.senderThreadId === null && ctx.originPluginId === null;
    if (!human) return PROCEED;
    const prefixed = parseBangCommand(text, config.prefix);
    let command: string;
    if (own) {
      command = prefixed ?? text.trim();
    } else if (prefixed !== null) {
      if (config.requireRunAction) {
        return {
          action: "reject",
          message: `To run "${config.prefix}…" as a command, send it with Mod+Alt+Enter or Send menu → Run in terminal.`,
        };
      }
      command = prefixed;
    } else {
      return PROCEED;
    }

    command = normalizeCommand(command);
    if (command === "") return { action: "reject", message: `Nothing to run. Example: ${config.prefix}ls -la` };
    if (command.length > MAX_COMMAND_CHARS) {
      return {
        action: "reject",
        message: `Command too long (${command.length} characters, at most ${MAX_COMMAND_CHARS}). Put it in a script file.`,
      };
    }
    if (!ctx.environment) {
      return { action: "reject", message: "This thread has no environment yet; start it with a normal message first." };
    }
    if (await loadAuth(key)) {
      return { action: "reject", message: "The same command was just sent in this thread; wait a moment." };
    }
    if (target === "shell" && (await shellBusy(ctx.thread.id))) {
      return {
        action: "reject",
        message: "The thread shell is still running a command; finish it or press Ctrl-C in the Terminal panel.",
      };
    }

    const auth: Authorization = {
      id: randomUUID(),
      threadId: ctx.thread.id,
      textKey: key,
      command,
      terminalTitle: target === "shell" ? THREAD_SHELL_TITLE : command.replace(/\s+/g, " ").slice(0, config.titleMaxChars),
      createdAt: Date.now(),
      target: target ?? "terminal",
    };
    await kv.set(key, auth);
    // Nothing runs yet: the command starts when core queues the held row
    // (`message.queued`), i.e. after every plugin's hook has decided.
    return holdWait(`Running: ${command}`, REASK_MS);
  });

  // Drop expired records, then ask core to re-decide rows held across a reload.
  void (async () => {
    for (const key of await kv.list(AUTH_PREFIX)) await loadAuth(key);
    for (const key of await kv.list(JOB_PREFIX)) await loadJob(key.slice(JOB_PREFIX.length));
    for (const key of await kv.list(ROW_PREFIX)) {
      const id = await kv.get<string>(key);
      if (!id || !(await kv.get(jobKey(id)))) await kv.delete(key);
    }
    await sleep(1000);
    if (!disposed) await bb.experimental_hooks.recheck("message.dispatch");
  })().catch((error) => bb.log.warn(`startup maintenance failed (${errorKind(error)})`));
}
