import assert from "node:assert/strict";
import { test } from "node:test";
import { firstShellBlock, pickCommand } from "../command-text.ts";

test("pickCommand prefers the highlighted text", () => {
  assert.equal(pickCommand("  git status \n", "```sh\nls\n```"), "git status");
});

test("without a selection, the first shell code block is used", () => {
  const text = "Try this:\n\n```ts\nconst x = 1;\n```\n\n```bash\nnpm test\nnpm run build\n```\n\n```sh\nls\n```";
  assert.equal(pickCommand(undefined, text), "npm test\nnpm run build");
  assert.equal(pickCommand("   ", text), "npm test\nnpm run build");
});

test("unlabelled and console blocks count; console prompts are stripped", () => {
  assert.equal(firstShellBlock("```\nmake\n```"), "make");
  assert.equal(firstShellBlock("```console\n$ git log --oneline\na5017cf Add\n$ ls\n```"), "git log --oneline\nls");
  assert.equal(firstShellBlock("````sh\necho ```\n````"), "echo ```");
});

test("nothing runnable gives null", () => {
  assert.equal(pickCommand(undefined, "No code here."), null);
  assert.equal(pickCommand(undefined, "```python\nprint(1)\n```"), null);
  assert.equal(pickCommand("", "```sh\n\n```"), null);
});
