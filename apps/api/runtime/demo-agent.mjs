import { setTimeout as sleep } from "node:timers/promises";

const promptIndex = process.argv.indexOf("--prompt");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] || "" : "";

console.log("Demo context agent starting.");
if (prompt) {
  console.log(`Prompt: ${prompt}`);
}
console.log("This demo process is repo-local and intentionally non-privileged.");
await sleep(250);
console.log("Demo context agent finished.");

