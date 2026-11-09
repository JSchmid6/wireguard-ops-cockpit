import { readFileSync } from "node:fs";

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

// Befund t_740ac6ee (Zweitprüfung PR #72), Nacharbeit t_11872429: every case of
// the probe /opt/data/out/t_740ac6ee/probe-run.ts. Step 1 pins the script,
// step 2 runs it in the shown form.
describe("hash-pinned scripts: fail safe recognition (Befund t_740ac6ee)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const hidden = (...runs: string[]) => hiddenPinnedScripts(manifest(runs.map((run, index) => ({ name: `s${index + 1}`, run }))) as never);

  const runForms: Record<string, string> = {
    "sh -c": `sh -c '${P} --flag'`,
    "ExecStart sh -c": `ExecStart=/bin/sh -c '${P}'`,
    "sudo -u": `sudo -u root ${P}`,
    "runuser -u --": `runuser -u nobody -- ${P}`,
    "su -c": `su -c ${P}`,
    "flock lock": `flock /run/x.lock ${P}`,
    "python -W": `python3 -W ignore ${P}`,
    "perl -I": `perl -I /opt/lib ${P}`,
    "awk -f": `awk -f ${P} /etc/passwd`,
    "fish": `fish ${P}`,
    "relative after cd": `cd /opt/x && ./run.sh`,
    "bare name after cd": `cd /opt/x\nbash run.sh`,
    "double slash": `/opt/x//run.sh`,
    "comment trick": `: '#' ; ${P}`,
    "printf unit": `printf '[Service]\\nExecStart=${P}\\n' > /etc/systemd/system/x.service`,
    "plain": `${P}`,
    "env": `env -i FOO=1 ${P}`,
    "nsenter": `nsenter -t 1 -m ${P}`,
    "xargs": `echo a | xargs ${P}`,
    "find -exec": `find /tmp -name x -exec ${P} {} \;`,
    "piped into a shell": `cat ${P} | bash`,
    "process substitution": `bash <(cat ${P})`,
    "command substitution as command": `$(cat ${P})`,
    "eval": `eval "$(cat ${P})"`,
    "variable": `RUN=${P}\n"$RUN"`,
    "copy under another name": `cp ${P} /usr/local/bin/x\n/usr/local/bin/x`,
    "symlink": `ln -s ${P} /usr/local/bin/x\n/usr/local/bin/x`,
    "cat into another file": `cat ${P} > /tmp/y\nbash /tmp/y`,
    "exec": `exec ${P}`,
    "dot": `. ${P}`,
    "piped into sudo bash": `cat ${P} | sudo bash`,
    "sh -c with substitution": `sh -c "$(cat ${P})"`,
  };
  for (const [label, run] of Object.entries(runForms)) {
    it(`recognises the run form: ${label}`, () => {
      expect(hidden(pin, run).map((item) => item.path)).toHaveLength(1);
    });
  }

  it("refuses sudo -u in the planner stage (the doc's \"behind sudo\")", () => {
    expect(() => parseHostRunManifest(plan(manifest([{ name: "pin", run: pin }, { name: "run", run: `sudo -u root ${P}` }])))).toThrow(/only pins by hash/);
  });

  it("does not count an append to an unseen file as written (cat >> … <<EOF)", () => {
    expect(hidden(`cat >> ${P} <<'EOF'\n# x\nEOF\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L4", executedAt: "S1:L5" }]);
  });

  it("keeps an append to a script this run wrote literally", () => {
    expect(hidden(`cat > ${P} <<'EOF'\necho hi\nEOF\ncat >> ${P} <<'EOF'\necho more\nEOF\n${pin}\n${P}`)).toEqual([]);
  });

  for (const overwrite of [`cp /srv/other.sh ${P}`, `mv /srv/other.sh ${P}`, `install -m 0755 /srv/other.sh ${P}`, `curl -fsSLo ${P} https://example.org/x.sh`, `wget -O ${P} https://example.org/x.sh`, `cat /srv/other.sh > ${P}`, `cp /srv/run.sh /opt/x/`, `tar -xzf /srv/x.tgz -C /opt/x`]) {
    it(`takes the heredoc back when the run overwrites it afterwards: ${overwrite}`, () => {
      expect(hidden(`cat > ${P} <<'EOF'\necho hi\nEOF\n${overwrite}\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L5", executedAt: "S1:L6", overwrittenAt: "S1:L4" }]);
    });
  }

  it("names the overwrite in the planner stage", () => {
    expect(() => parseHostRunManifest(plan(manifest([{ name: "s", run: `cat > ${P} <<'EOF'\necho hi\nEOF\ncp /srv/other.sh ${P}\n${pin}\n${P}` }])))).toThrow(/overwritten at S1:L4/);
  });

  it("counts install -m 0755 /dev/stdin <path> with a heredoc as written literally", () => {
    expect(hidden(`install -m 0755 /dev/stdin ${P} <<'EOF'\necho hi\nEOF\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`install -m 0755 -o root -g root /dev/stdin ${P} <<'EOF'\necho hi\nEOF\n${pin}\nsudo -u root ${P}`)).toEqual([]);
  });

  it("counts tee with a heredoc and a literal printf as written, a copy of a literal script as visible", () => {
    expect(hidden(`tee ${P} >/dev/null <<'EOF'\necho hi\nEOF\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`printf '#!/bin/sh\\necho hi\\n' > ${P}\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`cat > /tmp/run.sh <<'EOF'\necho hi\nEOF\ninstall -m 0755 /tmp/run.sh ${P}\n${pin}\n${P}`)).toEqual([]);
  });

  it("does not take a printf with expansion as literal content", () => {
    expect(hidden(`printf '%s\\n' "$BODY" > ${P}\n${pin}\n${P}`)).toHaveLength(1);
  });

  it("leaves commands that do not run the pinned file alone", () => {
    expect(hidden(pin, `chmod 0755 ${P}\nchown root:root ${P}\nstat ${P}\ntest -x ${P}\n[ -f ${P} ] && ls -l ${P}\nrm -f ${P}\ncp ${P} /var/backups/run.sh.bak`)).toEqual([]);
  });

  it("does not count an informational sha256sum next to an unrelated digest as a pin (docker pull img@sha256)", () => {
    expect(hidden(`docker pull img@sha256:${HASH}\nsha256sum /usr/local/bin/tool\n/usr/local/bin/tool --version`)).toEqual([]);
  });

  it("counts a checksum file the run writes and checks as a pin", () => {
    expect(hidden(`cat > /tmp/sums <<'EOF'\n${HASH}  ${P}\nEOF\nsha256sum -c /tmp/sums`, P)).toEqual([{ path: P, pinnedAt: "S1:L2", executedAt: "S2:L1" }]);
  });

  it("counts a pin relative to cd", () => {
    expect(hidden(`cd /opt/x && echo "${HASH}  run.sh" | sha256sum -c -`, P)).toEqual([{ path: P, pinnedAt: "S1:L1", executedAt: "S2:L1" }]);
  });

  it("does not refuse a release binary this run downloads and checks (no reason to drop the hash)", () => {
    const run = `curl -fsSLo /usr/local/bin/restic https://example.org/restic\necho "${HASH}  /usr/local/bin/restic" | sha256sum -c -\nchmod +x /usr/local/bin/restic\n/usr/local/bin/restic version`;
    expect(hidden(run)).toEqual([]);
    expect(parseHostRunManifest(plan(manifest([{ name: "restic", run }])))?.steps).toHaveLength(1);
    expect(hidden(`wget -qO /usr/local/bin/tool https://example.org/tool\necho "${HASH}  /usr/local/bin/tool" | sha256sum -c -\n/usr/local/bin/tool --version`)).toEqual([]);
  });

  it("still refuses a downloaded script: its code can be shown", () => {
    expect(hidden(`curl -fsSLo /tmp/install.sh https://example.org/install.sh\necho "${HASH}  /tmp/install.sh" | sha256sum -c -\nbash /tmp/install.sh`)).toHaveLength(1);
    expect(hidden(`curl -fsSLo /tmp/installer https://example.org/installer\necho "${HASH}  /tmp/installer" | sha256sum -c -\nsh /tmp/installer`)).toHaveLength(1);
  });

  it("does not refuse the integrity check of a Cockpit helper the deploy installed", () => {
    const run = `echo "${HASH}  /usr/local/sbin/cockpit-borg-retention" | sha256sum -c -\n/usr/local/sbin/cockpit-borg-retention status`;
    expect(hidden(run)).toEqual([]);
    expect(parseHostRunManifest(plan(manifest([{ name: "helper", run }])))?.steps).toHaveLength(1);
  });

  it("leaves the recorded plans of 10.10.2026 alone (a git commit id on a git line is no checksum)", () => {
    const recorded = JSON.parse(readFileSync(new URL("./fixtures/host-run-plans-2026-10-10.json", import.meta.url), "utf8")) as Record<string, { manifest: { steps: never[]; checks?: never[] } }>;
    for (const [name, { manifest: value }] of Object.entries(recorded)) {
      expect(hiddenPinnedScripts({ steps: value.steps, checks: value.checks || [] }), name).toEqual([]);
    }
  });

  it("refuses a deployed helper's path once the run overwrites it with content it does not show", () => {
    expect(hidden(`cp /tmp/x /usr/local/sbin/cockpit-borg-retention\necho "${HASH}  /usr/local/sbin/cockpit-borg-retention" | sha256sum -c -\n/usr/local/sbin/cockpit-borg-retention status`)).toHaveLength(1);
  });
});
