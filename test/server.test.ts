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
  const closed: string[] = [];
  const rows: Row[] = [];
  const sent: string[] = [];
  const listeners = new Map<string, (p: { entry: Row }) => void>();
  let disposers: (() => void)[] = [];
  let hook: ((ctx: unknown) => Promise<Decision>) | null = null;
  let lastDecision = new Map<string, Decision>();
  const state = {
    terminalStatus: "exited" as "exited" | "running" | "throw",
    failUpdates: 0,
    rechecks: 0,
    outputCalls: 0,
  };

  const bb = {
    pluginId: PLUGIN,
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
        create: async (args: { start: { command: string }; title: string }) => {
          created.push(args.start.command.startsWith(NO_PAGER_PREFIX) ? args.start.command.slice(NO_PAGER_PREFIX.length) : `RAW:${args.start.command}`);
          return { id: `term-${created.length}`, title: args.title };
        },
        output: async () => {
          state.outputCalls += 1;
          if (state.terminalStatus === "throw") throw new Error("gone");
          return {
            chunks: [{ dataBase64: Buffer.from("out\r\n").toString("base64"), seq: 1 }],
            nextSeq: 2,
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
    kvStore,
    staleReads,
    created,
    closed,
    rows,
    sent,
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
