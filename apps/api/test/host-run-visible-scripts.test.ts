import { describe, expect, it } from "vitest";

import {
  backupGuardFocus,
  hiddenPinnedScripts,
  hostRunPlannerContract,
  intentHostRunManifest,
  parseHostRunManifest,
} from "../src/host-run.js";

// Job 26fb0860 (Karte t_ff43a907 → t_41cb8b49): an hourly root service ran a
// script the run only pinned by hash. The unit file was written literally in a
// heredoc, the script was not — the doorkeeper saw a hash and flagged X5
// ("Hourly root service executes a script whose source is not in the review
// material"). The planner stage now refuses such a plan; the literal heredoc
// passes.

const HASH = "3f1c6a0d9b2e47c8a5f0e1d2c3b4a59687f6e5d4c3b2a1908f7e6d5c4b3a2918";
const SCRIPT = "/usr/local/lib/cockpit-watch/hourly-check.py";

const unitStep = {
  name: "units",
  run: [
    "cat > /etc/systemd/system/cockpit-watch.service <<'EOF'",
    "[Unit]",
    "Description=hourly check",
    "[Service]",
    "Type=oneshot",
    `ExecStart=/usr/bin/python3 ${SCRIPT}`,
    "EOF",
    "cat > /etc/systemd/system/cockpit-watch.timer <<'EOF'",
    "[Timer]",
    "OnCalendar=hourly",
    "[Install]",
    "WantedBy=timers.target",
    "EOF",
    "systemctl daemon-reload",
    "systemctl enable --now cockpit-watch.timer",
  ].join("\n"),
  timeoutSeconds: 120,
};

function manifest(steps: unknown[]) {
  return {
    version: "cockpit-host-run/v1",
    name: "Stündliche Prüfung",
    purpose: "Install an hourly root check as a systemd timer.",
    steps,
    checks: [{ name: "timer active", run: "systemctl is-active cockpit-watch.timer" }],
    rollback: ["systemctl disable --now cockpit-watch.timer && rm /etc/systemd/system/cockpit-watch.*"],
  };
}

function plan(value: unknown): string {
  return ["## Intent", "hourly check", "", "```host-run", JSON.stringify(value), "```"].join("\n");
}

// The recorded shape: the script was deployed earlier and is only pinned here.
const hashOnly = manifest([
  { name: "pin script", run: `printf '%s  %s\\n' '${HASH}' '${SCRIPT}' | sha256sum -c -`, timeoutSeconds: 60 },
  unitStep,
]);

const literal = manifest([
  {
    name: "script",
    run: [
      `install -d -m 0755 ${SCRIPT.replace(/\/[^/]+$/, "")}`,
      `cat > ${SCRIPT} <<'EOF'`,
      "#!/usr/bin/python3",
      "import shutil",
      "print(shutil.disk_usage('/').free)",
      "EOF",
      `chmod 0755 ${SCRIPT}`,
      `printf '%s  %s\\n' '${HASH}' '${SCRIPT}' | sha256sum -c -`,
    ].join("\n"),
    timeoutSeconds: 60,
  },
  unitStep,
]);

describe("hash-pinned scripts the run does not show", () => {
  it("reproduces job 26fb0860: before the fix the hash-only script was only a focus pointer, the doorkeeper had to flag X5", () => {
    // What the doorkeeper got before: a non-binding hint, not the code.
    const hint = backupGuardFocus(hashOnly).find((item) => item.reason.includes("content this plan does not show"));
    expect(hint?.code).toContain(SCRIPT);
    // The new deterministic check names the script, where it runs and where it is pinned.
    expect(hiddenPinnedScripts(hashOnly as never)).toEqual([{ path: SCRIPT, pinnedAt: "S1:L1", executedAt: "S2:L6" }]);
  });

  it("refuses the hash-only plan in the planner stage, naming the field and the way out", () => {
    expect(() => parseHostRunManifest(plan(hashOnly))).toThrow(
      new RegExp(`runs a script it only pins by hash.*${SCRIPT.replace(/[.]/g, "\\.")} \\(runs at S2:L6, pinned at S1:L1\\).*field steps\\[\\]\\.run must write.*heredoc`),
    );
  });

  it("refuses it in the operator's intent manifest as well", () => {
    expect(() => intentHostRunManifest(plan(hashOnly))).toThrow(/the intent's host-run manifest is invalid: .*only pins by hash/);
  });

  it("passes the literal heredoc with a hash check after it, and the doorkeeper sees the code", () => {
    const parsed = parseHostRunManifest(plan(literal));
    expect(parsed?.steps).toHaveLength(2);
    expect(hiddenPinnedScripts(parsed!)).toEqual([]);
    expect(parsed!.steps[0].run).toContain("print(shutil.disk_usage('/').free)");
    expect(backupGuardFocus(parsed!).filter((item) => item.reason.includes("content this plan does not show"))).toEqual([]);
  });

  it("catches what the guard lets through: a pinned program below a system prefix, run directly or by an interpreter", () => {
    const tool = "/usr/local/bin/hourly-check";
    for (const run of [`${tool} --quiet`, `timeout 60 ${tool}`, `bash ${tool}`, `if ${tool}; then echo ok; fi`]) {
      const value = manifest([{ name: "pin", run: `echo "${HASH}  ${tool}" | sha256sum -c -` }, { name: "run", run }]);
      expect(() => parseHostRunManifest(plan(value)), run).toThrow(/only pins by hash/);
    }
  });

  it("catches a digest on another line of the same script", () => {
    const value = manifest([{ name: "pin and run", run: `EXPECTED=${HASH}\n[ "$(sha256sum ${SCRIPT} | cut -d' ' -f1)" = "$EXPECTED" ]\npython3 ${SCRIPT}` }]);
    expect(hiddenPinnedScripts(value as never)).toEqual([{ path: SCRIPT, pinnedAt: "S1:L2", executedAt: "S1:L3" }]);
  });

  it("leaves a verified download that is only unpacked, and a script without a pin, alone", () => {
    const download = manifest([{ name: "fetch", run: `curl -fsSLo /tmp/tool.tar.gz https://example.org/tool.tar.gz\nprintf '${HASH}  /tmp/tool.tar.gz\\n' | sha256sum -c -\ntar -xzf /tmp/tool.tar.gz -C /opt/tool` }]);
    expect(parseHostRunManifest(plan(download))?.steps).toHaveLength(1);
    const unpinned = manifest([{ name: "run", run: `python3 ${SCRIPT}` }]);
    expect(parseHostRunManifest(plan(unpinned))?.steps).toHaveLength(1);
  });

  it("tells the planner the rule", () => {
    expect(hostRunPlannerContract()).toMatch(/Every script the run executes .* must appear literally .*heredoc.*Pinning it only by hash .* is refused before review/);
  });
});
