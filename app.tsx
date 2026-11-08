// Composer entry points that mark a submission as "run this in the terminal".
// The server runs a command only for submissions carrying this plugin's data.
import { definePluginApp, type PluginComposerApi } from "@get-bb/plugin-sdk/app";

const SUBMISSION = { bangShell: 1 } as const;

async function runInTerminal(composer: PluginComposerApi): Promise<void> {
  if (composer.isEmpty || composer.isSubmittingBlocked) return;
  // On failure bb already shows its error toast and restores the draft.
  await composer.submit({ experimental_data: SUBMISSION }).catch(() => {});
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "bang-shell",
    scopes: ["thread"],
    sendMenu: [
      {
        id: "run-in-terminal",
        label: "Run in terminal",
        icon: "SquareTerminal",
        description: "Run the message as a shell command in this thread's environment and send its output",
        disabled: (composer) => composer.isEmpty || composer.isSubmittingBlocked,
        run: ({ composer }) => runInTerminal(composer),
      },
    ],
  });
  app.composer.experimental_registerCommand({
    id: "run-in-terminal",
    title: "Bang Shell: run message in terminal",
    defaultShortcut: { key: "Enter", mod: true, shift: true },
    run: ({ composer }) => runInTerminal(composer),
  });
});
