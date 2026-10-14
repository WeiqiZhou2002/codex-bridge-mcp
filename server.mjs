#!/usr/bin/env node
// codex-bridge: a two-way MCP bridge between Claude Code and the Codex CLI.
//
//   Claude side (default):  node server.mjs
//     codex_start / codex_wait / codex_send / codex_cancel / codex_jobs
//   Codex side (injected into each `codex exec` via -c mcp_servers.claude_bridge...):
//     node server.mjs --role codex --job <id>
//     ask_claude / message_claude / check_inbox
//
// The two sides talk through a per-job mailbox on disk: ~/.codex-bridge/jobs/<id>/
//   events.jsonl   codex -> claude (questions, messages, progress digest, turn results)
//   answers/<qid>  claude -> codex (answers to blocking ask_claude calls)
//   inbox.jsonl    claude -> codex (unsolicited messages, delivered on Codex's next bridge call)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

// Codex does not forward arbitrary env vars to MCP servers, so the Codex side gets --home explicitly.
const ROOT = argOf("--home") || process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge");
const JOBS = path.join(ROOT, "jobs");
const CODEX_BIN = process.env.CODEX_BIN || "codex";

// ---------- mailbox helpers ----------

const newId = (n = 4) => randomBytes(n).toString("hex");
const jobDir = (id) => path.join(JOBS, id);
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify({ ts: now(), ...obj }) + "\n");
}

function readLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line that is mid-write; it will be picked up on the next read
      break;
    }
  }
  return out;
}

const metaPath = (id) => path.join(jobDir(id), "meta.json");
const eventsPath = (id) => path.join(jobDir(id), "events.jsonl");
const inboxPath = (id) => path.join(jobDir(id), "inbox.jsonl");
const answerPath = (id, qid) => path.join(jobDir(id), "answers", `${qid}.json`);

function loadMeta(id) {
  const meta = readJson(metaPath(id), null);
  if (!meta) throw new Error(`Unknown job_id: ${id}`);
  return meta;
}

function allMetas() {
  if (!fs.existsSync(JOBS)) return [];
  return fs
    .readdirSync(JOBS)
    .map((d) => readJson(metaPath(d), null))
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// Accepts a job id or a job name; a name resolves to the newest job carrying it.
function resolveJob(ref) {
  if (fs.existsSync(metaPath(ref))) return ref;
  const hit = allMetas().find((m) => m.name === ref);
  if (!hit) throw new Error(`No job with id or name "${ref}". Use codex_jobs to list them.`);
  return hit.id;
}

function pendingQuestions(id) {
  return readLines(eventsPath(id)).filter(
    (e) => e.type === "question" && !fs.existsSync(answerPath(id, e.qid)),
  );
}

const text = (s) => ({ content: [{ type: "text", text: s }] });

// =====================================================================
// Codex side
// =====================================================================

async function runCodexSide(jobId) {
  if (!jobId || !fs.existsSync(jobDir(jobId))) {
    console.error(`codex-bridge: missing or unknown --job ${jobId}`);
    process.exit(1);
  }
  const cursorFile = path.join(jobDir(jobId), "inbox.cursor");

  // Any messages Claude queued for Codex ride along on every bridge tool result.
  function drainInbox() {
    const all = readLines(inboxPath(jobId));
    const seen = readJson(cursorFile, 0);
    const fresh = all.slice(seen);
    if (!fresh.length) return "";
    writeJson(cursorFile, all.length);
    return (
      "\n\n--- New message(s) from Claude ---\n" +
      fresh.map((m) => `[${m.ts}] ${m.text}`).join("\n\n")
    );
  }

  const server = new McpServer({ name: "claude_bridge", version: "1.0.0" });

  server.registerTool(
    "ask_claude",
    {
      description:
        "Ask Claude (the lead agent who wrote your plan) a question and BLOCK until Claude answers. " +
        "Use this for ambiguities, decisions the plan does not cover, or when you believe the plan is wrong " +
        "and want sign-off before deviating. Include enough context that Claude can answer without re-reading everything.",
      inputSchema: {
        question: z.string().describe("The question, with the relevant context and the options you see."),
        timeout_sec: z
          .number()
          .int()
          .min(10)
          .max(3600)
          .optional()
          .describe("How long to wait for an answer (default 1800)."),
      },
    },
    async ({ question, timeout_sec = 1800 }) => {
      const qid = newId(3);
      appendLine(eventsPath(jobId), { type: "question", qid, text: question });
      const deadline = Date.now() + timeout_sec * 1000;
      while (Date.now() < deadline) {
        const ans = readJson(answerPath(jobId, qid), null);
        if (ans) return text(`Claude answered:\n${ans.text}${drainInbox()}`);
        await sleep(1000);
      }
      appendLine(eventsPath(jobId), { type: "question_timeout", qid });
      return text(
        `Claude did not answer within ${timeout_sec}s. Proceed with your best judgment, ` +
          `state the assumption you made in your final summary.${drainInbox()}`,
      );
    },
  );

  server.registerTool(
    "message_claude",
    {
      description:
        "Send Claude a non-blocking message: a milestone, an important finding, a deviation from the plan, or a blocker. " +
        "Keep it short. Returns immediately (plus any messages Claude has queued for you).",
      inputSchema: {
        message: z.string(),
        kind: z.enum(["progress", "finding", "deviation", "blocker"]).optional(),
      },
    },
    async ({ message, kind = "progress" }) => {
      appendLine(eventsPath(jobId), { type: "message", kind, text: message });
      return text(`Delivered to Claude.${drainInbox()}`);
    },
  );

  server.registerTool(
    "check_inbox",
    {
      description:
        "Check whether Claude has sent you new instructions or corrections. Call this between major steps.",
      inputSchema: {},
    },
    async () => text(drainInbox().trim() || "No new messages from Claude."),
  );

  await server.connect(new StdioServerTransport());
}

// =====================================================================
// Claude side
// =====================================================================

const PREAMBLE = `You are working together with Claude, another AI coding agent who is the lead on this task.
You have an MCP server named "claude_bridge" with these tools:
  - ask_claude(question): blocks until Claude answers. Use it instead of guessing when something is ambiguous,
    when the plan does not cover a decision, or before deviating from the plan in a significant way.
  - message_claude(message, kind): non-blocking note to Claude (milestones, important findings, blockers).
  - check_inbox(): see if Claude has sent you corrections. Call it between major steps.
Do not spam Claude: a handful of messages per task is plenty.`;

const MODE_PROMPTS = {
  execute: `${PREAMBLE}

ROLE: Executor. Claude wrote the plan below; your job is to implement it faithfully in the working directory.
- Read the relevant code before changing it. Follow the plan's steps in order unless a dependency forces otherwise.
- If a step is wrong or impossible as written, ask_claude before deviating (or, for small things, deviate and message_claude kind="deviation").
- Run whatever verification the plan asks for (tests, build, lint) plus anything obviously needed.
- Final answer: (1) what you changed, file by file; (2) verification you ran and the results, verbatim for failures;
  (3) every deviation from the plan and why; (4) anything left undone or risky.`,

  review: `${PREAMBLE}

ROLE: Adversarial reviewer. Claude wrote the plan below. Your job is to find what is wrong with it, not to praise it.
Do NOT modify any files. Verify claims against the actual code and environment instead of trusting the plan.
Look hard for: false assumptions about the code, missing steps, wrong ordering or hidden dependencies, edge cases
and failure modes, data loss / migration / security / concurrency risks, untestable or unverified steps,
scope creep, and simpler alternatives that would achieve the same goal.
If something about intent is genuinely unclear, ask_claude; otherwise do not ask.
Final answer, in this format:
VERDICT: approve | approve-with-changes | reject
FINDINGS (most severe first), each with: severity (blocker/major/minor), what is wrong, evidence (file:line or command output), concrete fix.
If the plan is genuinely sound, say so plainly and list only the top residual risks; do not invent problems.`,

  freeform: PREAMBLE,
};

const DEFAULT_SANDBOX = { execute: "workspace-write", review: "read-only", freeform: "workspace-write" };

const running = new Map(); // jobId -> ChildProcess
const cursors = new Map(); // jobId -> number of events already shown to Claude

function getCursor(id) {
  if (!cursors.has(id)) cursors.set(id, readJson(path.join(jobDir(id), "claude.cursor"), 0));
  return cursors.get(id);
}
function setCursor(id, n) {
  cursors.set(id, n);
  writeJson(path.join(jobDir(id), "claude.cursor"), n);
}

function bridgeConfigArgs(jobId) {
  const prefix = "mcp_servers.claude_bridge";
  return [
    "-c", `${prefix}.command=${JSON.stringify(process.execPath)}`,
    "-c", `${prefix}.args=${JSON.stringify([SELF, "--role", "codex", "--job", jobId, "--home", ROOT])}`,
    "-c", `${prefix}.startup_timeout_sec=30`,
    "-c", `${prefix}.tool_timeout_sec=3700`,
    "-c", `${prefix}.default_tools_approval_mode="approve"`,
  ];
}

const IGNORED_ERROR = /ignoring \d+ unrecognized configuration setting/i;

function runTurn(jobId, prompt) {
  const meta = loadMeta(jobId);
  const common = [
    "--json",
    "--skip-git-repo-check",
    "-c", `sandbox_mode=${JSON.stringify(meta.sandbox)}`,
    ...bridgeConfigArgs(jobId),
    ...(meta.model ? ["-m", meta.model] : []),
    ...(meta.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(meta.effort)}`] : []),
  ];
  const args = meta.session_id
    ? ["exec", "resume", ...common, meta.session_id, "-"]
    : ["exec", ...common, "-C", meta.cwd, "-"];

  meta.status = "running";
  meta.turns = (meta.turns || 0) + 1;
  meta.updated = now();
  writeJson(metaPath(jobId), meta);

  const ev = eventsPath(jobId);
  appendLine(ev, { type: "turn_started", turn: meta.turns });

  const child = spawn(CODEX_BIN, args, { cwd: meta.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
  running.set(jobId, child);
  child.stdin.end(prompt);

  let buf = "";
  let lastMessage = null;
  let stderrTail = "";
  let failed = null;

  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "thread.started" && e.thread_id) {
        const m = loadMeta(jobId);
        if (!m.session_id) {
          m.session_id = e.thread_id;
          writeJson(metaPath(jobId), m);
        }
      } else if (e.type === "item.completed" && e.item) {
        const it = e.item;
        if (it.type === "agent_message") {
          lastMessage = it.text;
          appendLine(ev, { type: "progress", text: `codex: ${truncate(it.text, 400)}` });
        } else if (it.type === "command_execution") {
          appendLine(ev, { type: "progress", text: `ran (exit ${it.exit_code ?? "?"}): ${truncate(it.command, 200)}` });
        } else if (it.type === "file_change") {
          const files = (it.changes || []).map((c) => `${c.kind || "edit"} ${c.path}`).join(", ");
          appendLine(ev, { type: "progress", text: `files: ${files}` });
        } else if (it.type === "mcp_tool_call" && it.server !== "claude_bridge") {
          appendLine(ev, { type: "progress", text: `mcp: ${it.server}.${it.tool}` });
        } else if (it.type === "error" && !IGNORED_ERROR.test(it.message || "")) {
          appendLine(ev, { type: "progress", text: `error: ${truncate(it.message, 400)}` });
        }
      } else if (e.type === "turn.failed" || e.type === "error") {
        failed = e.error?.message || e.message || JSON.stringify(e);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  child.on("close", (code, signal) => {
    running.delete(jobId);
    const m = loadMeta(jobId);
    if (m.status === "cancelled") {
      appendLine(ev, { type: "turn_cancelled" });
    } else if (code === 0 && !failed) {
      m.status = "idle";
      appendLine(ev, { type: "turn_done", text: lastMessage ?? "(Codex produced no final message)" });
    } else {
      m.status = "failed";
      appendLine(ev, {
        type: "turn_failed",
        text: `exit ${code}${signal ? ` (${signal})` : ""}: ${failed || stderrTail.trim() || "unknown error"}`,
      });
    }
    m.updated = now();
    writeJson(metaPath(jobId), m);
  });
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const WAKE = new Set(["question", "message", "turn_done", "turn_failed", "turn_cancelled", "question_timeout"]);

function formatEvents(events) {
  const lines = [];
  // The final agent message is reported in full by turn_done; drop its truncated progress copy.
  const finals = new Set(events.filter((e) => e.type === "turn_done").map((e) => `codex: ${truncate(e.text, 400)}`));
  const progress = events.filter((e) => e.type === "progress" && !finals.has(e.text));
  if (progress.length) {
    const shown = progress.slice(-25);
    lines.push(`## Codex activity (${progress.length} events${progress.length > shown.length ? ", last 25 shown" : ""})`);
    for (const p of shown) lines.push(`- ${p.text}`);
  }
  for (const e of events) {
    if (e.type === "message") lines.push(`## Message from Codex [${e.kind}]\n${e.text}`);
    else if (e.type === "question")
      lines.push(`## QUESTION from Codex (question_id=${e.qid}) — Codex is blocked until you answer with codex_send\n${e.text}`);
    else if (e.type === "question_timeout") lines.push(`## Question ${e.qid} timed out; Codex proceeded on its own judgment.`);
    else if (e.type === "turn_done") lines.push(`## Codex finished the turn. Final answer:\n${e.text}`);
    else if (e.type === "turn_failed") lines.push(`## Codex turn FAILED\n${e.text}`);
    else if (e.type === "turn_cancelled") lines.push(`## Turn cancelled.`);
  }
  return lines.join("\n\n");
}

async function waitForEvents(jobId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const all = readLines(eventsPath(jobId));
    const fresh = all.slice(getCursor(jobId));
    if (fresh.some((e) => WAKE.has(e.type)) || Date.now() >= deadline) {
      setCursor(jobId, all.length);
      return fresh;
    }
    await sleep(1000);
  }
}

function statusLine(jobId) {
  const m = loadMeta(jobId);
  const pq = pendingQuestions(jobId);
  return (
    `job_id=${jobId}${m.name ? ` name=${m.name}` : ""} mode=${m.mode} status=${m.status} turns=${m.turns} sandbox=${m.sandbox}` +
    (m.session_id ? ` codex_session=${m.session_id}` : "") +
    (pq.length ? `\nPENDING QUESTIONS: ${pq.map((q) => q.qid).join(", ")}` : "")
  );
}

async function runClaudeSide() {
  fs.mkdirSync(JOBS, { recursive: true });
  // Turns started by a previous Claude session died with it; their Codex sessions can still be resumed.
  for (const m of allMetas()) {
    if (m.status === "running" || m.status === "starting") {
      m.status = m.session_id ? "idle" : "failed";
      writeJson(metaPath(m.id), m);
    }
  }
  const server = new McpServer({ name: "codex", version: "1.0.0" });

  server.registerTool(
    "codex_start",
    {
      description:
        "Start a Codex CLI agent on a task in the background and return a job_id. " +
        "mode=execute: Codex implements your plan (workspace-write). mode=review: Codex adversarially reviews your plan " +
        "against the real code without editing (read-only). mode=freeform: your prompt as-is. " +
        "Codex can ask you questions and send you messages while it works; follow up with codex_wait.",
      inputSchema: {
        mode: z.enum(["execute", "review", "freeform"]),
        name: z
          .string()
          .optional()
          .describe('Optional handle such as "reviewer" or "executor"; usable wherever job_id is expected. Reusing a name points it at the new job.'),
        cwd: z.string().describe("Absolute path of the project directory Codex works in."),
        plan: z.string().optional().describe("The plan text (or the task for freeform)."),
        plan_file: z.string().optional().describe("Path to a plan file Codex should read instead of / in addition to `plan`."),
        instructions: z.string().optional().describe("Extra instructions: focus areas, constraints, what not to touch."),
        sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
        model: z.string().optional().describe("Codex model override; default is the user's Codex config."),
        effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional().describe("Codex reasoning effort override."),
        wait_sec: z.number().int().min(0).max(1800).optional().describe("Block this long for the first events (default 0)."),
      },
    },
    async ({ mode, name, cwd, plan, plan_file, instructions, sandbox, model, effort, wait_sec = 0 }) => {
      if (!plan && !plan_file) throw new Error("Provide `plan` and/or `plan_file`.");
      if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
      const id = newId();
      fs.mkdirSync(path.join(jobDir(id), "answers"), { recursive: true });
      writeJson(metaPath(id), {
        id,
        name,
        mode,
        cwd: path.resolve(cwd),
        sandbox: sandbox || DEFAULT_SANDBOX[mode],
        model,
        effort,
        status: "starting",
        turns: 0,
        created: now(),
      });
      const parts = [MODE_PROMPTS[mode]];
      if (plan_file) parts.push(`The plan is in this file; read it fully first: ${path.resolve(cwd, plan_file)}`);
      if (plan) parts.push(`=== PLAN (from Claude) ===\n${plan}\n=== END PLAN ===`);
      if (instructions) parts.push(`Additional instructions from Claude:\n${instructions}`);
      runTurn(id, parts.join("\n\n"));
      let body = `Started.\n${statusLine(id)}\nUse codex_wait to receive Codex's questions, messages and final answer.`;
      if (wait_sec > 0) {
        const events = await waitForEvents(id, wait_sec);
        body = `${statusLine(id)}\n\n${formatEvents(events) || "(no events yet)"}`;
      }
      return text(body);
    },
  );

  server.registerTool(
    "codex_wait",
    {
      description:
        "Wait for news from a Codex job. Returns as soon as Codex asks a question, sends a message, or finishes/fails its turn " +
        "(or when timeout_sec elapses), with a digest of what Codex did in the meantime.",
      inputSchema: {
        job_id: z.string().describe("Job id or job name."),
        timeout_sec: z.number().int().min(1).max(1800).optional().describe("Default 300."),
      },
    },
    async ({ job_id, timeout_sec = 300 }) => {
      job_id = resolveJob(job_id);
      const events = await waitForEvents(job_id, timeout_sec);
      const body = formatEvents(events) || `(nothing new in ${timeout_sec}s; Codex is still working — call codex_wait again)`;
      return text(`${statusLine(job_id)}\n\n${body}`);
    },
  );

  server.registerTool(
    "codex_send",
    {
      description:
        "Send something to Codex. With question_id: answers Codex's blocking question. " +
        "Without it, while Codex is running: queues a message delivered on Codex's next bridge call (corrections, extra instructions). " +
        "Without it, after the turn ended: starts a new turn in the same Codex session (follow-ups, rebuttals to review findings, 'now fix X').",
      inputSchema: {
        job_id: z.string().describe("Job id or job name."),
        message: z.string(),
        question_id: z.string().optional(),
      },
    },
    async ({ job_id, message, question_id }) => {
      job_id = resolveJob(job_id);
      const meta = loadMeta(job_id);
      if (question_id) {
        if (fs.existsSync(answerPath(job_id, question_id))) throw new Error(`Question ${question_id} was already answered.`);
        writeJson(answerPath(job_id, question_id), { ts: now(), text: message });
        return text(`Answer delivered; Codex will continue.\n${statusLine(job_id)}`);
      }
      if (running.has(job_id)) {
        appendLine(inboxPath(job_id), { text: message });
        return text(`Queued; Codex receives it on its next claude_bridge tool call.\n${statusLine(job_id)}`);
      }
      if (!meta.session_id) throw new Error("This job has no Codex session to resume.");
      runTurn(job_id, message);
      return text(`New turn started in the same Codex session.\n${statusLine(job_id)}`);
    },
  );

  server.registerTool(
    "codex_cancel",
    {
      description: "Stop a running Codex job.",
      inputSchema: { job_id: z.string().describe("Job id or job name.") },
    },
    async ({ job_id }) => {
      job_id = resolveJob(job_id);
      const meta = loadMeta(job_id);
      const child = running.get(job_id);
      if (!child) return text(`Not running.\n${statusLine(job_id)}`);
      meta.status = "cancelled";
      writeJson(metaPath(job_id), meta);
      child.kill("SIGTERM");
      setTimeout(() => running.has(job_id) && child.kill("SIGKILL"), 5000).unref();
      return text(`Cancelling.\n${statusLine(job_id)}`);
    },
  );

  server.registerTool(
    "codex_jobs",
    {
      description: "List Codex jobs (most recent first).",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit = 10 }) => {
      const ids = allMetas()
        .slice(0, limit)
        .map((m) => `${m.created}  ${statusLine(m.id).split("\n")[0]}  cwd=${m.cwd}`);
      return text(ids.join("\n") || "No jobs yet.");
    },
  );

  const shutdown = () => {
    for (const child of running.values()) child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(new StdioServerTransport());
}

if (argOf("--role") === "codex") await runCodexSide(argOf("--job"));
else await runClaudeSide();
