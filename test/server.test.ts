import assert from "node:assert/strict";
import { test } from "node:test";
import plugin, {
  appendBounded,
  authKey,
  cleanTerminalOutput,
  formatShellMessage,
  isOwnSubmission,
  MAX_COMMAND_CHARS,
  NO_PAGER_PREFIX,
  messageText,
  normalizePrefix,
  parseBangCommand,
  replaceText,
  wholeNumber,
} from "../server.ts";

// ---------------------------------------------------------------- pure helpers

test("parseBangCommand matches the prefix only at the first character", () => {
  assert.equal(parseBangCommand("!ls -la", "!"), "ls -la");
  assert.equal(parseBangCommand("! pwd ", "!"), "pwd");
  assert.equal(parseBangCommand("!", "!"), "");
  assert.equal(parseBangCommand(" !ls", "!"), null);
  assert.equal(parseBangCommand("hi !x", "!"), null);
  assert.equal(parseBangCommand("$$ pwd", "$$"), "pwd");
  assert.equal(parseBangCommand("!a\nb", "!"), "a\nb");
});

test("normalizePrefix rejects prefixes that collide or are unsafe", () => {
  assert.equal(normalizePrefix("!"), "!");
  assert.equal(normalizePrefix(">>"), ">>");
  for (const bad of ["", " ", "! ", "`", "/", "$", "@", "#", "/x", "toolong", 5, null]) {
    assert.equal(normalizePrefix(bad), null, String(bad));
  }
});

test("wholeNumber clamps and falls back", () => {
  assert.equal(wholeNumber("abc", 8, 0, 10), 8);
  assert.equal(wholeNumber(-3, 8, 0, 10), 0);
  assert.equal(wholeNumber(99, 8, 0, 10), 10);
  assert.equal(wholeNumber(4.9, 8, 0, 10), 4);
});

test("appendBounded keeps only the tail", () => {
  assert.equal(appendBounded("abc", "def", 4), "cdef");
  assert.equal(appendBounded("", "ab", 4), "ab");
});

test("cleanTerminalOutput strips escapes and control characters", () => {
  assert.equal(cleanTerminalOutput("\u001b[32mok\u001b[0m\r\nline2\r\n\u001b]0;t\u0007"), "ok\nline2");
  // `less` keypad mode switches and charset selection, as seen from `git log` in a PTY.
  assert.equal(cleanTerminalOutput("\u001b=a5017cf Add\r\n\u001b(B\u001b[m\u001b>add.ts"), "a5017cf Add\nadd.ts");
});

test("isOwnSubmission requires this plugin and the exact marker", () => {
  assert.equal(isOwnSubmission({ pluginId: "bang-shell", data: { bangShell: 1 } }, "bang-shell"), true);
  assert.equal(isOwnSubmission({ pluginId: "other", data: { bangShell: 1 } }, "bang-shell"), false);
  assert.equal(isOwnSubmission({ pluginId: "bang-shell", data: { bangShell: true } }, "bang-shell"), false);
  assert.equal(isOwnSubmission({ pluginId: "bang-shell", data: [1] }, "bang-shell"), false);
  assert.equal(isOwnSubmission(null, "bang-shell"), false);
});

test("formatShellMessage emits a command block and a labelled output block", () => {
  assert.equal(formatShellMessage("ls", "a\nb", { kind: "exited", exitCode: 0 }), "```sh\nls\n```\n\n```output\na\nb\n```");
  assert.equal(formatShellMessage("true", "", { kind: "exited", exitCode: 0 }), "```sh\ntrue\n```");
  assert.match(formatShellMessage("false", "", { kind: "exited", exitCode: 1 }), /```output\n\[exit 1\]\n```$/);
  assert.match(formatShellMessage("echo", "x ``` y", { kind: "exited", exitCode: 0 }), /````output\nx ``` y\n````$/);
  assert.match(formatShellMessage("a```b", "", { kind: "exited", exitCode: 0 }), /^````sh\na```b\n````$/);
});

test("replaceText keeps attachments and drops the other text blocks", () => {
  const content = [
    { type: "text", text: "!ls ", mentions: [] },
    { type: "image", url: "x" },
    { type: "text", text: "rest", mentions: [] },
  ];
  assert.deepEqual(replaceText(content, "M"), [
    { type: "text", text: "M", mentions: [] },
    { type: "image", url: "x" },
  ]);
});

test("messageText joins text blocks like core; authKey ignores outer whitespace", () => {
  assert.equal(messageText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(authKey("t", " !ls "), authKey("t", "!ls"));
  assert.notEqual(authKey("t", "!ls"), authKey("u", "!ls"));
});

// ------------------------------------------------- fake interactive terminal

const notFound = () => Object.assign(new Error("HTTP 404: Terminal session not found"), { code: "terminal_not_found" });

const MARK_S = (n: string) => `\u001b]7777;${n};S\u0007`;
const MARK_E = (n: string, status: number) => `\u001b]7777;${n};E;${status}\u0007`;
const PROMPT = "                    \r\r\u001b[0m~/proj % ";

/** `noStart`: the shell never runs it (parse error), the prompt just returns. `silent`: no marks at all (a continuation prompt). */
type Program = { output: string; exit: number; hold: boolean; noStart?: boolean; silent?: boolean };
type FakeShell = {
  id: string;
  title: string;
  nonce: string | null;
  /** `fish` never prints a mark. */
  kind: "zsh" | "fish";
  status: "running" | "exited";
  /** A command (or a program waiting for input) is running: S seen, E not yet. */
  busy: boolean;
  chunks: { seq: number; data: string }[];
  /** Pasted command blocks, in order. */
  commands: string[];
  setups: string[];
  /** Input that was not a setup line or a paste, or arrived while busy. */
  stray: string[];
  inputCalls: number;
  inputFails: number;
  split: boolean;
  next: Program | null;
  /** How long the shell takes to report ready after the setup line. */
  setupDelayMs: number;
  /** How long the shell takes to start the pasted command. */
  startDelayMs: number;
  /** The host no longer knows this terminal: `output` and `get` throw not-found. */
  missing: boolean;
};

function fakeShells() {
  const map = new Map<string, FakeShell>();
  const emit = (sh: FakeShell, text: string) => {
    const parts = sh.split ? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))] : [text];
    for (const data of parts) if (data) sh.chunks.push({ seq: sh.chunks.length, data });
  };
  const api = {
    map,
    create(id: string, title: string, kind: FakeShell["kind"], next: Program | null, setupDelayMs = 0) {
      const sh: FakeShell = {
        id, title, nonce: null, kind, status: "running", busy: false, chunks: [], commands: [], setups: [], stray: [],
        inputCalls: 0, inputFails: 0, split: false, next, setupDelayMs, startDelayMs: 0, missing: false,
      };
      map.set(id, sh);
      emit(sh, "~/proj % ");
      return sh;
    },
    output(id: string, sinceSeq = 0, tailBytes?: number) {
      const sh = map.get(id)!;
      let chunks = sh.chunks.filter((c) => c.seq >= sinceSeq);
      if (tailBytes !== undefined) {
        // The newest chunks that fit, at least one, like a bounded scrollback read.
        let size = 0;
        const keep = chunks.filter((_, i) => {
          size += chunks[chunks.length - 1 - i].data.length;
          return size <= tailBytes || i === 0;
        });
        chunks = keep.length ? chunks.slice(chunks.length - keep.length) : chunks;
      }
      return {
        chunks: chunks.map((c) => ({ seq: c.seq, dataBase64: Buffer.from(c.data).toString("base64") })),
        nextSeq: sh.chunks.length,
        status: sh.status,
        exitCode: null,
      };
    },
    input(id: string, dataBase64: string) {
      const sh = map.get(id)!;
      sh.inputCalls += 1;
      if (sh.inputFails > 0) {
        sh.inputFails -= 1;
        throw new Error("input failed");
      }
      const text = Buffer.from(dataBase64, "base64").toString();
      if (sh.busy) return void sh.stray.push(text);
      const setup = /__bs_n=(\w+);/.exec(text);
      if (setup) {
        sh.setups.push(text);
        if (sh.kind === "zsh") {
          const nonce = setup[1];
          sh.nonce = nonce;
          const ready = () => emit(sh, MARK_E(nonce, 0) + PROMPT);
          if (sh.setupDelayMs > 0) setTimeout(ready, sh.setupDelayMs);
          else ready();
        }
        return;
      }
      const paste = /^\u001b\[200~([\s\S]*)\u001b\[201~\r$/.exec(text);
      if (!paste) return void sh.stray.push(text);
      sh.commands.push(paste[1]);
      const program = sh.next ?? { output: "out\r\n", exit: 0, hold: false };
      sh.next = null;
      const run = () => {
        if (program.noStart) return void emit(sh, `\r\n${program.output}${MARK_E(sh.nonce!, program.exit)}${PROMPT}`);
        emit(sh, `\r\n${program.silent ? "" : MARK_S(sh.nonce!)}${program.output}`);
        if (program.hold) sh.busy = true;
        else emit(sh, MARK_E(sh.nonce!, program.exit) + PROMPT);
      };
      // The start mark appears only once the shell has read the paste.
      if (sh.startDelayMs > 0) {
        sh.busy = true;
        setTimeout(() => {
          sh.busy = false;
          run();
        }, sh.startDelayMs);
      } else run();
    },
    emit,
    /** The running program ends by itself. */
    finish(sh: FakeShell, exit = 0, output = "") {
      sh.busy = false;
      emit(sh, output + MARK_E(sh.nonce!, exit) + PROMPT);
    },
    ctrlC(sh: FakeShell) {
      emit(sh, "^C\r\n");
      api.finish(sh, 130);
    },
    /** The user types a command in the panel: it starts and, if `hold`, keeps running. */
    userRun(sh: FakeShell, hold: boolean) {
      emit(sh, `\r\n${MARK_S(sh.nonce!)}`);
      sh.busy = hold;
      if (!hold) emit(sh, MARK_E(sh.nonce!, 0) + PROMPT);
    },
  };
  return api;
}

// ------------------------------------------------------------ fake bb core

type Decision = { action: string; message?: string; reason?: string; sendAt?: number | null };
type Row = {
  id: string;
  threadId: string;
  content: { type: string; text?: string; mentions?: unknown[] }[];
  updatedAt: number;
  initiator: string;
  senderThreadId: string | null;
  originPluginId: string | null;
  waitingOn: { kind: string; pluginId?: string } | null;
  createdAt: number;
  claimed?: boolean;
};
type Ctx = Record<string, unknown> & { input: { text: string; blocks: unknown[] } };

const PLUGIN = "bang-shell";
const OWN = { experimental_submission: { pluginId: PLUGIN, data: { bangShell: 1 } } };

/**
 * A fake bb core: rows, kv, terminals and events behave like the real server
 * for the paths this plugin uses. Held rows are re-asked only when the plugin
 * schedules it (`sendAt`) or calls `recheck`, as in core.
 */
function core(settings: Record<string, unknown> = {}, kvDelayMs = 0) {
  const kvStore = new Map<string, unknown>();
  /** Reads of keys with these prefixes return the value as of the call, after a delay (once each). */
  const staleReads = new Map<string, number>();
  const created: string[] = [];
  const commandChunks = new Map<string, string[]>();
  const closed: string[] = [];
  const rows: Row[] = [];
  const sent: string[] = [];
  const reveals: { channel: string; payload: unknown }[] = [];
  const listeners = new Map<string, (p: { entry: Row }) => void>();
  let disposers: (() => void)[] = [];
  let hook: ((ctx: unknown) => Promise<Decision>) | null = null;
  let lastDecision = new Map<string, Decision>();
  const fake = fakeShells();
  const state = {
    shellKind: "zsh" as FakeShell["kind"],
    /** What the first command written to a new thread shell does (default: prints `out`, exits 0). */
    firstProgram: null as Program | null,
    /** The next N `terminals.output` calls on a thread shell throw. */
    failOutputs: 0,
    /** Arguments of every successful `terminals.output` on a thread shell. */
    shellReads: [] as { sinceSeq?: number; tailBytes?: number }[],
    setupDelayMs: 0,
    /** Called at the start of every `terminals.input`, before the terminal sees the bytes. */
    onInput: null as (() => void) | null,
    terminalStatus: "exited" as "exited" | "running" | "throw",
    failUpdates: 0,
    rechecks: 0,
    outputCalls: 0,
    output: null as string | null,
  };

  const bb = {
    pluginId: PLUGIN,
    realtime: { publish: (channel: string, payload: unknown) => reveals.push({ channel, payload }) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    settings: {
      define(descriptors: Record<string, { default?: unknown }>) {
        return {
          get: async () =>
            Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, k in settings ? settings[k] : d.default])),
        };
      },
    },
    onDispose: (fn: () => void) => disposers.push(fn),
    storage: {
      kv: {
        get: async (k: string) => {
          for (const [prefix, ms] of staleReads) {
            if (!k.startsWith(prefix)) continue;
            staleReads.delete(prefix);
            const snapshot = structuredClone(kvStore.get(k));
            await pause(ms);
            return snapshot;
          }
          if (kvDelayMs) await pause(Math.random() * kvDelayMs);
          return structuredClone(kvStore.get(k));
        },
        set: async (k: string, v: unknown) => {
          if (kvDelayMs) await pause(Math.random() * kvDelayMs);
          kvStore.set(k, structuredClone(v));
        },
        delete: async (k: string) => void kvStore.delete(k),
        list: async (p = "") => [...kvStore.keys()].filter((k) => k.startsWith(p)),
      },
    },
    events: { on: (name: string, fn: (p: { entry: Row }) => void) => void listeners.set(name, fn) },
    experimental_hooks: {
      on: (_: string, fn: (ctx: unknown) => Promise<Decision>) => void (hook = fn),
      recheck: async () => {
        state.rechecks += 1;
      },
    },
    sdk: {
      terminals: {
        create: async (args: { start: { mode?: string; command: string }; title: string; id?: string }) => {
          if (args.start.mode === "shell") {
            fake.create(args.id!, args.title, state.shellKind, state.firstProgram, state.setupDelayMs);
            return { id: args.id!, title: args.title };
          }
          created.push(args.start.command.startsWith(NO_PAGER_PREFIX) ? args.start.command.slice(NO_PAGER_PREFIX.length) : `RAW:${args.start.command}`);
          return { id: `term-${created.length}`, title: args.title };
        },
        get: async ({ terminalId }: { terminalId: string }) => {
          if (fake.map.get(terminalId)!.missing) throw notFound();
          return { status: fake.map.get(terminalId)!.status };
        },
        input: async ({ terminalId, dataBase64 }: { terminalId: string; dataBase64: string }) => {
          state.onInput?.();
          return fake.input(terminalId, dataBase64);
        },
        output: async ({ terminalId, sinceSeq, tailBytes }: { terminalId: string; sinceSeq?: number; tailBytes?: number }) => {
          if (fake.map.has(terminalId)) {
            if (fake.map.get(terminalId)!.missing) throw notFound();
            if (state.failOutputs > 0) {
              state.failOutputs -= 1;
              throw new Error("transient");
            }
            state.shellReads.push({ sinceSeq, tailBytes });
            return fake.output(terminalId, sinceSeq, tailBytes);
          }
          state.outputCalls += 1;
          if (state.terminalStatus === "throw") throw new Error("gone");
          const chunks = commandChunks.get(terminalId) ?? [];
          const output = state.output ?? (commandChunks.has(terminalId) ? "" : "out\r\n");
          if (output) chunks.push(output);
          commandChunks.set(terminalId, chunks);
          state.output = null;
          return {
            chunks: chunks.slice(sinceSeq ?? 0).map((data, i) => ({ dataBase64: Buffer.from(data).toString("base64"), seq: (sinceSeq ?? 0) + i })),
            nextSeq: chunks.length,
            status: state.terminalStatus,
            exitCode: state.terminalStatus === "exited" ? 0 : null,
          };
        },
        close: async ({ terminalId }: { terminalId: string }) => void closed.push(terminalId),
      },
      threads: {
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => structuredClone(rows.filter((r) => r.threadId === threadId)),
          update: async (args: { queuedMessageId: string; input: Row["content"]; expectedUpdatedAt: number }) => {
            if (state.failUpdates > 0) {
              state.failUpdates -= 1;
              throw new Error("conflict");
            }
            const row = rows.find((r) => r.id === args.queuedMessageId);
            if (!row || row.claimed || row.updatedAt !== args.expectedUpdatedAt) throw new Error("stale or claimed");
            row.content = args.input;
            row.updatedAt += 1;
          },
        },
      },
    },
  };

  function ctx(text: string, extra: Record<string, unknown> = {}): Ctx {
    return {
      thread: { id: "thr_1" },
      environment: { id: "env_1" },
      input: { text, blocks: [] },
      initiator: "user",
      senderThreadId: null,
      originPluginId: null,
      queuedMessages: [],
      experimental_submission: null,
      ...extra,
    };
  }

  function emit(name: string, row: Row) {
    listeners.get(name)?.({ entry: structuredClone(row) });
  }

  function dispatchRow(row: Row) {
    rows.splice(rows.indexOf(row), 1);
    sent.push(messageText(row.content));
    emit("message.dispatched", row);
  }

  const api = {
    fake,
    /** The thread shell terminals, in creation order. */
    get shells() {
      return [...fake.map.values()];
    },
    kvStore,
    staleReads,
    created,
    closed,
    rows,
    sent,
    reveals,
    state,
    async load() {
      await plugin(bb as never);
    },
    reload() {
      disposers.forEach((d) => d());
      disposers = [];
    },
    /** A fresh send. On `wait`, core queues the row (owned by `owner`) and announces it. */
    async send(text: string, extra: Record<string, unknown> = {}, owner = PLUGIN): Promise<{ decision: Decision; row?: Row }> {
      const c = ctx(text, extra);
      const decision = await hook!(c);
      if (decision.action === "proceed") sent.push(text);
      if (decision.action !== "wait") return { decision };
      const row: Row = {
        id: `q${rows.length + sent.length + 1}`,
        threadId: "thr_1",
        content: [{ type: "text", text, mentions: [] }],
        updatedAt: 1,
        initiator: String(c.initiator),
        senderThreadId: c.senderThreadId as string | null,
        originPluginId: c.originPluginId as string | null,
        waitingOn: { kind: "plugin", pluginId: owner },
        createdAt: Date.now(),
      };
      rows.push(row);
      lastDecision.set(row.id, decision);
      emit("message.queued", row);
      return { decision, row };
    },
    /** Core queues a row on its own (another plugin's wait, a drained schedule) and announces it. */
    queueRow(text: string, extra: Partial<Row> = {}): Row {
      const row: Row = {
        id: `q${rows.length + sent.length + 100}`,
        threadId: "thr_1",
        content: [{ type: "text", text, mentions: [] }],
        updatedAt: 1,
        initiator: "user",
        senderThreadId: null,
        originPluginId: null,
        waitingOn: { kind: "plugin", pluginId: "other-plugin" },
        createdAt: Date.now(),
        ...extra,
      };
      rows.push(row);
      emit("message.queued", row);
      return row;
    },
    emit,
    /** Only the hook decision: core never queues the row (a later plugin refused it). */
    async ask(text: string, extra: Record<string, unknown> = {}): Promise<Decision> {
      return hook!(ctx(text, extra));
    },
    /** Core re-asks a held row; on `proceed` it is sent. */
    async reask(row: Row, group: Row[] = [row]): Promise<Decision> {
      group.forEach((r) => (r.claimed = true));
      const decision = await hook!(ctx(group.map((r) => messageText(r.content)).join("\n"), {
        queuedMessages: structuredClone(group),
      }));
      // Core keeps the row claimed for a moment after the pass, then re-queues it.
      await pause(5);
      group.forEach((r) => (r.claimed = false));
      lastDecision.set(row.id, decision);
      if (decision.action === "proceed") group.forEach(dispatchRow);
      else if (decision.action === "wait") emit("message.queued", row);
      return decision;
    },
    /** Re-ask held rows the way core would (scheduled `sendAt` or a recheck) until `done`. */
    async drive(row: Row, done: () => boolean, ms = 4000) {
      const end = Date.now() + ms;
      let seenRechecks = state.rechecks;
      while (!done()) {
        if (Date.now() > end) throw new Error("timed out");
        await settle();
        const last = lastDecision.get(row.id);
        const due = last?.sendAt != null && last.sendAt <= Date.now() + 2000;
        if (rows.includes(row) && (state.rechecks > seenRechecks || due)) {
          seenRechecks = state.rechecks;
          await api.reask(row);
        }
      }
    },
    cancel(row: Row) {
      rows.splice(rows.indexOf(row), 1);
      emit("message.cancelled", row);
    },
    sendNow(row: Row) {
      dispatchRow(row);
    },
  };
  return api;
}

const settle = () => new Promise((r) => setTimeout(r, 25));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- trust model

test("gated mode: plain Enter on a prefixed message is refused and never runs", async () => {
  const c = core();
  await c.load();
  const { decision } = await c.send("!rm -rf /tmp/x");
  assert.equal(decision.action, "reject");
  assert.match(decision.message!, /Run in terminal/);
  await pause(100);
  assert.deepEqual(c.created, []);
});

test("agent, system and plugin-originated messages never run, even with the run marker", async () => {
  const c = core({ requireRunAction: false });
  await c.load();
  const attempts = [
    { initiator: "agent", senderThreadId: "thr_x" },
    { initiator: "system" },
    { senderThreadId: "mixed" },
    { originPluginId: "evil", ...OWN },
    { initiator: "agent", senderThreadId: "thr_x", ...OWN },
  ];
  for (const extra of attempts) assert.equal((await c.send("!id", extra)).decision.action, "proceed");
  await pause(100);
  assert.deepEqual(c.created, []);
});

test("another plugin's id in the submission does not authorize a run", async () => {
  const c = core();
  await c.load();
  const { decision } = await c.send("!id", { experimental_submission: { pluginId: "evil", data: { bangShell: 1 } } });
  assert.equal(decision.action, "reject");
  assert.deepEqual(c.created, []);
});

test("legacy mode runs a human-looking prefixed message", async () => {
  const c = core({ requireRunAction: false, pollIntervalMs: 50 });
  await c.load();
  const { row } = await c.send("!echo hi");
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.created, ["echo hi"]);
});

// ------------------------------------------------------------- lifecycle

test("run action: runs once, rewrites the held row, sends it, leaves no state", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const { decision, row } = await c.send("ls -la", OWN);
  assert.equal(decision.action, "wait");
  assert.ok(typeof decision.sendAt === "number", "every wait is re-asked by core");
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.sent, ["```sh\nls -la\n```\n\n```output\nout\n```"]);
  assert.deepEqual(c.created, ["ls -la"]);
  assert.deepEqual(c.closed, ["term-1"]);
  await pause(50);
  assert.equal(c.kvStore.size, 0);
});

test("nothing runs before core queues the row (a later plugin may still refuse)", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  assert.equal((await c.ask("make deploy", OWN)).action, "wait");
  await pause(200);
  assert.deepEqual(c.created, []);
});

test("a wait owned by another plugin still runs once and is rewritten", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const { row } = await c.send("whoami", OWN, "other-plugin");
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.created, ["whoami"]);
  assert.match(c.sent[0], /```output\nout\n```/);
});

test("duplicate message.queued deliveries start the command once", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const { row } = await c.send("date", OWN);
  c.emit("message.queued", row!);
  c.emit("message.queued", row!);
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.created, ["date"]);
});

test("interleaved duplicate message.queued deliveries keep one correct job", async () => {
  for (let round = 0; round < 15; round += 1) {
    const c = core({ pollIntervalMs: 50 }, 8);
    await c.load();
    const { row } = await c.send("date", OWN);
    c.emit("message.queued", row!);
    c.emit("message.queued", row!);
    await c.drive(row!, () => c.sent.length === 1);
    assert.deepEqual(c.created, ["date"]);
    assert.match(c.sent[0], /```output\nout\n```$/, `round ${round}: ${c.sent[0]}`);
  }
});

test("two commands held in one thread are each rewritten into their own row", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const a = await c.send("echo a", OWN);
  const b = await c.send("echo b", OWN);
  await Promise.all([
    c.drive(a.row!, () => !c.rows.includes(a.row!)),
    c.drive(b.row!, () => !c.rows.includes(b.row!)),
  ]);
  assert.deepEqual([...c.sent].sort(), [
    "```sh\necho a\n```\n\n```output\nout\n```",
    "```sh\necho b\n```\n\n```output\nout\n```",
  ]);
});

test("failed rewrites never re-run the command; the row stays held with an explanation", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  c.state.failUpdates = 99;
  const { row } = await c.send("date", OWN);
  let last: Decision | undefined;
  for (let i = 0; i < 80 && !(last?.action === "wait" && last.sendAt === null); i += 1) {
    await pause(50);
    last = await c.reask(row!);
  }
  assert.equal(last?.action, "wait");
  assert.equal(last?.sendAt, null);
  assert.match(last!.reason!, /could not attach/);
  assert.deepEqual(c.created, ["date"]);
  assert.deepEqual(c.sent, []);
});

test("a plugin reload mid-run resumes polling instead of re-running", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.terminalStatus = "running";
  await c.load();
  const { row } = await c.send("sleep 5", OWN);
  await pause(150);
  assert.deepEqual(c.created, ["sleep 5"]);
  c.reload();
  c.state.terminalStatus = "exited";
  await c.load();
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.created, ["sleep 5"]);
  assert.match(c.sent[0], /```output\nout\n```/);
});

test("a job bound by an earlier load but not started is reported, never re-run", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const row = {
    id: "q9", threadId: "thr_1", content: [{ type: "text", text: "make deploy", mentions: [] }], updatedAt: 1,
    initiator: "user", senderThreadId: null, originPluginId: null, waitingOn: { kind: "plugin", pluginId: PLUGIN },
    createdAt: Date.now(),
  };
  c.rows.push(row);
  c.kvStore.set("job:j1", {
    id: "j1", threadId: "thr_1", textKey: authKey("thr_1", "make deploy"), command: "make deploy", terminalTitle: "make deploy", createdAt: Date.now(),
    state: "starting", rowId: "q9", terminalId: null, message: null, rewriteAttempts: 0,
  });
  c.kvStore.set("row:q9", "j1");
  await c.reask(row);
  await c.drive(row, () => c.sent.length === 1);
  assert.match(c.sent[0], /was not re-run/);
  assert.deepEqual(c.created, []);
});

test("cancel, then resubmitting the same command runs it exactly once more", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.terminalStatus = "running";
  await c.load();
  const first = await c.send("tail -f log", OWN);
  await pause(150);
  c.cancel(first.row!);
  await pause(150);
  assert.equal(c.kvStore.size, 0);
  const polls = c.state.outputCalls;
  await pause(300);
  assert.equal(c.state.outputCalls, polls, "polling stops once the message is cancelled");
  c.state.terminalStatus = "exited";
  const second = await c.send("tail -f log", OWN);
  await c.drive(second.row!, () => c.sent.length === 1);
  await pause(200);
  assert.deepEqual(c.created, ["tail -f log", "tail -f log"]);
  assert.equal(first.row!.content[0].text, "tail -f log", "the cancelled row is never rewritten");
});

test("Send-now during a run abandons the job without leftovers", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.terminalStatus = "running";
  await c.load();
  const { row } = await c.send("top", OWN);
  await pause(150);
  c.sendNow(row!);
  c.state.terminalStatus = "exited";
  await pause(300);
  assert.equal(c.kvStore.size, 0);
  assert.deepEqual(c.sent, ["top"]);
  assert.deepEqual(c.created, ["top"]);
});

test("an unrelated row with the same text leaving the queue does not touch the job", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.terminalStatus = "running";
  await c.load();
  const { row } = await c.send("ls", OWN);
  await pause(150);
  const stranger = { ...structuredClone(row!), id: "stranger", waitingOn: null };
  c.emit("message.cancelled", stranger);
  c.emit("message.dispatched", stranger);
  c.state.terminalStatus = "exited";
  await c.drive(row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /```output/);
});

test("a duplicate submission within the authorization window is refused", async () => {
  const c = core();
  await c.load();
  assert.equal((await c.ask("top", OWN)).action, "wait");
  assert.equal((await c.ask("top", OWN)).action, "reject");
  assert.equal((await c.ask("top", { ...OWN, thread: { id: "thr_2" } })).action, "wait");
  assert.deepEqual(c.created, []);
});

// ------------------------------------------------------------- outcomes

test("waitSeconds 0 sends the output so far and keeps the command running", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 0 });
  c.state.terminalStatus = "running";
  await c.load();
  const { row } = await c.send("npm run dev", OWN);
  await c.drive(row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /still running in terminal tab "npm run dev"/);
  assert.deepEqual(c.closed, []);
});

test("repeated poll failures end as a lost terminal, not a loop", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.terminalStatus = "throw";
  await c.load();
  const { row } = await c.send("ls", OWN);
  await c.drive(row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /lost the terminal/);
  assert.ok(c.state.outputCalls <= 4);
});

test("oversized commands, empty commands and threads without an environment are refused", async () => {
  const c = core();
  await c.load();
  assert.equal((await c.send("x".repeat(MAX_COMMAND_CHARS + 1), OWN)).decision.action, "reject");
  assert.equal((await c.send("!", OWN)).decision.action, "reject");
  assert.equal((await c.send("!ls", { ...OWN, environment: null })).decision.action, "reject");
  assert.deepEqual(c.created, []);
});

test("a held row with no job proceeds as plain text and runs nothing", async () => {
  const c = core();
  await c.load();
  const row = {
    id: "q7", threadId: "thr_1", content: [{ type: "text", text: "!rm -rf ~", mentions: [] }], updatedAt: 1,
    initiator: "user", senderThreadId: null, originPluginId: null, waitingOn: { kind: "plugin", pluginId: PLUGIN },
    createdAt: Date.now(),
  };
  c.rows.push(row);
  assert.equal((await c.reask(row)).action, "proceed");
  await pause(100);
  assert.deepEqual(c.created, []);
});

// ------------------------------------------------------------- round 2

test("plain Enter after a refused action submission does not bind the leftover authorization", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  assert.equal((await c.ask("make deploy", OWN)).action, "wait"); // a later plugin refused it: no row
  assert.equal((await c.ask("make deploy")).action, "proceed"); // plain Enter, same text
  c.queueRow("make deploy"); // another plugin holds the plain message
  await pause(200);
  assert.deepEqual(c.created, []);
});

test("rows from agents, plugins or older than the authorization never bind", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  assert.equal((await c.ask("uptime", OWN)).action, "wait");
  c.queueRow("uptime", { initiator: "agent", senderThreadId: "thr_x" });
  c.queueRow("uptime", { originPluginId: "evil" });
  c.queueRow("uptime", { createdAt: Date.now() - 60_000 });
  c.queueRow("uptime", { createdAt: Date.now() + 60_000 });
  c.queueRow("uptime", { waitingOn: null });
  await pause(200);
  assert.deepEqual(c.created, []);
});

test("turning the plugin off stops pending authorizations from binding", async () => {
  const c = core({ enabled: false, pollIntervalMs: 50 });
  c.kvStore.set(authKey("thr_1", "id"), {
    id: "a1", threadId: "thr_1", textKey: authKey("thr_1", "id"), command: "id", terminalTitle: "id", createdAt: Date.now(),
  });
  await c.load();
  c.queueRow("id", { waitingOn: { kind: "plugin", pluginId: PLUGIN } });
  await pause(200);
  assert.deepEqual(c.created, []);
});

test("a group with a bound row still waiting for output is held as a whole", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.terminalStatus = "running";
  await c.load();
  const a = await c.send("echo a", OWN);
  const b = await c.send("echo b", OWN);
  await pause(150);
  const job = (id: string) => c.kvStore.get(`job:${c.kvStore.get(`row:${id}`)}`) as { state: string };
  c.kvStore.set(`job:${c.kvStore.get(`row:${a.row!.id}`)}`, { ...job(a.row!.id), state: "rewritten" });
  const d = await c.reask(a.row!, [a.row!, b.row!]);
  assert.equal(d.action, "wait");
  assert.deepEqual(c.sent, []);
  c.reload();
});

test("a held message the user edited is left as edited, not overwritten", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.terminalStatus = "running";
  await c.load();
  const { row } = await c.send("rm build.log", OWN);
  await pause(150);
  row!.content = [{ type: "text", text: "never mind, keep the log", mentions: [] }];
  row!.updatedAt += 1;
  c.state.terminalStatus = "exited";
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.sent, ["never mind, keep the log"]);
  assert.deepEqual(c.created, ["rm build.log"]);
});

test("rewrites succeed although core keeps the row claimed during each pass", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const { row } = await c.send("hostname", OWN);
  row!.claimed = true; // a pass is deciding the row when the output is ready
  setTimeout(() => (row!.claimed = false), 400);
  await c.drive(row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /```output\nout\n```/);
  assert.deepEqual(c.created, ["hostname"]);
});

test("a re-ask racing the binding of its row waits instead of sending the raw command", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  assert.equal((await c.ask("df -h", OWN)).action, "wait");
  const row = c.queueRow("df -h", { waitingOn: { kind: "plugin", pluginId: PLUGIN } });
  // queueRow announced it, so binding is under way; the hook's row lookup sees the old state.
  c.kvStore.delete(`row:${row.id}`);
  c.staleReads.set("row:", 50);
  const raced = c.reask(row);
  await pause(10);
  c.emit("message.queued", row);
  assert.equal((await raced).action, "wait");
  await c.drive(row, () => c.sent.length === 1);
  assert.match(c.sent[0], /```output\nout\n```/);
});

test("a re-ask racing the binding of a row another plugin holds waits too", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  assert.equal((await c.ask("df -h", OWN)).action, "wait");
  const row = c.queueRow("df -h");
  c.kvStore.delete(`row:${row.id}`);
  c.staleReads.set("row:", 50);
  const raced = c.reask(row);
  await pause(10);
  c.emit("message.queued", row);
  assert.equal((await raced).action, "wait");
  await c.drive(row, () => c.sent.length === 1);
  assert.match(c.sent[0], /```output\nout\n```/);
});

test("commands run with pagers turned off unless the setting is off", async () => {
  const on = core({ pollIntervalMs: 50 });
  await on.load();
  const a = await on.send("git log", OWN);
  await on.drive(a.row!, () => on.sent.length === 1);
  assert.deepEqual(on.created, ["git log"]);
  const off = core({ pollIntervalMs: 50, disablePager: false });
  await off.load();
  const b = await off.send("git log", OWN);
  await off.drive(b.row!, () => off.sent.length === 1);
  assert.deepEqual(off.created, ["RAW:git log"]);
});

test("markdown wrapped around a sent command is stripped before it runs", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const { row } = await c.send("> `echo quoted`", OWN);
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.created, ["echo quoted"]);
  assert.match(c.sent[0], /^```sh\necho quoted\n```/);
});

// ------------------------------------------------------------- thread shell

const SHELL = { experimental_submission: { pluginId: PLUGIN, data: { bangShell: 2 } } };
const shellMessage = (command: string, output: string) => `\`\`\`sh\n${command}\n\`\`\`\n\n\`\`\`output\n${output}\n\`\`\``;

async function waitUntil(done: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await pause(10);
  }
}

test("thread shell: runs in one interactive shell, sends only this command's output, never closes it", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const { row } = await c.send("echo hi", SHELL);
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.sent, [shellMessage("echo hi", "out")]);
  const [shell] = c.shells;
  assert.equal(c.shells.length, 1);
  assert.equal(shell.title, "Thread shell");
  assert.match(shell.id, /^term_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);
  assert.deepEqual(shell.commands, ["echo hi"]);
  assert.equal(shell.setups.length, 1);
  assert.match(shell.setups[0], /PAGER=cat/);
  assert.deepEqual(shell.stray, []);
  assert.deepEqual(c.created, [], "no per-command terminal");
  assert.deepEqual(c.closed, [], "the plugin never closes the thread shell");
  await pause(50);
  assert.deepEqual([...c.kvStore.keys()], ["shell:thr_1"]);
});

test("thread shell: pager setting off leaves PAGER alone", async () => {
  const c = core({ pollIntervalMs: 50, disablePager: false });
  await c.load();
  const { row } = await c.send("git log", SHELL);
  await c.drive(row!, () => c.sent.length === 1);
  assert.doesNotMatch(c.shells[0].setups[0], /PAGER/);
});

test("thread shell: a multi-line block is one paste, the shell is reused, exit codes and per-command output hold", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const block = 'read -r "X?prompt: "\necho "got:$X"';
  const first = await c.send(block, SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  c.shells[0].next = { output: "second\r\n", exit: 3, hold: false };
  const second = await c.send("false", SHELL);
  await c.drive(second.row!, () => c.sent.length === 2);
  assert.deepEqual(c.shells[0].commands, [block, "false"]);
  assert.equal(c.shells.length, 1);
  assert.equal(c.shells[0].setups.length, 1, "setup runs once per shell");
  assert.equal(c.sent[1], shellMessage("false", "second\n[exit 3]"));
});

test("thread shell: a busy shell refuses with a hook reject and nothing is typed into the program", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.firstProgram = { output: "", exit: 0, hold: true };
  await c.load();
  const first = await c.send("read -r X", SHELL);
  await waitUntil(() => c.shells.length === 1 && c.shells[0].commands.length === 1);
  const refused = await c.ask("echo b", SHELL);
  assert.equal(refused.action, "reject");
  assert.match(refused.message!, /still running/);
  assert.match(refused.message!, /Ctrl-C/);
  assert.deepEqual(c.shells[0].commands, ["read -r X"]);
  assert.deepEqual(c.shells[0].stray, []);
  c.fake.ctrlC(c.shells[0]);
  await c.drive(first.row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /\[exit 130\]/);
  assert.equal((await c.ask("echo c", SHELL)).action, "wait", "Ctrl-C returns the shell to idle");
});

test("thread shell: waits for its own end mark past waitSeconds and delivers the full output and exit code", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 0, threadShellWaitSeconds: 60 });
  c.state.firstProgram = { output: "prompt: ", exit: 0, hold: true };
  await c.load();
  const { row } = await c.send("read -r X", SHELL);
  await waitUntil(() => c.shells.length === 1 && c.shells[0].commands.length === 1);
  await pause(300);
  await c.reask(row!);
  assert.deepEqual(c.sent, [], "still waiting for the end mark");
  c.fake.finish(c.shells[0], 3, "typed\r\n");
  await c.drive(row!, () => c.sent.length === 1);
  assert.equal(c.sent[0], shellMessage("read -r X", "prompt: typed\n[exit 3]"));
});

test("thread shell: a command that outlived threadShellWaitSeconds keeps the shell busy until it really finishes", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60, threadShellWaitSeconds: 0 });
  c.state.firstProgram = { output: "", exit: 0, hold: true };
  await c.load();
  const { row } = await c.send("sleep 99", SHELL);
  await c.drive(row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /still running in terminal tab "Thread shell"/);
  assert.equal((await c.ask("echo b", SHELL)).action, "reject");
  c.fake.finish(c.shells[0]);
  assert.equal((await c.ask("echo b", SHELL)).action, "wait");
});

test("thread shell: a click while the first use is still setting the shell up is refused", async () => {
  const c = core({ pollIntervalMs: 50 });
  c.state.setupDelayMs = 400;
  await c.load();
  const a = await c.send("echo a", SHELL);
  await waitUntil(() => c.shells.length === 1);
  assert.equal((await c.ask("echo b", SHELL)).action, "reject");
  await c.drive(a.row!, () => c.sent.length === 1);
  assert.deepEqual(c.shells[0].commands, ["echo a"]);
});

test("thread shell: a click between the write and the shell's start mark is refused", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const first = await c.send("true", SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  c.shells[0].startDelayMs = 400;
  const second = await c.send("echo slow", SHELL);
  await waitUntil(() => c.shells[0].commands.length === 2);
  assert.equal((await c.ask("echo b", SHELL)).action, "reject");
  await c.drive(second.row!, () => c.sent.length === 2);
  assert.deepEqual(c.shells[0].commands, ["true", "echo slow"]);
  assert.deepEqual(c.shells[0].stray, []);
});

test("thread shell: a manual command in the panel is busy until it ends", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const { row } = await c.send("true", SHELL);
  await c.drive(row!, () => c.sent.length === 1);
  c.fake.userRun(c.shells[0], true);
  assert.equal((await c.ask("echo b", SHELL)).action, "reject");
  c.fake.finish(c.shells[0]);
  assert.equal((await c.ask("echo b", SHELL)).action, "wait");
});

test("thread shell: busy at start (race after the hook) sends a note and writes nothing", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const { row } = await c.send("true", SHELL);
  await c.drive(row!, () => c.sent.length === 1);
  assert.equal((await c.ask("echo b", SHELL)).action, "wait");
  c.fake.userRun(c.shells[0], true);
  const queued = c.queueRow("echo b", { waitingOn: { kind: "plugin", pluginId: PLUGIN } });
  await c.drive(queued, () => c.sent.length === 2);
  assert.match(c.sent[1], /\[not run: thread shell busy\]/);
  assert.deepEqual(c.shells[0].commands, ["true"]);
  assert.deepEqual(c.shells[0].stray, []);
});

test("thread shell: two quick clicks write once; the second is refused or told it did not run", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.firstProgram = { output: "", exit: 0, hold: true };
  await c.load();
  const a = await c.send("sleep 99", SHELL);
  const b = await c.send("echo b", SHELL);
  await pause(300);
  assert.equal(c.shells[0].commands.length, 1);
  assert.deepEqual(c.shells[0].stray, []);
  if (b.decision.action === "wait") {
    await c.drive(b.row!, () => c.sent.length === 1);
    assert.match(c.sent[0], /not run: thread shell busy/);
  } else assert.equal(b.decision.action, "reject");
  c.fake.finish(c.shells[0]);
  await c.drive(a.row!, () => !c.rows.includes(a.row!));
  assert.equal(c.shells[0].commands.length, 1);
  assert.deepEqual(c.shells[0].stray, []);
});

test("thread shell: the job is saved as written before the command reaches the terminal", async () => {
  const c = core({ pollIntervalMs: 50 });
  const states: unknown[] = [];
  c.state.onInput = () =>
    states.push([...c.kvStore].filter(([k]) => k.startsWith("job:")).map(([, v]) => v as { state: string; sinceSeq?: number; nonce?: string })[0]);
  await c.load();
  const { row } = await c.send("make", SHELL);
  await c.drive(row!, () => c.sent.length === 1);
  const [atSetup, atCommand] = states as { state: string; sinceSeq?: number; nonce?: string }[];
  assert.equal(atSetup.state, "starting", "setup line is typed before the command is written");
  assert.equal(atCommand.state, "running");
  assert.equal(typeof atCommand.sinceSeq, "number");
  assert.match(atCommand.nonce!, /^[0-9a-f]{12}$/);
});

test("thread shell: a resumed job that never saw its command start says so instead of claiming it ran", async () => {
  const c = core({ pollIntervalMs: 50, threadShellWaitSeconds: 0 });
  await c.load();
  const shell = c.fake.create("term_aaaaaaaaaa", "Thread shell", "zsh", null);
  shell.nonce = "0123456789ab";
  const row = {
    id: "q9", threadId: "thr_1", content: [{ type: "text", text: "make", mentions: [] }], updatedAt: 1,
    initiator: "user", senderThreadId: null, originPluginId: null, waitingOn: { kind: "plugin", pluginId: PLUGIN },
    createdAt: Date.now(),
  };
  c.rows.push(row);
  c.kvStore.set("job:j1", {
    id: "j1", threadId: "thr_1", textKey: authKey("thr_1", "make"), command: "make", terminalTitle: "Thread shell", createdAt: Date.now() - 10_000,
    target: "shell", state: "running", rowId: "q9", terminalId: "term_aaaaaaaaaa", nonce: "0123456789ab", sinceSeq: 1, message: null, rewriteAttempts: 0,
  });
  c.kvStore.set("row:q9", "j1");
  await c.reask(row);
  await c.drive(row, () => c.sent.length === 1);
  assert.match(c.sent[0], /may not have run/);
  assert.doesNotMatch(c.sent[0], /still running/);
  assert.equal(shell.commands.length, 0);
});

test("thread shell: a failed write is reported as uncertain and never repeated", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const first = await c.send("true", SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  const calls = c.shells[0].inputCalls;
  c.shells[0].inputFails = 1;
  const { row } = await c.send("rm -rf build", SHELL);
  await c.drive(row!, () => c.sent.length === 2);
  assert.match(c.sent[1], /may not have run/);
  await pause(300);
  assert.equal(c.shells[0].inputCalls, calls + 1, "exactly one attempt");
  assert.deepEqual(c.shells[0].commands, ["true"]);
});

test("thread shell: a closed shell is replaced by a new one on the next use", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const first = await c.send("true", SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  c.shells[0].status = "exited";
  const second = await c.send("echo again", SHELL);
  await c.drive(second.row!, () => c.sent.length === 2);
  assert.equal(c.shells.length, 2);
  assert.notEqual(c.shells[0].id, c.shells[1].id);
  assert.deepEqual(c.shells[1].commands, ["echo again"]);
  assert.equal(c.sent[1], shellMessage("echo again", "out"));
  assert.deepEqual(c.closed, []);
});

test("thread shell: the terminal vanishing mid-command ends the job and forgets the shell", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.firstProgram = { output: "", exit: 0, hold: true };
  await c.load();
  const { row } = await c.send("sleep 99", SHELL);
  await waitUntil(() => c.shells.length === 1 && c.shells[0].commands.length === 1);
  c.shells[0].status = "exited";
  await c.drive(row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /lost the terminal/);
  await pause(50);
  assert.equal(c.kvStore.has("shell:thr_1"), false);
});

test("thread shell: a shell that never reports ready is unsupported within a bounded time and gets no command", async () => {
  const c = core({ pollIntervalMs: 50 });
  c.state.shellKind = "fish";
  await c.load();
  const started = Date.now();
  const { row } = await c.send("echo hi", SHELL);
  await c.drive(row!, () => c.sent.length === 1, 9000);
  assert.ok(Date.now() - started < 8000);
  assert.match(c.sent[0], /\[not run: .*(zsh and bash)/);
  assert.deepEqual(c.shells[0].commands, []);
  assert.deepEqual(c.shells[0].stray, []);
  assert.deepEqual(c.closed, []);
  assert.equal(c.kvStore.has("shell:thr_1"), false);
});

test("thread shell: a job bound by an earlier load but not written is reported, never written", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const row = {
    id: "q9", threadId: "thr_1", content: [{ type: "text", text: "make deploy", mentions: [] }], updatedAt: 1,
    initiator: "user", senderThreadId: null, originPluginId: null, waitingOn: { kind: "plugin", pluginId: PLUGIN },
    createdAt: Date.now(),
  };
  c.rows.push(row);
  c.kvStore.set("job:j1", {
    id: "j1", threadId: "thr_1", textKey: authKey("thr_1", "make deploy"), command: "make deploy", terminalTitle: "Thread shell", createdAt: Date.now(),
    target: "shell", state: "starting", rowId: "q9", terminalId: null, message: null, rewriteAttempts: 0,
  });
  c.kvStore.set("row:q9", "j1");
  await c.reask(row);
  await c.drive(row, () => c.sent.length === 1);
  assert.match(c.sent[0], /was not re-run/);
  assert.equal(c.shells.length, 0);
});

test("thread shell: a plugin reload mid-command resumes polling and does not write again", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.firstProgram = { output: "out\r\n", exit: 0, hold: true };
  await c.load();
  const { row } = await c.send("make", SHELL);
  await waitUntil(() => c.shells.length === 1 && c.shells[0].commands.length === 1);
  const shell = c.shells[0];
  c.reload();
  await c.load();
  c.fake.finish(shell, 0, "built\r\n");
  await c.drive(row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /```output\nout\nbuilt\n```$/);
  assert.deepEqual(shell.commands, ["make"]);
  assert.deepEqual(shell.stray, []);
  assert.equal(shell.setups.length, 1);
});

test("thread shell: a marker from another plugin, an agent or legacy mode never reaches the shell", async () => {
  const c = core({ requireRunAction: false, pollIntervalMs: 50 });
  await c.load();
  const forged = { experimental_submission: { pluginId: "evil", data: { bangShell: 2 } } };
  assert.equal((await c.send("id", forged)).decision.action, "proceed");
  assert.equal((await c.send("id", { initiator: "agent", senderThreadId: "thr_x", ...SHELL })).decision.action, "proceed");
  const legacy = await c.send("!echo hi");
  await c.drive(legacy.row!, () => c.sent.length === 3);
  assert.deepEqual(c.created, ["echo hi"], "legacy and the old marker still use a per-command terminal");
  assert.equal(c.shells.length, 0);
});

test("the Run in terminal marker still uses a fresh per-command terminal that closes", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const { row } = await c.send("ls", OWN);
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.created, ["ls"]);
  assert.deepEqual(c.closed, ["term-1"]);
  assert.equal(c.shells.length, 0);
});

test("thread shell: refused like any run for empty, oversized or environment-less submissions", async () => {
  const c = core();
  await c.load();
  assert.equal((await c.ask("   ", SHELL)).action, "reject");
  assert.equal((await c.ask("x".repeat(MAX_COMMAND_CHARS + 1), SHELL)).action, "reject");
  assert.equal((await c.ask("ls", { ...SHELL, environment: null })).action, "reject");
});

test("thread shell: a parse error ends its own job and does not swallow the next command's output", async () => {
  const c = core({ pollIntervalMs: 50 });
  c.state.firstProgram = { output: "zsh: parse error near `fi'\r\n", exit: 1, hold: false, noStart: true };
  await c.load();
  const first = await c.send("echo a; fi", SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /parse error near `fi'/);
  assert.match(c.sent[0], /\[exit 1\]/);
  const second = await c.send("echo hi", SHELL);
  await c.drive(second.row!, () => c.sent.length === 2);
  assert.equal(c.sent[1], shellMessage("echo hi", "out"));
  assert.equal(c.shells.length, 1);
});

test("thread shell: a transient output error neither recreates the shell nor drops its record", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const first = await c.send("export X=1", SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  const record = structuredClone(c.kvStore.get("shell:thr_1"));
  c.state.failOutputs = 2; // the hook's idle read, then the start path's liveness read
  const second = await c.send("echo $X", SHELL);
  await c.drive(second.row!, () => c.sent.length === 2);
  assert.match(c.sent[1], /could not reach the thread shell/);
  assert.equal(c.shells.length, 1, "no new terminal");
  assert.equal((c.kvStore.get("shell:thr_1") as { terminalId: string }).terminalId, (record as { terminalId: string }).terminalId);
  assert.deepEqual(c.shells[0].commands, ["export X=1"], "nothing was written");
  const third = await c.send("echo $X", SHELL);
  await c.drive(third.row!, () => c.sent.length === 3);
  assert.equal(c.shells.length, 1);
  assert.deepEqual(c.shells[0].commands, ["export X=1", "echo $X"]);
});

test("thread shell: an unterminated block leaves the shell busy until an end mark follows it", async () => {
  const c = core({ pollIntervalMs: 50, threadShellWaitSeconds: 0 });
  c.state.firstProgram = { output: "> ", exit: 0, hold: true, silent: true };
  await c.load();
  const first = await c.send("cat <<EOF\nx", SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  const refused = await c.ask("echo b", SHELL);
  assert.equal(refused.action, "reject");
  assert.match(refused.message!, /still running/);
  assert.deepEqual(c.shells[0].stray, []);
  c.fake.ctrlC(c.shells[0]);
  assert.equal((await c.ask("echo b", SHELL)).action, "wait", "Ctrl-C at the continuation prompt ends with an end mark");
  const second = await c.send("echo c", SHELL);
  await c.drive(second.row!, () => c.sent.length === 2);
  assert.deepEqual(c.shells[0].commands, ["cat <<EOF\nx", "echo c"]);
  assert.deepEqual(c.shells[0].stray, []);
});

test("thread shell: poll failures that do not prove the terminal is gone keep the shell record", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.firstProgram = { output: "", exit: 0, hold: true };
  await c.load();
  const { row } = await c.send("sleep 99", SHELL);
  await waitUntil(() => c.shells.length === 1 && c.shells[0].commands.length === 1);
  c.state.failOutputs = 1000;
  await c.drive(row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /lost the terminal/);
  assert.equal(c.kvStore.has("shell:thr_1"), true);
  assert.equal(c.shells.length, 1);
});

test("thread shell: a terminal the host no longer knows is replaced, not reported unreachable forever", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const first = await c.send("true", SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  c.shells[0].missing = true;
  const second = await c.send("echo again", SHELL);
  await c.drive(second.row!, () => c.sent.length === 2);
  assert.equal(c.shells.length, 2);
  assert.equal(c.sent[1], shellMessage("echo again", "out"));
  assert.deepEqual(c.shells[1].commands, ["echo again"]);
  assert.equal((c.kvStore.get("shell:thr_1") as { terminalId: string }).terminalId, c.shells[1].id);
});

test("thread shell: failing output reads while get reports the terminal exited replace the shell", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const first = await c.send("true", SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  c.shells[0].status = "exited";
  c.state.failOutputs = 2; // the hook's idle read, then the start path's liveness read
  const second = await c.send("echo again", SHELL);
  await c.drive(second.row!, () => c.sent.length === 2);
  assert.equal(c.shells.length, 2);
  assert.deepEqual(c.shells[1].commands, ["echo again"]);
});

test("thread shell: idle is read from a bounded tail, and output after the job's end mark does not make it busy", async () => {
  const c = core({ pollIntervalMs: 50 });
  await c.load();
  const first = await c.send("true", SHELL);
  await c.drive(first.row!, () => c.sent.length === 1);
  const [shell] = c.shells;
  c.fake.userRun(shell, true);
  for (let i = 0; i < 10; i += 1) c.fake.emit(shell, "x".repeat(10_000));
  c.fake.finish(shell);
  c.state.shellReads.length = 0;
  assert.equal((await c.ask("echo b", SHELL)).action, "wait");
  assert.ok(c.state.shellReads.length > 0);
  assert.ok(c.state.shellReads.every((read) => read.tailBytes !== undefined && read.sinceSeq === undefined), "always a bounded tail");
});

test("thread shell: a long output with no end mark after the write is busy", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
  c.state.firstProgram = { output: "", exit: 0, hold: true };
  await c.load();
  const { row } = await c.send("make", SHELL);
  await waitUntil(() => c.shells.length === 1 && c.shells[0].commands.length === 1);
  for (let i = 0; i < 10; i += 1) c.fake.emit(c.shells[0], "y".repeat(10_000));
  const refused = await c.ask("echo b", SHELL);
  assert.equal(refused.action, "reject");
  c.fake.finish(c.shells[0]);
  await c.drive(row!, () => c.sent.length === 1);
  assert.deepEqual(c.shells[0].stray, []);
});

test("input prompt: split output reveals its own terminal once, stays queued and sends final result", async () => {
  const c = core({ pollIntervalMs: 50, waitSeconds: 1, threadShellWaitSeconds: 3 });
  c.state.terminalStatus = "running";
  c.state.output = "Continue? [Y/";
  await c.load();
  const { row } = await c.send("installer", OWN);
  await waitUntil(() => c.state.outputCalls > 0);
  c.state.output = "n] ";
  await waitUntil(() => c.reveals.length === 1);
  assert.deepEqual(c.reveals[0], { channel: "terminal-reveal", payload: { threadId: "thr_1", terminalId: "term-1" } });
  await pause(1100);
  assert.deepEqual(c.sent, [], "prompt extends the wait past waitSeconds");
  c.reload();
  await c.load();
  await c.reask(row!);
  await pause(400);
  assert.equal(c.reveals.length, 1, "reload does not reveal twice");
  c.state.output = "accepted\r\n";
  c.state.terminalStatus = "exited";
  await c.drive(row!, () => c.sent.length === 1);
  assert.match(c.sent[0], /accepted/);
  assert.deepEqual(c.created, ["installer"]);
  assert.deepEqual(c.closed, ["term-1"]);
});

test("input prompt: completed commands do not reveal; timeout reveals an unmatched running command", async () => {
  const done = core({ pollIntervalMs: 50 });
  done.state.output = "Password: ";
  await done.load();
  const a = await done.send("echo", OWN);
  await done.drive(a.row!, () => done.sent.length === 1);
  assert.deepEqual(done.reveals, []);
  const slow = core({ pollIntervalMs: 50, waitSeconds: 0 });
  slow.state.terminalStatus = "running";
  await slow.load();
  const b = await slow.send("silent", OWN);
  await slow.drive(b.row!, () => slow.sent.length === 1);
  assert.equal(slow.reveals.length, 1);
  assert.match(slow.sent[0], /still running/);
  assert.deepEqual(slow.closed, []);
  slow.reload();
});

for (const prompt of ["Выберите вариант: ", "Имя: ", "1) one\r\n2) two\r\n#? "]) {
  test(`input prompt: reveals a quiet unfinished line ${JSON.stringify(prompt)}`, async () => {
    const c = core({ pollIntervalMs: 50, waitSeconds: 60 });
    c.state.terminalStatus = "running";
    c.state.output = prompt;
    await c.load();
    const { row } = await c.send("read", OWN);
    await waitUntil(() => c.reveals.length === 1);
    assert.deepEqual(c.sent, []);
    c.state.terminalStatus = "exited";
    await c.drive(row!, () => c.sent.length === 1);
    assert.equal(c.reveals.length, 1);
  });
}
