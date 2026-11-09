import assert from "node:assert/strict";
import { test } from "node:test";
import { firstShellBlock, normalizeCommand, pickCommand } from "../command-text.ts";

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

test("normalizeCommand strips the markdown Add to chat wraps around a command", () => {
  assert.equal(normalizeCommand("`echo inline-ok`"), "echo inline-ok");
  assert.equal(normalizeCommand("> `CHECK=\"$(grep -m1 x .env)\" mongosh --quiet`"), 'CHECK="$(grep -m1 x .env)" mongosh --quiet');
  assert.equal(normalizeCommand("> line one\n> line two"), "line one\nline two");
  assert.equal(normalizeCommand("```sh\nnpm test\n```"), "npm test");
  assert.equal(normalizeCommand("> ```bash\n> make\n> ```"), "make");
  assert.equal(normalizeCommand("$ git status"), "git status");
  assert.equal(normalizeCommand("``echo `date` ``"), "echo `date`");
});

test("normalizeCommand leaves real shell syntax alone", () => {
  assert.equal(normalizeCommand("echo `date`"), "echo `date`");
  assert.equal(normalizeCommand("ls > out.txt"), "ls > out.txt");
  assert.equal(normalizeCommand("echo $HOME"), "echo $HOME");
  assert.equal(normalizeCommand("`date` && echo done"), "`date` && echo done");
  assert.equal(normalizeCommand("  git log  "), "git log");
});
