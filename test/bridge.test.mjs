import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-cwd-"));
let client;

before(async () => {
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(here, "..", "server.mjs")],
      env: { ...process.env, CODEX_BRIDGE_HOME: home, CODEX_BIN: path.join(here, "fake-codex.mjs") },
    }),
  );
});

after(async () => {
  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  if (r.isError) throw new Error(t);
  return t;
}

async function untilIdle(name) {
  for (let i = 0; i < 100; i++) {
    const line = (await call("codex_jobs", {})).split("\n").find((l) => l.includes(` name=${name} `));
    if (line?.includes("status=idle")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${name} never went idle`);
}

test("a message queued while Codex is running is delivered even if the turn ends first", async () => {
  await call("codex_start", { mode: "freeform", name: "q", cwd, plan: "SLOW first task" });
  const sent = await call("codex_send", { job_id: "q", message: "LATE-CORRECTION" });
  assert.match(sent, /Queued/);

  // Turn 2 may finish within the same codex_wait as turn 1, so collect until it shows up.
  let seen = "";
  for (let i = 0; i < 3 && !/finished turn 2/.test(seen); i++) seen += await call("codex_wait", { job_id: "q", timeout_sec: 20 });
  assert.match(seen, /finished turn 1/);
  assert.match(seen, /started turn 2 to deliver them/);
  assert.match(seen, /finished turn 2\. Final answer:\n.*LATE-CORRECTION/s);
});

test("codex_wait after a follow-up returns the new turn, not the previous unread answer", async () => {
  await call("codex_start", { mode: "freeform", name: "s", cwd, plan: "ANSWER-ONE" });
  await untilIdle("s");
  // Turn 1's answer was never read; starting turn 2 must flush it instead of leaving it for codex_wait.
  const sent = await call("codex_send", { job_id: "s", message: "ANSWER-TWO" });
  assert.match(sent, /Unread output from the previous turn/);
  assert.match(sent, /ANSWER-ONE/);

  const next = await call("codex_wait", { job_id: "s", timeout_sec: 20 });
  assert.match(next, /finished turn 2/);
  assert.match(next, /ANSWER-TWO/);
  assert.doesNotMatch(next, /ANSWER-ONE/);
});
