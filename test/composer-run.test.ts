import assert from "node:assert/strict";
import { test } from "node:test";
import { SHELL_SUBMISSION, runText } from "../composer-run.ts";

type Draft = { text: string; mentions: never[]; attachments: never[] };
const draft = (text: string): Draft => ({ text, mentions: [], attachments: [] });

/**
 * A fake composer as bb 0.50.1 behaves: `replace` shows up in `draft` and
 * `isEmpty` at once, but `submit` judges emptiness by the last rendered draft,
 * which catches up only after the current task.
 */
function composer(initial = "", refuse?: string) {
  let current = draft(initial);
  let rendered = current;
  const sent: { text: string; data: unknown }[] = [];
  const replace = (next: Draft) => {
    current = next;
    setTimeout(() => (rendered = current), 0);
  };
  const api = {
    get draft() {
      return current;
    },
    get isEmpty() {
      return current.text === "";
    },
    isSubmittingBlocked: false,
    replace,
    async submit(options: { experimental_data: unknown }) {
      if (rendered.text === "") throw new Error("Type a message first.");
      if (refuse) throw new Error(refuse);
      sent.push({ text: current.text, data: options.experimental_data });
      replace(draft(""));
    },
  };
  return { api: api as never, sent, text: () => current.text };
}

test("runText sends the command from an empty composer and leaves it empty", async () => {
  const c = composer();
  let revealed = 0;
  await runText(c.api, "read -r X", SHELL_SUBMISSION, () => (revealed += 1));
  assert.deepEqual(c.sent, [{ text: "read -r X", data: { bangShell: 2 } }]);
  assert.equal(c.text(), "");
  assert.equal(revealed, 1);
});

test("runText sends the command, not the user's draft, and puts the draft back", async () => {
  const c = composer("half-typed question");
  await runText(c.api, "ls");
  assert.deepEqual(c.sent, [{ text: "ls", data: { bangShell: 1 } }]);
  assert.equal(c.text(), "half-typed question");
});

test("a refused run restores the draft and does not report it as sent", async () => {
  const c = composer("note", "Failed to send message.");
  let revealed = 0;
  await runText(c.api, "ls", SHELL_SUBMISSION, () => (revealed += 1));
  assert.deepEqual(c.sent, []);
  assert.equal(c.text(), "note");
  assert.equal(revealed, 0);
});
