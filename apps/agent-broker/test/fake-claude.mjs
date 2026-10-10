#!/usr/bin/env node
// Stand-in for the Claude CLI in the broker tests. The mode comes from
// $CLAUDE_CONFIG_DIR/fake-mode because the broker passes no other environment.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const configDir = process.env.CLAUDE_CONFIG_DIR || "/nonexistent";
let mode = "ok";
try { mode = fs.readFileSync(path.join(configDir, "fake-mode"), "utf8").trim(); } catch { /* default */ }
const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log(mode === "noversion" ? "unknown build" : "9.9.9 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: mode !== "loggedout", authMethod: "oauth_token" }));
  process.exit(0);
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const at = args.indexOf("--tools");
  const tools = at >= 0 ? args[at + 1].split(",").filter(Boolean) : ["Bash"];
  const model = args[args.indexOf("--model") + 1];
  fs.writeFileSync(path.join(configDir, "last-call.json"), JSON.stringify({
    args, stdin: input, tokenPresent: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), runMarker: process.env.COCKPIT_AGENT_RUN_ID || null,
    envKeys: Object.keys(process.env).sort(),
  }));
  if (mode === "exit2") process.exit(2);
  if (mode === "noinit") {
    emit({ type: "result", subtype: "success", is_error: false, result: "VERDICT: approve" });
    process.exit(0);
  }
  emit({ type: "system", subtype: "init", tools: mode === "wrongtools" ? [...tools, "WebFetch"] : tools, mcp_servers: [], model: `claude-${model}-test` });
  if (mode === "hang") {
    const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
    fs.writeFileSync(path.join(configDir, "pids.json"), JSON.stringify({ self: process.pid, grandchild: grandchild.pid }));
    process.on("SIGTERM", () => { /* ignore: forces the SIGKILL escalation */ });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "wrongtools") { setInterval(() => {}, 1000); return; }
  if (mode === "leftover") {
    // A grandchild in the same process group that outlives a successful run.
    const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
    fs.writeFileSync(path.join(configDir, "pids.json"), JSON.stringify({ self: process.pid, grandchild: grandchild.pid }));
    grandchild.unref();
  }
  if (mode === "autherr") {
    emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    process.exit(1);
  }
  emit({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: `VERDICT: approve\nNOTES: ${input.length} chars` });
  process.exit(0);
});
