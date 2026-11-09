// Composer and message entry points that mark a submission as "run this in the
// terminal". The server runs a command only for submissions carrying this plugin's data.
import { definePluginApp, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { pickCommand } from "./command-text.ts";

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
});
