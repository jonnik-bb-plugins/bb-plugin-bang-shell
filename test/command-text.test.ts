import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUN_FENCE_LANGUAGES,
  SHELL_FENCE_LANGUAGES,
  codeBlockCommand,
  codeFenceCommand,
  enabledRunLanguages,
  firstShellBlock,
  normalizeCommand,
  parseRunButtonLanguages,
  pickCommand,
} from "../command-text.ts";

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

test("codeBlockCommand drops prompts, trims, and returns null when empty", () => {
  assert.equal(codeBlockCommand("$ git status\n$ ls\n"), "git status\nls");
  assert.equal(codeBlockCommand("\nnpm test\n"), "npm test");
  assert.equal(codeBlockCommand(" \n"), null);
});

test("SHELL_FENCE_LANGUAGES are non-empty and registrable", () => {
  assert.ok(SHELL_FENCE_LANGUAGES.includes("bash"));
  for (const language of SHELL_FENCE_LANGUAGES) assert.match(language, /^[a-z0-9][a-z0-9+#._-]*$/);
});

const DEFAULT_LANGS = ["sh", "bash", "zsh", "shell", "console", "terminal"];

test("parseRunButtonLanguages: default, custom, unknown dropped, none, non-string", () => {
  assert.deepEqual(parseRunButtonLanguages("sh, bash, zsh, shell, console, terminal"), DEFAULT_LANGS);
  assert.deepEqual(parseRunButtonLanguages(" BASH  fish,bash "), ["bash", "fish"]);
  assert.deepEqual(parseRunButtonLanguages("bash, ruby, python"), ["bash"]);
  assert.deepEqual(parseRunButtonLanguages("ruby"), DEFAULT_LANGS);
  assert.deepEqual(parseRunButtonLanguages(""), DEFAULT_LANGS);
  assert.deepEqual(parseRunButtonLanguages(" None "), []);
  for (const bad of [undefined, null, 5, true, ["sh"]]) assert.deepEqual(parseRunButtonLanguages(bad), DEFAULT_LANGS);
});

test("enabledRunLanguages gates on loaded settings and the python switch", () => {
  assert.equal(enabledRunLanguages(undefined).size, 0);
  assert.deepEqual([...enabledRunLanguages({ runButtonLanguages: "bash" })], ["bash"]);
  assert.deepEqual([...enabledRunLanguages({ runButtonLanguages: "none", runPythonBlocks: true })], ["python", "py", "python3"]);
  assert.ok(enabledRunLanguages({}).has("sh"));
  assert.ok(RUN_FENCE_LANGUAGES.includes("fish") && RUN_FENCE_LANGUAGES.includes("py"));
});

test("codeFenceCommand wraps python in a heredoc and keeps prompts", () => {
  assert.equal(codeFenceCommand("python", "print(1)\n\n"), "python3 - <<'BB_PY_EOF'\nprint(1)\nBB_PY_EOF");
  assert.equal(codeFenceCommand("PY", "$ x = 1"), "python3 - <<'BB_PY_EOF'\n$ x = 1\nBB_PY_EOF");
  assert.equal(
    codeFenceCommand("python3", "a = '''\nBB_PY_EOF\nBB_PY_EOF2\n'''"),
    "python3 - <<'BB_PY_EOF3'\na = '''\nBB_PY_EOF\nBB_PY_EOF2\n'''\nBB_PY_EOF3",
  );
  assert.equal(codeFenceCommand("python", "  \n"), null);
  assert.equal(codeFenceCommand("bash", "$ ls\n"), "ls");
  assert.equal(codeFenceCommand("ruby", "puts 1"), null);
});

test("normalizeCommand leaves a python heredoc command unchanged", () => {
  const command = codeFenceCommand("python", "import os\nprint(os.getcwd())")!;
  assert.equal(normalizeCommand(command), command);
});
