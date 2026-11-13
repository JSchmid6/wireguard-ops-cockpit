import { describe, expect, it } from "vitest";
import { brokerSocketForRole } from "../src/agent-broker.js";
import { loadConfig } from "../src/config.js";

// The runner (opencode build) has its own identity, home and socket; the plan
// roles' broker never serves it (card t_cb81637b).
describe("brokerSocketForRole", () => {
  const isolated = { agentBrokerSocket: "/run/cockpit-agent/agent.sock", runnerBrokerSocket: "/run/cockpit-runner/runner.sock" };

  it("sends the plan roles to the agent broker and the runner to its own", () => {
    for (const role of ["planner", "research", "safety", "verifier"] as const) {
      expect(brokerSocketForRole(isolated, role)).toBe("/run/cockpit-agent/agent.sock");
    }
    expect(brokerSocketForRole(isolated, "runner")).toBe("/run/cockpit-runner/runner.sock");
  });

  it("refuses the runner without its own broker instead of falling back to the agent broker", () => {
    for (const runnerBrokerSocket of [null, undefined, ""]) {
      expect(() => brokerSocketForRole({ agentBrokerSocket: isolated.agentBrokerSocket, runnerBrokerSocket }, "runner"))
        .toThrow(/the runner needs its own broker identity \(COCKPIT_RUNNER_BROKER_SOCKET\)/);
    }
    expect(brokerSocketForRole({ agentBrokerSocket: isolated.agentBrokerSocket, runnerBrokerSocket: null }, "safety")).toBe(isolated.agentBrokerSocket);
  });

  it("refuses every role without the agent broker", () => {
    expect(() => brokerSocketForRole({ agentBrokerSocket: null, runnerBrokerSocket: isolated.runnerBrokerSocket }, "runner")).toThrow(/not configured/);
  });

  it("reads the runner socket from COCKPIT_RUNNER_BROKER_SOCKET (the API drop-in sets it)", () => {
    expect(loadConfig({}).runnerBrokerSocket).toBeNull();
    expect(loadConfig({ COCKPIT_RUNNER_BROKER_SOCKET: " /run/cockpit-runner/runner.sock " }).runnerBrokerSocket).toBe("/run/cockpit-runner/runner.sock");
  });
});
