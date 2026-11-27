// Composer and message entry points that mark a submission as "run this in the
// terminal". The server runs a command only for submissions carrying this plugin's data.
import {
  definePluginApp,
  useBbNavigate,
  useComposer,
  useSdk,
  useRealtime,
  useSettings,
  type BbNavigate,
  type ExperimentalCodeFenceRendererProps,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RUN_FENCE_LANGUAGES, TERMINAL_REVEAL_CHANNEL, THREAD_SHELL_TITLE, codeFenceCommand, enabledRunLanguages, pickCommand } from "./command-text.ts";
import { SHELL_SUBMISSION, SUBMISSION, runText, type Submission } from "./composer-run.ts";

/** How long a first use waits for the server to create the thread shell terminal. */
const REVEAL_WAIT_MS = 5000;

async function runInTerminal(composer: PluginComposerApi, submission: Submission = SUBMISSION, onSent?: () => void): Promise<void> {
  if (composer.isEmpty || composer.isSubmittingBlocked) return;
  // On failure bb already shows its error toast and restores the draft.
  await composer.submit({ experimental_data: submission }).then(onSent).catch(() => {});
}

type ShellWatch = { terminalId: string | null; listeners: Set<() => void>; stop: () => void };
type Sdk = ReturnType<typeof useSdk>;
/** One watcher per thread, shared by every Run button and reveal in it. */
const shellWatches = new Map<string, ShellWatch>();

function watchThreadShell(sdk: Sdk, threadId: string, onChange: () => void): () => void {
  let watch = shellWatches.get(threadId);
  if (!watch) {
    const created: ShellWatch = { terminalId: null, listeners: new Set(), stop: () => {} };
    const refresh = () =>
      sdk.terminals
        .list({ scope: { kind: "thread", threadId } })
        .then(({ sessions }) => {
          const [newest] = sessions
            .filter((t) => t.title === THREAD_SHELL_TITLE && (t.status === "running" || t.status === "starting"))
            .sort((a, b) => b.createdAt - a.createdAt);
          const terminalId = newest?.id ?? null;
          if (terminalId === created.terminalId) return;
          created.terminalId = terminalId;
          created.listeners.forEach((listener) => listener());
        })
        .catch(() => {});
    created.stop = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (event.changes.includes("terminals-changed")) void refresh();
      },
    });
    void refresh();
    shellWatches.set(threadId, created);
    watch = created;
  }
  watch.listeners.add(onChange);
  return () => {
    watch.listeners.delete(onChange);
    if (watch.listeners.size > 0) return;
    watch.stop();
    shellWatches.delete(threadId);
  };
}

/** Whether the thread has a live thread shell terminal. */
function useThreadShellLive(threadId: string | null): boolean {
  const sdk = useSdk();
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!threadId) return;
    const read = () => setLive(Boolean(shellWatches.get(threadId)?.terminalId));
    const stop = watchThreadShell(sdk, threadId, read);
    read();
    return stop;
  }, [sdk, threadId]);
  return threadId ? live : false;
}

/** Shows the thread shell terminal, waiting briefly for a first one to appear; never affects the run. */
function revealThreadShell(sdk: Sdk, navigate: BbNavigate, threadId: string): void {
  let done = false;
  let stop = () => {};
  const finish = () => {
    done = true;
    clearTimeout(timer);
    stop();
  };
  const timer = setTimeout(finish, REVEAL_WAIT_MS);
  const open = () => {
    const terminalId = shellWatches.get(threadId)?.terminalId;
    if (done || !terminalId) return;
    finish();
    void Promise.resolve()
      .then(() => navigate.experimental_openTerminal({ terminalId }))
      .catch(() => {});
  };
  stop = watchThreadShell(sdk, threadId, open);
  open();
}

/** Per thread, the reveal bound to its mounted composer: a Send menu row gets no navigation of its own. */
const revealers = new Map<string, () => void>();

/** Renders nothing; lends the composer's navigation to the Send menu. */
function ThreadShellRevealer() {
  const composer = useComposer();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  useRealtime(TERMINAL_REVEAL_CHANNEL, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const event = payload as { threadId?: unknown; terminalId?: unknown };
    const { terminalId } = event;
    if (!threadId || event.threadId !== threadId || typeof terminalId !== "string") return;
    void Promise.resolve().then(() => navigate.experimental_openTerminal({ terminalId })).catch(() => {});
  });
  useEffect(() => {
    if (!threadId) return;
    const reveal = () => revealThreadShell(sdk, navigate, threadId);
    revealers.set(threadId, reveal);
    return () => {
      if (revealers.get(threadId) === reveal) revealers.delete(threadId);
    };
  }, [sdk, navigate, threadId]);
  return null;
}

/** BB's code block plus a one-click run button in its header, left of BB's wrap/copy buttons. */
function RunCodeBlock(props: ExperimentalCodeFenceRendererProps) {
  const { values } = useSettings();
  // Settings not loaded (or failed): no button.
  if (!enabledRunLanguages(values).has(props.language.trim().toLowerCase())) return <props.Original />;
  return <RunCodeBlockButton {...props} />;
}

function RunCodeBlockButton({ code, language, status, Original }: ExperimentalCodeFenceRendererProps) {
  const composer = useComposer();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [running, setRunning] = useState(false);
  const shellLive = useThreadShellLive(composer.scope.kind === "thread" ? composer.scope.threadId : null);
  const onClick = async (event: { altKey: boolean }) => {
    const command = codeFenceCommand(language, code);
    if (!command) return;
    if (composer.scope.kind !== "thread") {
      toast.error("Open this thread's composer to run a command.");
      return;
    }
    setRunning(true);
    try {
      const { threadId } = composer.scope;
      if (event.altKey) await runText(composer, command, SHELL_SUBMISSION, () => revealThreadShell(sdk, navigate, threadId));
      else await runText(composer, command);
    } finally {
      setRunning(false);
    }
  };
  return (
    <div style={{ position: "relative" }}>
      <Original />
      {status === "closed" && codeFenceCommand(language, code) && (
        // right/top offsets are a visual guess to clear BB's wrap and copy buttons.
        <button
          type="button"
          title="Run in terminal · Alt-click: run in this thread's shell"
          aria-label="Run in terminal; Alt-click runs in this thread's shell"
          disabled={running}
          onClick={onClick}
          style={{
            position: "absolute",
            right: 48,
            top: 6,
            display: "flex",
            padding: 4,
            border: 0,
            borderRadius: 4,
            background: "transparent",
            color: "inherit",
            opacity: running ? 0.4 : 0.7,
            cursor: running ? "default" : "pointer",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          {shellLive && (
            <span
              aria-hidden="true"
              style={{ position: "absolute", right: 1, top: 1, width: 5, height: 5, borderRadius: "50%", background: "#22c55e" }}
            />
          )}
        </button>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "bang-shell",
    scopes: ["thread"],
    banners: [{ id: "thread-shell-reveal", chrome: "bare", component: ThreadShellRevealer }],
    sendMenu: [
      {
        id: "run-in-terminal",
        label: "Run in terminal",
        icon: "Terminal",
        description: "Run the message as a shell command in this thread's environment and send its output",
        disabled: (composer) => composer.isEmpty || composer.isSubmittingBlocked,
        run: ({ composer }) => runInTerminal(composer),
      },
      {
        id: "run-in-thread-shell",
        label: "Run in thread shell",
        icon: "Terminal",
        description: "Run the message in this thread's persistent shell, which keeps variables and the working folder between commands",
        disabled: (composer) => composer.isEmpty || composer.isSubmittingBlocked,
        run: ({ composer }) =>
          runInTerminal(composer, SHELL_SUBMISSION, () => {
            if (composer.scope.kind === "thread") revealers.get(composer.scope.threadId)?.();
          }),
      },
    ],
  });
  app.composer.experimental_registerCommand({
    id: "run-in-terminal",
    title: "Bang Shell: run message in terminal",
    defaultShortcut: { key: "Enter", mod: true, alt: true },
    run: ({ composer }) => runInTerminal(composer),
  });
  // Text-selection menu on assistant messages, and the per-message action bar.
  app.slots.messageAction({
    id: "run-selection-in-terminal",
    title: "Run in terminal",
    icon: "Terminal",
    run: async ({ selectedText, message, composer }) => {
      const command = pickCommand(selectedText, message.text);
      if (!command) {
        toast("Select the command text first, or use a message with a shell code block.");
        return;
      }
      if (!composer) {
        toast.error("Open this thread's composer to run a command.");
        return;
      }
      await runText(composer, command);
    },
  });
  app.slots.experimental_codeFenceRenderer({
    id: "run-code-block",
    languages: RUN_FENCE_LANGUAGES,
    component: RunCodeBlock,
  });
});
