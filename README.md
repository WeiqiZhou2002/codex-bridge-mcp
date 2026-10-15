# codex-bridge-mcp

A two-way MCP bridge that lets **Claude Code** drive the **Codex CLI**, and lets Codex talk back.

- Claude writes a plan → Codex **executes** it, or **adversarially reviews** it against the real code.
- While working, Codex can **ask Claude questions** (and block until answered) or **send progress / findings**.
- Claude can answer, send corrections mid-run, or start follow-up turns in the same Codex session.
- Keep several named Codex sessions per project, e.g. a `reviewer` on high effort and an `executor` on a cheaper setting.

```
Claude Code ──MCP "codex"──▶ server.mjs ──spawns──▶ codex exec --json
     ▲                          │                       │
     │                   ~/.codex-bridge/jobs/<id>/     │ MCP "claude_bridge"
     └──── codex_wait ◀──────── mailbox ◀───────────────┘ (injected per job)
```

## Requirements

- Node.js 18+
- [Codex CLI](https://github.com/openai/codex), logged in (`codex login`). Tested with codex-cli 0.162.
- Claude Code

## Install

```bash
git clone https://github.com/WeiqiZhou2002/codex-bridge-mcp.git
cd codex-bridge-mcp && npm install
claude mcp add codex -s user -- node "$PWD/server.mjs"
```

Then start a new Claude Code session. `claude mcp list` should show `codex ✔ Connected`.

## Usage

Just ask Claude in plain language:

> Start a Codex reviewer on xhigh and have it adversarially review `plans/plan-v3.md`.

> Start a Codex executor on high to implement the plan; it should ask me if anything is unclear.

> Tell the reviewer that finding #2 is wrong because the cache is per-request, and ask it to re-check.

### Tools Claude gets (server `codex`)

| Tool | What it does |
|---|---|
| `codex_start` | Start a job in the background. `mode`: `execute` (implement the plan, `workspace-write`), `review` (adversarial review, `read-only`), `freeform`. Takes `plan` text and/or `plan_file`, optional `name`, `model`, `effort` (`minimal`…`xhigh`), `sandbox`, `instructions`. |
| `codex_wait` | Block until Codex asks a question, sends a message, or finishes/fails its turn. Returns a digest of the commands it ran and files it changed. |
| `codex_send` | With `question_id`: answer a blocking question. While Codex is running: queue a message it receives on its next bridge call. After the turn ended: start a new turn in the same Codex session. |
| `codex_cancel` | Stop a running job. |
| `codex_jobs` | List jobs with status, name, session and cwd. |

Anywhere a `job_id` is expected you can pass the job's `name` instead; the newest job with that name wins.
A job's model, effort and sandbox are fixed at start and reused by every follow-up turn.

### Tools Codex gets (server `claude_bridge`, injected via `-c` per job)

| Tool | What it does |
|---|---|
| `ask_claude(question)` | Blocks until Claude answers (default timeout 30 min; on timeout Codex proceeds and states its assumption). |
| `message_claude(message, kind)` | Non-blocking note: `progress`, `finding`, `deviation`, `blocker`. |
| `check_inbox()` | Pick up corrections Claude queued. Queued messages are also appended to any bridge tool result. |

Your normal `~/.codex/config.toml` (default model, other MCP servers, etc.) still applies.

## How it works

Each job gets a directory under `~/.codex-bridge/jobs/<id>/` (override with `CODEX_BRIDGE_HOME`):

- `events.jsonl`: Codex → Claude. Questions, messages, a digest parsed from `codex exec --json`, turn results.
- `answers/<qid>.json`: Claude → Codex answers to `ask_claude`.
- `inbox.jsonl`: Claude → Codex unsolicited messages.

Follow-up turns use `codex exec resume <session_id>`. Job metadata persists on disk, so a later Claude session can keep talking to the same Codex session. Turns that were running when the previous Claude session exited are marked resumable.

## Caveats

- `execute` mode lets Codex write inside the working directory. `danger-full-access` is only used if you ask for it explicitly.
- In Codex's `workspace-write` sandbox, Codex usually cannot write to `.git`, so let Claude (or you) do the commits.
- Codex's `--json` event format is not a stable API. If a Codex upgrade changes it, the activity digest may get thinner, but final answers still come through.
- Two jobs in the same folder do not share context. Claude relays between them.

## Development

```bash
npm test
```

The tests drive the server through a real MCP client against a fake `codex` binary (`test/fake-codex.mjs`), so they are fast and don't spend tokens. Set `CODEX_BIN` to point the bridge at a different Codex executable.

## License

MIT
