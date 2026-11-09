// bb-plugin-bang-shell: runs a message as a shell command in a terminal of the
// thread's environment, then sends the command and its output to the agent.
// Trust model, lifecycle and at-most-once execution: README.md, "Security".
import { createHash, randomUUID } from "node:crypto";
import type {
  BbPluginApi,
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import { normalizeCommand } from "./command-text.ts";

type ThreadQueuedMessage = MessageDispatchHookContext["queuedMessages"][number];

/** Key the composer action puts in `experimental_data`. */
export const SUBMISSION_KEY = "bangShell";
export const SUBMISSION_VERSION = 1;

export const DEFAULTS = {
  prefix: "!",
  waitSeconds: 30,
  outputTailChars: 3000,
  pollIntervalMs: 200,
  terminalCols: 120,
  terminalRows: 32,
  titleMaxChars: 60,
} as const;

export const LIMITS = {
  waitSeconds: [0, 3600],
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
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
/** An authorization no queued row picked up within this time was refused by core or another plugin. */
const AUTHORIZED_TTL_MS = 60 * 1000;
const MAX_REWRITE_ATTEMPTS = 5;
const MAX_POLL_FAILURES = 3;
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

export function isOwnSubmission(
  submission: { pluginId: string; data: unknown } | null | undefined,
  pluginId: string,
): boolean {
  if (!submission || submission.pluginId !== pluginId) return false;
  const data = submission.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  return (data as Record<string, unknown>)[SUBMISSION_KEY] === SUBMISSION_VERSION;
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
  | { kind: "unknown" };

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
}

interface JobRecord extends Authorization {
  state: JobState;
  rowId: string;
  terminalId: string | null;
  message: string | null;
  rewriteAttempts: number;
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
      description: "0–3600. After this the message is sent with the output so far; the command keeps running in the thread's terminal.",
      default: DEFAULTS.waitSeconds,
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

  async function startCommand(job: JobRecord): Promise<void> {
    if (!startable.delete(job.id)) {
      // Bound by an earlier load that stopped before recording the terminal:
      // whether it started is unknown, so it is never started again.
      job.state = "done";
      job.message = formatShellMessage(job.command, "", { kind: "unknown" });
      return;
    }
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
    const deadline = job.createdAt + config.waitMs;
    for (;;) {
      checkAlive(job);
      let outcome: Outcome | null = null;
      try {
        const out = await bb.sdk.terminals.output({ terminalId, sinceSeq });
        failures = 0;
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
      if (!outcome && Date.now() >= deadline) outcome = { kind: "running", terminalTitle: job.terminalTitle };
      if (outcome) {
        job.state = "done";
        job.message = formatShellMessage(job.command, tail(cleanTerminalOutput(buffer), config.outputTailChars), outcome);
        await saveJob(job);
        if (outcome.kind === "exited") {
          await bb.sdk.terminals.close({ terminalId, mode: "force" }).catch(() => {});
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
    if (job.state === "starting") {
      await startCommand(job);
      await saveJob(job);
    }
    if (job.state === "running") await pollCommand(job);
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

    const own = isOwnSubmission(ctx.experimental_submission, bb.pluginId);
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

    const auth: Authorization = {
      id: randomUUID(),
      threadId: ctx.thread.id,
      textKey: key,
      command,
      terminalTitle: command.replace(/\s+/g, " ").slice(0, config.titleMaxChars),
      createdAt: Date.now(),
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
