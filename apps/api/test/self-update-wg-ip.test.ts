import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// cockpit-self-update-run checks the web chain only when the instance's WireGuard
// address is up. Lab0 is 10.0.0.5, box 10.0.0.6: the address comes from web_url.

const RUNNER = fileURLToPath(new URL("../../../deploy/helpers/cockpit-self-update-run", import.meta.url));

function wgIpFor(webUrl: string, env: Record<string, string> = {}) {
  const code = [
    "import importlib.machinery, importlib.util, sys",
    `loader = importlib.machinery.SourceFileLoader("runner", ${JSON.stringify(RUNNER)})`,
    "spec = importlib.util.spec_from_loader('runner', loader)",
    "module = importlib.util.module_from_spec(spec); loader.exec_module(module)",
    "print(module.wg_ip_for(sys.argv[1]))",
  ].join("\n");
  const out = spawnSync("python3", ["-c", code, webUrl], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.trim();
}

describe("cockpit-self-update-run: WireGuard address of the web check", () => {
  it("takes the host of web_url inside the WireGuard net", () => {
    expect(wgIpFor("https://10.0.0.6:8180")).toBe("10.0.0.6");
    expect(wgIpFor("https://10.0.0.5:8180")).toBe("10.0.0.5");
  });

  it("falls back to the Lab0 address for anything else, and the harness override wins", () => {
    expect(wgIpFor("http://127.0.0.1:18181")).toBe("10.0.0.5");
    expect(wgIpFor("https://cockpit.example:8180")).toBe("10.0.0.5");
    expect(wgIpFor("https://10.0.0.6:8180", { COCKPIT_SELF_UPDATE_WG_IP: "10.0.0.9" })).toBe("10.0.0.9");
  });
});
