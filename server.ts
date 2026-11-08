// bb-plugin-bang-shell: a message that starts with the configured prefix
// (default `!`) runs the rest as a shell command in a terminal of the thread's
// own environment (on whichever host the session runs), instead of being sent
// to the agent.
import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";

// CSI/OSC escape sequences and stray control characters from the PTY stream.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Returns the command after `prefix`, "" for a bare prefix, or null when absent. */
export function parseBangCommand(text: string, prefix = "!"): string | null {
  const trimmed = text.trimStart();
  if (prefix === "" || !trimmed.startsWith(prefix)) return null;
  return trimmed.slice(prefix.length).trim();
}

export function cleanTerminalOutput(raw: string): string {
  return raw
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trimEnd();
}

/** Coerces a stored setting to a whole number no smaller than `min`, else `fallback`. */
export function wholeNumber(value: unknown, fallback: number, min: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function rowText(content: readonly { type: string; text?: string }[]): string {
  return content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

function fenced(info: string, text: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/**
 * The message the agent receives: a command block, then an output block.
 * A zero exit code is implied; any other status is the output's last line.
 */
export function formatShellMessage(
  command: string,
  output: string,
  status: "exited" | "running",
  exitCode: number | null,
  terminalTitle: string,
): string {
  const notes: string[] = [];
  if (status === "running") notes.push(`[still running in terminal tab "${terminalTitle}"; output so far]`);
  else if (exitCode !== 0) notes.push(`[exit ${exitCode ?? "?"}]`);
  const shown = [output, ...notes].filter(Boolean).join("\n");
  const blocks = [fenced("sh", command)];
  if (shown) blocks.push(fenced("", shown));
  return blocks.join("\n\n");
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…\n${text.slice(-maxChars)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULTS = {
  prefix: "!",
  waitSeconds: 30,
  outputTailChars: 3000,
  pollIntervalMs: 200,
  terminalCols: 120,
  terminalRows: 32,
  titleMaxChars: 60,
} as const;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Run prefixed messages as commands",
      description: "When off, prefixed messages go to the agent as usual.",
      default: true,
    },
    prefix: {
      type: "string",
      label: "Command prefix",
      description: "A message starting with this text runs the rest as a shell command.",
      default: DEFAULTS.prefix,
    },
    waitSeconds: {
      type: "number",
      label: "Seconds to wait for output",
      description:
        "How long to wait for a command to finish before its output is added to the message and sent. 0 = do not wait. Longer commands keep running in the thread's terminal.",
      default: DEFAULTS.waitSeconds,
    },
    outputTailChars: {
      type: "number",
      label: "Output characters shown",
      description: "Only the last N characters of the output are shown.",
      default: DEFAULTS.outputTailChars,
    },
    pollIntervalMs: {
      type: "number",
      label: "Output poll interval (ms)",
      description: "How often the terminal is checked while waiting for the command.",
      default: DEFAULTS.pollIntervalMs,
    },
    terminalCols: {
      type: "number",
      label: "Terminal columns",
      default: DEFAULTS.terminalCols,
    },
    terminalRows: {
      type: "number",
      label: "Terminal rows",
      default: DEFAULTS.terminalRows,
    },
    titleMaxChars: {
      type: "number",
      label: "Terminal title length",
      description: "Terminal tabs are titled with the command, cut to this many characters.",
      default: DEFAULTS.titleMaxChars,
    },
  });
  const raw = await settings.get();
  const config = {
    enabled: raw.enabled,
    prefix: raw.prefix.trim() || DEFAULTS.prefix,
    waitMs: wholeNumber(raw.waitSeconds, DEFAULTS.waitSeconds, 0) * 1000,
    outputTailChars: wholeNumber(raw.outputTailChars, DEFAULTS.outputTailChars, 1),
    pollIntervalMs: wholeNumber(raw.pollIntervalMs, DEFAULTS.pollIntervalMs, 10),
    terminalCols: wholeNumber(raw.terminalCols, DEFAULTS.terminalCols, 20),
    terminalRows: wholeNumber(raw.terminalRows, DEFAULTS.terminalRows, 5),
    titleMaxChars: wholeNumber(raw.titleMaxChars, DEFAULTS.titleMaxChars, 1),
  };

  type RunResult = { output: string; status: "exited" | "running"; exitCode: number | null; terminalTitle: string };

  async function runCommand(threadId: string, command: string): Promise<RunResult> {
    const terminal = await bb.sdk.terminals.create({
      scope: { kind: "thread", threadId },
      cols: config.terminalCols,
      rows: config.terminalRows,
      title: `${config.prefix} ${command}`.slice(0, config.titleMaxChars),
      start: { mode: "command", command },
    });

    const decoder = new TextDecoder();
    let collected = "";
    let sinceSeq: number | undefined;
    const deadline = Date.now() + config.waitMs;
    for (;;) {
      const out = await bb.sdk.terminals.output({ terminalId: terminal.id, sinceSeq });
      for (const chunk of out.chunks) {
        collected += decoder.decode(Buffer.from(chunk.dataBase64, "base64"), { stream: true });
      }
      sinceSeq = out.nextSeq;
      const output = tail(cleanTerminalOutput(collected), config.outputTailChars);
      if (out.status === "exited" || out.status === "disconnected") {
        // Output captured: drop the session instead of piling up terminal tabs.
        await bb.sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => {});
        return { output, status: "exited", exitCode: out.exitCode, terminalTitle: terminal.title };
      }
      if (Date.now() >= deadline) {
        return { output, status: "running", exitCode: null, terminalTitle: terminal.title };
      }
      await sleep(config.pollIntervalMs);
    }
  }

  /** Queued rows this plugin already rewrote; they always proceed. */
  const rewrittenRows = new Set<string>();
  /** Commands being run, keyed by thread and original message text. */
  const inFlight = new Map<string, Promise<void>>();
  const forgetRow = ({ entry }: { entry: { id: string } }) => void rewrittenRows.delete(entry.id);
  bb.events.on("message.dispatched", forgetRow);
  bb.events.on("message.cancelled", forgetRow);

  async function findWaitingRow(threadId: string, originalText: string) {
    // The row is created after the hook answers `wait`, so it may lag the job.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
      const row = rows.find(
        (r) =>
          r.waitingOn?.kind === "plugin" &&
          r.waitingOn.pluginId === bb.pluginId &&
          !rewrittenRows.has(r.id) &&
          rowText(r.content).trim() === originalText.trim(),
      );
      if (row) return row;
      await sleep(200);
    }
    return null;
  }

  async function runAndRewrite(threadId: string, originalText: string, command: string): Promise<void> {
    let message: string;
    try {
      const result = await runCommand(threadId, command);
      message = formatShellMessage(command, result.output, result.status, result.exitCode, result.terminalTitle);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      bb.log.warn(`bang command failed to start in ${threadId}: ${reason}`);
      message = formatShellMessage(command, `failed to start: ${reason}`, "exited", null, "");
    }

    const row = await findWaitingRow(threadId, originalText);
    if (!row) {
      bb.log.warn(`bang command in ${threadId}: queued message not found (cancelled?)`);
      return;
    }
    let replaced = false;
    const input = row.content.map((block) => {
      if (block.type !== "text" || replaced) return block;
      replaced = true;
      return { ...block, text: message, mentions: [] };
    });
    if (!replaced) input.unshift({ type: "text", text: message, mentions: [] });
    rewrittenRows.add(row.id);
    await bb.sdk.threads.queuedMessages.update({
      threadId,
      queuedMessageId: row.id,
      expectedUpdatedAt: row.updatedAt,
      input,
    });
  }

  bb.experimental_hooks.on("message.dispatch", async (ctx: MessageDispatchHookContext) => {
    if (!config.enabled) return { action: "proceed" };
    if (ctx.queuedMessages.some((m) => rewrittenRows.has(m.id))) return { action: "proceed" };
    // Only a human-typed message runs a command; agents and system retries never do.
    if (ctx.initiator !== "user" || ctx.senderThreadId !== null) return { action: "proceed" };

    const text = ctx.input.text;
    const command = parseBangCommand(text, config.prefix);
    if (command === null) return { action: "proceed" };
    if (command === "") {
      return { action: "reject", message: `Usage: ${config.prefix}<command>, e.g. ${config.prefix}ls -la` };
    }

    const threadId = ctx.thread.id;
    const key = `${threadId}\u0000${text.trim()}`;
    if (!inFlight.has(key)) {
      bb.log.info(`running bang command in ${threadId}: ${command}`);
      const job = runAndRewrite(threadId, text, command)
        .catch((error) => bb.log.error(`bang command in ${threadId}: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          inFlight.delete(key);
          // Ask core to re-decide the row: rewritten it proceeds, otherwise a new run starts.
          void bb.experimental_hooks.recheck("message.dispatch").catch(() => {});
        });
      inFlight.set(key, job);
    }
    return { action: "wait", reason: `Running: ${command}`.slice(0, 200) };
  });
}
