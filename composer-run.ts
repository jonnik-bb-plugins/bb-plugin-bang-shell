// Run actions that send a command through the composer. Separate from app.tsx so
// they can be tested without the bb app runtime.
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";

export const SUBMISSION = { bangShell: 1 } as const;
/** Same key, value 2: run in the thread's persistent shell instead of a fresh terminal. */
export const SHELL_SUBMISSION = { bangShell: 2 } as const;
export type Submission = typeof SUBMISSION | typeof SHELL_SUBMISSION;

/**
 * Sends `command` through the thread's composer with the run action, then puts
 * back whatever the user was typing. Going through the composer keeps the
 * same trust path as Mod+Alt+Enter: a human click in the bb window.
 */
export async function runText(
  composer: PluginComposerApi,
  command: string,
  submission: Submission = SUBMISSION,
  onSent?: () => void,
): Promise<void> {
  // No isSubmittingBlocked pre-check: an empty draft counts as blocked
  // ("Type a message first."), and submit reports any real block itself.
  const saved = composer.draft;
  composer.replace({ text: command, mentions: [], attachments: [] });
  // `submit` judges emptiness by the rendered draft: in the same task it still
  // sees the old one, rejects an empty composer, and shows nothing.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await composer.submit({ experimental_data: submission });
    onSent?.();
  } catch {
    // A refusal from the server or a plugin already has bb's error toast.
  } finally {
    if (saved.text !== "" || saved.attachments.length > 0) composer.replace(saved);
    else if (!composer.isEmpty) composer.replace({ text: "", mentions: [], attachments: [] });
  }
}
