import assert from "node:assert/strict";
import { test } from "node:test";
import { JobScanner, lastMark, newTerminalId, pasteInput, setupLine } from "../thread-shell.ts";

const N = "a1b2c3d4e5f6";
const S = `\u001b]7777;${N};S\u0007`;
const E = (n: number) => `\u001b]7777;${N};E;${n}\u0007`;

test("setupLine matches the line verified in the real PTY", () => {
  const line = setupLine(N, true);
  assert.ok(line.startsWith(` __bs_n=${N};`), "leading space keeps it out of history");
  assert.ok(line.endsWith('printf "\\033[H\\033[2J\\033[3J"\r'));
  assert.match(line, /preexec_functions\+=\(__bs_s\); precmd_functions=\(__bs_e \$precmd_functions\)/);
  assert.match(line, /-ge 404/);
  assert.match(line, /export PAGER=cat GIT_PAGER=cat;/);
  assert.doesNotMatch(setupLine(N, false), /PAGER/);
  assert.equal(line.split("\n").length, 1);
});

test("pasteInput wraps the block in a bracketed paste and drops ESC", () => {
  assert.equal(pasteInput("a\nb"), "\u001b[200~a\nb\u001b[201~\r");
  assert.equal(pasteInput("x\u001b[201~rm -rf y"), "\u001b[200~x[201~rm -rf y\u001b[201~\r");
});

test("newTerminalId follows the id pattern bb accepts", () => {
  for (let i = 0; i < 50; i += 1) assert.match(newTerminalId(), /^term_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);
});

test("lastMark reports the last mark of this shell only", () => {
  assert.equal(lastMark("prompt", N), null);
  assert.deepEqual(lastMark(`${E(0)}x${S}`, N), { kind: "S" });
  assert.deepEqual(lastMark(`${S}x${E(130)}\r\nprompt`, N), { kind: "E", status: 130 });
  assert.equal(lastMark(S.replace(N, "ffffffffffff"), N), null);
});

test("JobScanner keeps only this command's output, between its marks", () => {
  const scan = new JobScanner(N, 1000);
  scan.push(`typed-by-user\r\nprompt % ${S}out1\r\n`);
  assert.equal(scan.started, true);
  assert.equal(scan.done, false);
  scan.push(`out2\r\n${E(3)}\r\nprompt % `);
  assert.equal(scan.done, true);
  assert.equal(scan.exitCode, 3);
  assert.equal(scan.output, "out1\r\nout2\r\n");
});

test("JobScanner handles marks split across chunks", () => {
  const stream = `${S}hello${E(0)}`;
  for (let cut = 1; cut < stream.length; cut += 1) {
    const scan = new JobScanner(N, 1000);
    scan.push(stream.slice(0, cut));
    scan.push(stream.slice(cut));
    assert.equal(scan.output, "hello", `cut ${cut}`);
    assert.equal(scan.exitCode, 0, `cut ${cut}`);
  }
});

test("JobScanner ends a job on an end mark without a start (parse error) with everything seen since the write", () => {
  const scan = new JobScanner(N, 1000);
  scan.push("echo a; fi\r\nzsh: parse error near `fi'\r\n");
  assert.equal(scan.done, false);
  scan.push(E(1));
  assert.equal(scan.done, true);
  assert.equal(scan.started, false);
  assert.equal(scan.exitCode, 1);
  assert.match(scan.output, /parse error near `fi'/);
});

test("JobScanner bounds its output", () => {
  const scan = new JobScanner(N, 5);
  scan.push(`${S}0123456789`);
  assert.equal(scan.output, "56789");
});

test("JobScanner does not swallow an ordinary escape sequence", () => {
  const scan = new JobScanner(N, 1000);
  scan.push(`${S}\u001b[32mok\u001b[0m`);
  scan.push(`!`);
  assert.equal(scan.output, "\u001b[32mok\u001b[0m!");
});
