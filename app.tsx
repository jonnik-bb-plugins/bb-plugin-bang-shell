// Composer and message entry points that mark a submission as "run this in the
// terminal". The server runs a command only for submissions carrying this plugin's data.
import {
  definePluginApp,
  useComposer,
  useSettings,
  type ExperimentalCodeFenceRendererProps,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";
import { RUN_FENCE_LANGUAGES, codeFenceCommand, enabledRunLanguages, pickCommand } from "./command-text.ts";

const SUBMISSION = { bangShell: 1 } as const;

async function runInTerminal(composer: PluginComposerApi): Promise<void> {
  if (composer.isEmpty || composer.isSubmittingBlocked) return;
  // On failure bb already shows its error toast and restores the draft.
  await composer.submit({ experimental_data: SUBMISSION }).catch(() => {});
}

/**
 * Sends `command` through the thread's composer with the run action, then puts
 * back whatever the user was typing. Going through the composer keeps the
 * same trust path as Mod+Alt+Enter: a human click in the bb window.
 */
async function runText(composer: PluginComposerApi, command: string): Promise<void> {
  // No isSubmittingBlocked pre-check: an empty draft counts as blocked
  // ("Type a message first."), and submit reports any real block itself.
  const saved = composer.draft;
  composer.replace({ text: command, mentions: [], attachments: [] });
  try {
    await composer.submit({ experimental_data: SUBMISSION });
  } catch {
    // bb already showed its error toast.
  } finally {
    if (saved.text !== "" || saved.attachments.length > 0) composer.replace(saved);
    else if (!composer.isEmpty) composer.replace({ text: "", mentions: [], attachments: [] });
  }
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
  const [running, setRunning] = useState(false);
  const onClick = async () => {
    const command = codeFenceCommand(language, code);
    if (!command) return;
    if (composer.scope.kind !== "thread") {
      toast.error("Open this thread's composer to run a command.");
      return;
    }
    setRunning(true);
    try {
      await runText(composer, command);
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
          title="Run in terminal"
          aria-label="Run in terminal"
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
        </button>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "bang-shell",
    scopes: ["thread"],
    sendMenu: [
      {
        id: "run-in-terminal",
        label: "Run in terminal",
        icon: "Terminal",
        description: "Run the message as a shell command in this thread's environment and send its output",
        disabled: (composer) => composer.isEmpty || composer.isSubmittingBlocked,
        run: ({ composer }) => runInTerminal(composer),
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
