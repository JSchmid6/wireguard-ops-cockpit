import { setTimeout as sleep } from "node:timers/promises";

function readFlag(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

const agentId = readFlag("--agent-id");
const agentName = readFlag("--agent-name");
const integration = readFlag("--integration");
const prompt = readFlag("--prompt");

console.log(`${agentName || "Demo context agent"} starting.`);
if (agentId) {
  console.log(`Agent id: ${agentId}`);
}
if (integration) {
  console.log(`Integration: ${integration}`);
}
if (prompt) {
  console.log(`Prompt: ${prompt}`);
}
console.log("This launcher is repo-local and intentionally non-privileged.");
await sleep(250);
console.log(`${agentName || "Demo context agent"} finished.`);
