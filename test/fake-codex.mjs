#!/usr/bin/env node
// Stand-in for `codex exec --json` used by the tests. Echoes the prompt as the final answer.
// A prompt containing "SLOW" makes the turn take 1.5s, leaving room to queue messages mid-turn.
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", async () => {
  const emit = (e) => process.stdout.write(JSON.stringify(e) + "\n");
  emit({ type: "thread.started", thread_id: "00000000-fake-session" });
  emit({ type: "turn.started" });
  if (prompt.includes("SLOW")) await new Promise((r) => setTimeout(r, 1500));
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: `ECHO: ${prompt.slice(-200)}` } });
  emit({ type: "turn.completed", usage: {} });
});
