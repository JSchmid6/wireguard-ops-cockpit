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

// Befund t_af29564c (Zweitprüfung Runde 2), Nacharbeit 2 t_0e05c213: the cases of
// /opt/data/out/t_af29564c/gegen2.ts and the comment of t_ae973907.
describe("hash-pinned scripts: PATH names, continued lines, sed -i (Befund t_af29564c)", () => {
  const P = "/opt/x/run.sh";
  const W = "/usr/local/sbin/wartung";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const hidden = (...runs: string[]) => hiddenPinnedScripts(manifest(runs.map((run, index) => ({ name: `s${index + 1}`, run }))) as never);

  it("N1: recognises a pinned program in a PATH directory run by its bare name", () => {
    expect(hidden(`echo "${HASH}  ${W}" | sha256sum -c - && wartung`)).toEqual([{ path: W, pinnedAt: "S1:L1", executedAt: "S1:L1" }]);
  });

  it("N1: recognises the bare name behind sudo, runuser and su", () => {
    for (const run of ["sudo wartung --jetzt", "sudo -u root wartung", "runuser -u nobody -- wartung", "su -c wartung"]) {
      expect(hidden(`echo "${HASH}  ${W}" | sha256sum -c -`, run), run).toEqual([{ path: W, pinnedAt: "S1:L1", executedAt: "S2:L1" }]);
    }
  });

  it("N1: recognises ExecStart=name in a unit written by heredoc", () => {
    expect(hidden(`echo "${HASH}  /usr/local/bin/wartung" | sha256sum -c -`, `cat > /etc/systemd/system/w.service <<'EOF'\n[Service]\nExecStart=wartung\nEOF`))
      .toEqual([{ path: "/usr/local/bin/wartung", pinnedAt: "S1:L1", executedAt: "S2:L3" }]);
  });

  it("N1: recognises a symlink into a PATH directory run by its name", () => {
    expect(hidden(pin, `ln -s ${P} /usr/local/bin/runit`, "runit")).toEqual([{ path: "/usr/local/bin/runit", pinnedAt: "S1:L1", executedAt: "S3:L1" }]);
  });

  it("N1: recognises a copy into a PATH directory run by its name", () => {
    expect(hidden(pin, `cp ${P} /usr/local/bin/`, "run.sh")).toEqual([{ path: "/usr/local/bin/run.sh", pinnedAt: "S1:L1", executedAt: "S3:L1" }]);
  });

  it("N1: refuses the bare name in the planner stage", () => {
    expect(() => parseHostRunManifest(plan(manifest([{ name: "pin", run: `echo "${HASH}  ${W}" | sha256sum -c -` }, { name: "run", run: "sudo wartung --jetzt" }])))).toThrow(/only pins by hash/);
  });

  it("N1: keeps the bare name of a deployed Cockpit helper free and leaves names outside PATH directories alone", () => {
    expect(hidden(`echo "${HASH}  /usr/local/sbin/cockpit-borg-retention" | sha256sum -c -\ncockpit-borg-retention status`)).toEqual([]);
    expect(hidden(pin, "run.sh")).toEqual([]);
  });

  it("N2: sees an overwrite after the heredoc that a continued line splits", () => {
    expect(hidden(`cat > ${P} <<'EOF'\necho hi\nEOF\ninstall -m 0755 -o root -g root \\\n  /srv/repo/run.sh ${P}`, pin, P))
      .toEqual([{ path: P, pinnedAt: "S2:L1", executedAt: "S3:L1", overwrittenAt: "S1:L4" }]);
  });

  it("N2: recognises a pinned script piped into a shell on a continued line", () => {
    expect(hidden(pin, `cat ${P} \\\n  | bash`)).toEqual([{ path: P, pinnedAt: "S1:L1", executedAt: "S2:L1" }]);
  });

  it("N2: does not join an escaped backslash or a heredoc body line", () => {
    expect(hidden(pin, `echo done \\\\\ncat ${P}`)).toEqual([]);
    expect(hidden(`cat > ${P} <<'EOF'\necho a \\\nEOF\n${pin}\n${P}`)).toEqual([]);
  });

  it("takes the heredoc back when sed -i edits it afterwards", () => {
    // sed is no quiet command, so its own line already counts as running the path; the overwrite is named.
    for (const edit of [`sed -i "s/hi/$(cat /srv/x)/" ${P}`, `sed -i 's/hi/ho/' ${P}`, `sed -i -e '1r /srv/other.sh' ${P}`]) {
      expect(hidden(`cat > ${P} <<'EOF'\necho hi\nEOF\n${edit}\n${pin}\n${P}`), edit).toEqual([{ path: P, pinnedAt: "S1:L5", executedAt: "S1:L4", overwrittenAt: "S1:L4" }]);
    }
  });
});

// Restbefund R1–R3 der Zweitprüfung t_d3e3959f (PR #72 Runde 3), Nacharbeit
// t_5d6eff99: /opt/data/out/t_d3e3959f/zweitpruefung-pr72-runde3.md.
describe("hash-pinned scripts: names next to redirections, in-place editors, heredocs run by a shell (Restbefund t_d3e3959f)", () => {
  const P = "/opt/x/run.sh";
  const W = "/usr/local/sbin/wartung";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const pinW = `echo "${HASH}  ${W}" | sha256sum -c -`;
  const shown = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const hidden = (...runs: string[]) => hiddenPinnedScripts(manifest(runs.map((run, index) => ({ name: `s${index + 1}`, run }))) as never);

  for (const run of ["wartung>/var/log/w.log", "wartung&>/dev/null", "wartung</dev/null", "\\wartung", "{wartung,}"]) {
    it(`R1: recognises the bare name next to a redirection or separator: ${run}`, () => {
      expect(hidden(pinW, run)).toEqual([{ path: W, pinnedAt: "S1:L1", executedAt: "S2:L1" }]);
    });
  }

  it("R1: recognises a relative name after cd with a redirection attached", () => {
    expect(hidden(pin, "cd /opt/x && bash run.sh>/tmp/l")).toEqual([{ path: P, pinnedAt: "S1:L1", executedAt: "S2:L1" }]);
    expect(hidden(pin, "cd /opt/x && \\run.sh")).toEqual([{ path: P, pinnedAt: "S1:L1", executedAt: "S2:L1" }]);
  });

  it("R1: leaves a deployed helper's name with a redirection, other words and names outside PATH directories alone", () => {
    expect(hidden(`echo "${HASH}  /usr/local/sbin/cockpit-backup-guard" | sha256sum -c -\ncockpit-backup-guard status>/tmp/s`)).toEqual([]);
    expect(hidden(pinW, "echo wartung-ok>/tmp/x\napt-get install -y wartungstool</dev/null")).toEqual([]);
    expect(hidden(pin, "bash run.sh>/tmp/l")).toEqual([]);
  });

  const editors = [
    `perl -pi -e 's/hi/$ENV{X}/' ${P}`,
    `awk -i inplace '{print}' ${P}`,
    `ed -s ${P} < /srv/cmds`,
    `ex -sc '%s/hi/ho/|x' ${P}`,
    `patch ${P} < /srv/fix.diff`,
    `truncate -s 0 ${P}`,
    `python3 /srv/edit.py ${P}`,
    `echo ${P} | xargs perl -pi -e 's/hi/ho/'`,
    `sed -n 'w ${P}' /srv/other.sh`,
  ];
  for (const edit of editors) {
    it(`R2: takes the heredoc back when another command edits it in place: ${edit}`, () => {
      expect(hidden(`${shown}\n${edit}\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L5", executedAt: "S1:L4", overwrittenAt: "S1:L4" }]);
    });
  }

  it("R2: names the edit in the planner stage", () => {
    expect(() => parseHostRunManifest(plan(manifest([{ name: "s", run: `${shown}\nperl -pi -e 's/hi/ho/' ${P}\n${pin}\n${P}` }])))).toThrow(/overwritten at S1:L4/);
  });

  it("R2: an edit by the bare name of a script in a PATH directory takes it back as well", () => {
    expect(hidden(`cat > ${W} <<'EOF'\necho hi\nEOF`, "cd /usr/local/sbin && perl -pi -e 's/hi/ho/' wartung", `${pinW}\nwartung`)).toEqual([{ path: W, pinnedAt: "S3:L1", executedAt: "S2:L1", overwrittenAt: "S2:L1" }]);
  });

  it("R2: leaves running, checking and naming a shown script alone", () => {
    const uses = [
      `chmod 0755 ${P}`, `chown root:root ${P}`, `bash -n ${P}`, `shellcheck ${P}`, `grep -q hi ${P}`, `sed -n 1p ${P}`, `cat ${P} | sha256sum`,
      `echo "installed ${P}"`, `logger "installed ${P}"`, `cp ${P} /var/backups/run.sh.bak`, `test -x ${P} && ls -l ${P}`,
      `sudo -u root ${P}`, `runuser -u nobody -- ${P} --flag`, `timeout 60 ${P}`, `nice -n 5 ${P}`, `env -i FOO=1 ${P}`, `sh -c '${P} --flag'`,
      `bash ${P}`, `cat ${P} | sudo bash`, `systemd-run --unit=x -p Nice=5 ${P}`,
    ];
    expect(hidden(`${shown}\n${uses.join("\n")}\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`cat > ${W} <<'EOF'\necho hi\nEOF\n${pinW}\nwartung --jetzt\nsudo wartung>/tmp/l`)).toEqual([]);
  });

  for (const [label, shell] of [["bash <<'X'", "bash <<'X'"], ["sudo bash -s <<'X'", "sudo bash -s <<'X'"], ["cat <<'X' | bash", "cat <<'X' | bash"], ["cat <<'X' | sudo -u root sh", "cat <<'X' | sudo -u root sh"], ["sudo -s <<'X'", "sudo -s <<'X'"]]) {
    it(`R3: reads the body of ${label} like script lines: a copy over the shown script`, () => {
      expect(hidden(`${shown}\n${shell}\ncp /srv/evil.sh ${P}\nX\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L7", executedAt: "S1:L8", overwrittenAt: "S1:L5" }]);
    });
  }

  it("R3: joins a continued line in a body run by a shell", () => {
    expect(hidden(pin, `bash <<'X'\ncat ${P} \\\n  | bash\nX`)).toEqual([{ path: P, pinnedAt: "S1:L1", executedAt: "S2:L2" }]);
  });

  it("R3: reads an in-place edit and a cd in a body run by a shell", () => {
    expect(hidden(`${shown}\nbash <<'X'\ncd /opt/x\nperl -pi -e 's/hi/ho/' run.sh\nX\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L8", executedAt: "S1:L6", overwrittenAt: "S1:L6" }]);
  });

  it("R3: keeps the body of any other heredoc as content, also one nested in a shell body", () => {
    expect(hidden(`${shown}\ncat > /etc/x.conf <<'X'\ncp /srv/evil.sh ${P}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`${shown}\npython3 - <<'X'\nprint("cp /srv/evil.sh ${P}")\nX\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`${shown}\nbash <<'X'\ncat > /tmp/a <<'EOF'\ncp /srv/evil.sh ${P}\nEOF\nX\n${pin}\n${P}`)).toEqual([]);
  });

  it("R3: counts a script written literally inside a body run by a shell as shown, and nothing outside it", () => {
    expect(hidden(`bash <<'X'\ncat > ${P} <<'EOF'\necho hi\nEOF\nX\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`bash <<'X'\ncat > /tmp/a <<'EOF'\ncat > ${P} <<'Y'\nEOF\nX\n${pin}\n${P}`)).toHaveLength(1);
  });
});

// Befunde B1–B6 der Zweitprüfung t_1748d6c1 (PR #86), Nacharbeit t_8b84f3a6:
// /opt/data/out/t_1748d6c1/zweitpruefung-pr86.md, Probe probe5.ts.
describe("hash-pinned scripts: shell bodies elsewhere or unquoted, interpreter options, tree writes (Befund t_1748d6c1)", () => {
  const P = "/opt/x/run.sh";
  const W = "/usr/local/sbin/wartung";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const pinW = `echo "${HASH}  ${W}" | sha256sum -c -`;
  const shown = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const hidden = (...runs: string[]) => hiddenPinnedScripts(manifest(runs.map((run, index) => ({ name: `s${index + 1}`, run }))) as never);
  const body = `cat > ${P} <<'EOF'\necho hi\nEOF`;

  it("B1: a script written in a shell body with an unquoted delimiter is not shown (the caller expands it)", () => {
    expect(hidden(`bash <<X\ncat > ${P} <<'EOF'\n$(curl -s https://example.org/x)\nEOF\nX\n${pin}\n${P}`)).toHaveLength(1);
    expect(hidden(`bash <<X\n${body}\nX\n${pin}\n${P}`)).toHaveLength(1);
  });

  for (const opener of ["ssh other <<'X'", "docker exec -i c bash <<'X'", "podman exec -i c sh <<'X'", "pct exec 121 -- bash <<'X'", "lxc-attach -n c -- bash <<'X'", "chroot /mnt bash <<'X'", "nsenter -t 1 -m bash <<'X'", "systemd-nspawn -D /srv/root bash <<'X'", "machinectl shell c /bin/bash <<'X'", "cat <<'X' | ssh other"]) {
    it(`B1: a script written in a body run elsewhere is not the local file: ${opener}`, () => {
      expect(hidden(`${opener}\n${body}\nX\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L6", executedAt: "S1:L7" }]);
    });
  }

  it("B1: still reads overwrites and runs inside such a body", () => {
    expect(hidden(`${shown}\nssh other <<'X'\ncp /srv/evil.sh ${P}\nX\n${pin}\n${P}`)).toHaveLength(1);
    expect(hidden(pin, `bash <<X\n${P}\nX`)).toEqual([{ path: P, pinnedAt: "S1:L1", executedAt: "S2:L2" }]);
  });

  it("B1 guard: a quoted local shell body that writes the script literally stays shown", () => {
    expect(hidden(`bash <<'X'\n${body}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`sudo bash -s <<'X'\nsudo -u root bash <<'Y'\n${body}\nY\nX\n${pin}\n${P}`)).toEqual([]);
  });

  const b2 = [
    `perl -i -pes/hi/ho/ ${P}`,
    `perl -pi -es/hi/ho/ ${P}`,
    `sudo perl -i -pes/a/b/ ${P}`,
    `ruby -i -pe'$_="id"' ${P}`,
    `gawk --include=inplace 1 ${P}`,
    `gawk -iinplace '--source={$0="id"}1' ${P}`,
    `AWKPATH=/srv gawk --include=inplace --include=evil 1 ${P}`,
    `PERL5OPT=-Mevil perl -i -p ${P}`,
  ];
  for (const edit of b2) {
    it(`B2: an interpreter option before the path is an edit, not a run: ${edit}`, () => {
      expect(hidden(`${shown}\n${edit}\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L5", executedAt: "S1:L4", overwrittenAt: "S1:L4" }]);
    });
  }

  it("B2 guard: the path right after an interpreter, after awk -f, and after shells with options or wrappers still runs", () => {
    const uses = [`perl ${P}`, `python3 ${P}`, `sudo ruby ${P}`, `awk -f ${P} /etc/hostname`, `bash -n ${P}`, `bash -x ${P}`, `timeout 60 ${P}`, `nice -n 5 ${P}`];
    expect(hidden(`${shown}\n${uses.join("\n")}\n${pin}\n${P}`)).toEqual([]);
  });

  for (const tree of [`cp -r /srv/x/. /opt/x/`, `cp -a /srv/x /opt/`, `rsync -a /srv/x/ /opt/x/`, `rm -r /opt/x && mv /srv/x /opt/x`, `cd /opt/x && patch -p1 < /srv/fix.diff`, `git -C /opt/x checkout -- .`]) {
    it(`B3: a write or edit on a directory above the shown script takes it back: ${tree}`, () => {
      const result = hidden(`${shown}\n${tree}\n${pin}\n${P}`);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ path: P, pinnedAt: "S1:L5", executedAt: "S1:L6", overwrittenAt: "S1:L4" });
    });
  }

  it("B3 guard: a plain copy into the directory, reading commands there and a run from there leave the shown script alone", () => {
    expect(hidden(`${shown}\ncp /srv/other.conf /opt/x/\ncd /opt/x && ls -l && sha256sum run.sh\ncd /opt/x && bash run.sh\nchmod -R 0755 /opt/x\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`rsync -a /srv/x/ /opt/x/\n${shown}\n${pin}\n${P}`)).toEqual([]);
  });

  for (const [label, opener] of [["bash<<'X'", "bash<<'X'"], ["source /dev/stdin <<'X'", "source /dev/stdin <<'X'"], [". /dev/stdin <<'X'", ". /dev/stdin <<'X'"], ["fish <<'X'", "fish <<'X'"]]) {
    it(`B4: reads the body of ${label} as shell code`, () => {
      expect(hidden(`${shown}\n${opener}\ncp /srv/evil.sh ${P}\nX\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L7", executedAt: "S1:L8", overwrittenAt: "S1:L5" }]);
    });
  }

  it("B4 guard: source of a file and a heredoc into another command stay content", () => {
    expect(hidden(`${shown}\nsource /etc/os-release <<'X'\ncp /srv/evil.sh ${P}\nX\n${pin}\n${P}`)).toEqual([]);
  });

  it("B5: an unquoted heredoc with $ or backticks does not show the script", () => {
    expect(hidden(`cat > ${P} <<EOF\n$(curl -s https://example.org/x)\nEOF\n${pin}\n${P}`)).toHaveLength(1);
    expect(hidden(`tee ${P} <<EOF\n\`id\`\nEOF\n${pin}\n${P}`)).toHaveLength(1);
    expect(hidden(`install -m 0755 /dev/stdin ${P} <<EOF\necho $HOME\nEOF\n${pin}\n${P}`)).toHaveLength(1);
  });

  it("B5 guard: an unquoted heredoc without $ and backticks, and a quoted one with them, are shown", () => {
    expect(hidden(`cat > ${P} <<EOF\necho hi\nEOF\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`cat > ${P} <<'EOF'\necho "$HOME" \`id\`\nEOF\n${pin}\n${P}`)).toEqual([]);
  });

  for (const run of ["w\\artung", "wa''rtung", "\"wart\"ung", "\\wartung", "x='wartung'"]) {
    it(`B6: removes quotes and backslashes before splitting names: ${run}`, () => {
      expect(hidden(pinW, run)).toEqual([{ path: W, pinnedAt: "S1:L1", executedAt: "S2:L1" }]);
    });
  }

  it("B6 guard: other words around quotes stay other names", () => {
    expect(hidden(pinW, "echo 'wartung-ok'\napt-get install -y \"wartungstool\"")).toEqual([]);
  });
});

// Nacharbeit 3 (Zweitprüfung t_b4b11e32, Karte t_fda9d997): R-A positive list for
// local shell bodies, R-B $'…'/$"…" quoting, hints H1–H4.
// /opt/data/out/t_b4b11e32/zweitpruefung-pr86-r2.md, Probe probe6.ts.
describe("hash-pinned scripts: local shell bodies by positive list, ANSI-C quoting, heredoc ends (Befund t_b4b11e32)", () => {
  const P = "/opt/x/run.sh";
  const W = "/usr/local/sbin/wartung";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const pinW = `echo "${HASH}  ${W}" | sha256sum -c -`;
  const shown = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const body = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const hidden = (...runs: string[]) => hiddenPinnedScripts(manifest(runs.map((run, index) => ({ name: `s${index + 1}`, run }))) as never);

  const away = [
    "qm guest exec 100 --pass-stdin 1 -- bash <<'X'",
    "cat <<'X' | qm guest exec 100 --pass-stdin 1 -- bash",
    "schroot -c s -- bash <<'X'",
    "buildah run c bash <<'X'",
    "crictl exec -i c bash <<'X'",
    "runc exec c bash <<'X'",
    "lxc-execute -n c -- bash <<'X'",
    "proot -r /mnt bash <<'X'",
    "bwrap --bind /mnt / bash <<'X'",
    "firejail --chroot=/mnt bash <<'X'",
    "systemd-run -M c --pipe bash <<'X'",
    "systemd-run --machine=c --pipe bash <<'X'",
    "systemd-run -H host --pipe bash <<'X'",
    "oc exec -i p -- bash <<'X'",
    "distrobox enter b -- bash <<'X'",
    "toolbox run bash <<'X'",
    "dbclient host bash <<'X'",
    "rsh host bash <<'X'",
    "sudo -R /mnt bash <<'X'",
    "env -S 'ssh other' <<'X'",
    "su -c 'ssh other' root <<'X'",
    "bash -c 'ssh other' <<'X'",
    "cat <<'X' | xargs -0 bash",
    "nsenter -t 1 -m bash <<'X'",
    "systemd-run -p RootDirectory=/mnt --pipe bash <<'X'",
    "systemd-run --property=BindPaths=/srv/x:/opt/x --pipe bash <<'X'",
    "PATH=/srv/evil:/usr/bin bash <<'X'",
    "sudo BASH_ENV=/srv/evil.sh bash <<'X'",
  ];
  for (const opener of away) {
    it(`R-A: a body behind anything but local words is not the local file: ${opener}`, () => {
      expect(hidden(`${opener}\n${body}\nX\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L6", executedAt: "S1:L7" }]);
    });
  }

  const local = [
    "bash <<'X'",
    "sudo -u root bash <<'X'",
    "cat <<'X' | sudo bash",
    "timeout 60 bash <<'X'",
    "systemd-run --pipe bash <<'X'",
    "su - root <<'X'",
    "runuser -u postgres -- bash <<'X'",
    "nice -n 5 env FOO=1 bash -s -- arg <<'X'",
    "sudo bash -euo pipefail <<'X'",
    "cat <<'X' | tee /tmp/run.log | sh",
  ];
  for (const opener of local) {
    it(`R-A guard: a body behind local words only that writes the script literally stays shown: ${opener}`, () => {
      expect(hidden(`${opener}\n${body}\nX\n${pin}\n${P}`)).toEqual([]);
    });
  }

  for (const run of ["$'wartung'", "$\"wartung\"", "sudo $'wartung'"]) {
    it(`R-B: ANSI-C and locale quoting still name the program: ${run}`, () => {
      expect(hidden(pinW, run)).toEqual([{ path: W, pinnedAt: "S1:L1", executedAt: "S2:L1" }]);
    });
  }

  it("R-B: a relative name in ANSI-C quotes after cd runs", () => {
    expect(hidden(`cp /srv/evil.sh ${P}\n${pin}\ncd /opt/x && bash $'run.sh'`)).toEqual([{ path: P, pinnedAt: "S1:L2", executedAt: "S1:L3" }]);
  });

  it("R-B guard: quotes, backslashes and assignments still name it", () => {
    for (const run of ["x='wartung'", "w\\artung", "wa''rtung"]) expect(hidden(pinW, run)).toHaveLength(1);
  });

  it("H1: a heredoc ends only at its exact delimiter, <<- strips tabs only", () => {
    expect(hidden(`ssh other <<'X'\n X\n${body}\nX\n${pin}\n${P}`)).toHaveLength(1);
    expect(hidden(`cat > ${P} <<EOF\necho hi\n  EOF\n$(curl -s https://example.org/x)\nEOF\n${pin}\n${P}`)).toHaveLength(1);
    expect(hidden(`cat > ${P} <<EOF\necho hi\nEOF \n$(curl -s https://example.org/x)\nEOF\n${pin}\n${P}`)).toHaveLength(1);
  });

  it("H1 guard: <<- with a tab-indented delimiter ends the heredoc", () => {
    expect(hidden(`cat > ${P} <<-'EOF'\n\techo hi\n\tEOF\n${pin}\n${P}`)).toEqual([]);
    expect(hidden(`bash <<-'X'\n${body}\n\tX\n${pin}\n${P}`)).toEqual([]);
  });

  it("H2: every heredoc of a line is followed, not only the first", () => {
    expect(hidden(`cat <<'A' >/dev/null; ssh other <<'B'\nfoo\nA\n${body}\nB\n${pin}\n${P}`)).toHaveLength(1);
    expect(hidden(`cat <<'A' >/dev/null; bash <<B\nfoo\nA\ncat > ${P} <<'EOF'\n$(curl -s https://example.org/x)\nEOF\nB\n${pin}\n${P}`)).toHaveLength(1);
  });

  it("H2 guard: two local quoted heredocs on a line keep the script shown", () => {
    expect(hidden(`cat <<'A' >/dev/null; bash <<'B'\nfoo\nA\n${body}\nB\n${pin}\n${P}`)).toEqual([]);
  });

  for (const link of ["ln -sfn /srv/x /opt/x", "rm -rf /opt/x && ln -s /srv/x /opt/x"]) {
    it(`H3: a symlink switched on a directory above the shown script takes it back: ${link}`, () => {
      expect(hidden(`${shown}\n${link}\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L5", executedAt: "S1:L6", overwrittenAt: "S1:L4" }]);
    });
  }

  it("H3 guard: a symlink into a PATH directory or a target directory leaves the shown script alone", () => {
    expect(hidden(`${shown}\nln -sf ${P} /usr/local/bin/runit\nln -s /srv/other.conf /opt/x/\n${pin}\n${P}`)).toEqual([]);
  });

  for (const edit of [`sudo -e ${P}`, `EDITOR=/srv/evil.sh sudo -e ${P}`, `sudo --edit ${P}`]) {
    it(`H4: sudo -e writes the file, it does not run it: ${edit}`, () => {
      expect(hidden(`${shown}\n${edit}\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L5", executedAt: "S1:L4", overwrittenAt: "S1:L4" }]);
    });
  }

  it("H4 guard: sudo with other options still runs the script", () => {
    expect(hidden(`${shown}\nsudo -E ${P}\nsudo -u root ${P}\n${pin}\n${P}`)).toEqual([]);
  });
});

describe("hash-pinned scripts: redirections, shell operands, $SHELL and startup files at the opener (Befund t_c82f5ac2)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const body = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const hidden = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never);
  const opened = (opener: string, before = "") => hidden(`${before}${opener}\n${body}\nX\n${pin}\n${P}`);

  const replaced = [
    "bash <<'X' </srv/evil.sh",
    "bash <<'X' 0</srv/evil.sh",
    "bash <<'X' <&3",
    "bash <<'X' <<<'true'",
    "sudo bash <<'X' </dev/null",
    "cat <<'X' | bash </srv/evil.sh",
    "cat <<'X' >/dev/null | bash",
    "cat <<'X' >&2 | bash",
    "cat <<'X' 1>/dev/null | sudo bash",
    "tee <<'X' >/dev/null | bash",
    "cat -n <<'X' | bash",
    "cat -v <<'X' | bash",
    "bash <<'X' &",
    "cat <<'X' | bash &",
  ];
  for (const opener of replaced) {
    it(`S-A: a redirection that replaces or empties the body's stdin makes it not local: ${opener}`, () => {
      expect(opened(opener)).toEqual([{ path: P, pinnedAt: "S1:L6", executedAt: "S1:L7" }]);
    });
  }

  it("S-A: bash discards the first of two heredocs on one shell", () => {
    expect(hidden(`bash <<'X' <<'Y'\n${body}\nX\ntrue\nY\n${pin}\n${P}`)).toHaveLength(1);
  });

  it("H-c: a stdin redirection after a top-level heredoc writes the file, not the body", () => {
    expect(hidden(`cat > ${P} <<'EOF' </srv/evil.sh\necho hi\nEOF\n${pin}\n${P}`)).toEqual([{ path: P, pinnedAt: "S1:L4", executedAt: "S1:L5" }]);
    expect(hidden(`tee ${P} <<'EOF' 0</srv/evil.sh\necho hi\nEOF\n${pin}\n${P}`)).toHaveLength(1);
  });

  const operand = [
    "bash -- /srv/evil.sh <<'X'",
    "bash - /srv/evil.sh <<'X'",
    "sh -- /srv/evil.sh <<'X'",
    "sudo bash -e -- /srv/evil.sh <<'X'",
  ];
  for (const opener of operand) {
    it(`S-B: after - or -- the operand is the script, not the body: ${opener}`, () => {
      expect(opened(opener)).toEqual([{ path: P, pinnedAt: "S1:L6", executedAt: "S1:L7" }]);
    });
  }

  const shellVariable = [
    "su -s /srv/evil.sh <<'X'",
    "su -s/srv/evil.sh root <<'X'",
    "runuser -s /srv/evil.sh <<'X'",
    "SHELL=/srv/evil.sh sudo -s <<'X'",
    "sudo -s <<'X'",
    "sudo -Es <<'X'",
    "sudo --shell <<'X'",
    "doas -s <<'X'",
    "SHELL=/srv/evil.sh su -m <<'X'",
    "SHELL=/srv/evil.sh su -p <<'X'",
    "su --preserve-environment root <<'X'",
    "runuser -m root <<'X'",
    "SHELL=/srv/evil.sh bash <<'X'",
  ];
  for (const opener of shellVariable) {
    it(`S-C: a shell chosen by option or $SHELL is not the one the plan names: ${opener}`, () => {
      expect(opened(opener)).toEqual([{ path: P, pinnedAt: "S1:L6", executedAt: "S1:L7" }]);
    });
  }

  const startup = [
    "bash --rcfile /srv/e -i <<'X'",
    "bash --init-file /srv/e -i <<'X'",
    "bash -i <<'X'",
    "bash -l <<'X'",
    "bash --login <<'X'",
    "bash -O extdebug <<'X'",
    "bash -n <<'X'",
    "bash +B <<'X'",
    "bash -o posix <<'X'",
    "systemd-run --user --pipe bash <<'X'",
    "systemd-run --capsule=x --pipe bash <<'X'",
  ];
  for (const opener of startup) {
    it(`S-D: a shell option outside the positive list makes the body not local: ${opener}`, () => {
      expect(opened(opener)).toEqual([{ path: P, pinnedAt: "S1:L6", executedAt: "S1:L7" }]);
    });
  }

  const exported = [
    "export BASH_ENV=/srv/e\n",
    "export ENV=/srv/e\n",
    "declare -x BASH_ENV=/srv/e\n",
    "typeset -x SHELL=/srv/evil.sh\n",
    "export PATH=/srv/bin:$PATH\n",
    "PATH=/srv/bin:$PATH\n",
    "printf -v BASH_ENV /srv/e; export BASH_ENV\n",
    "cat() { cp /srv/evil \"$@\"; }; export -f cat\n",
    "export BASH_ENV=/srv/e; ",
  ];
  for (const before of exported) {
    it(`S-D: an environment set on an earlier line of the step reaches every later body: ${JSON.stringify(before)}`, () => {
      expect(opened("bash <<'X'", before)).toHaveLength(1);
    });
  }

  it("S-D: a later body in a nested shell is not local either", () => {
    expect(hidden(`bash <<'A'\nexport BASH_ENV=/srv/e\nbash <<'X'\n${body}\nX\nA\n${pin}\n${P}`)).toHaveLength(1);
  });

  const guards = [
    "bash <<'X'",
    "sudo -u root bash <<'X'",
    "cat <<'X' | sudo bash",
    "cat - <<'X' | bash",
    "cat -u <<'X' | bash",
    "timeout 60 bash <<'X'",
    "systemd-run --pipe bash <<'X'",
    "bash -s <<'X'",
    "bash -xs -- a b <<'X'",
    "bash - <<'X'",
    "bash -- /dev/stdin <<'X'",
    "bash -euxo pipefail <<'X'",
    "bash --noprofile --norc -e <<'X'",
    "sudo -i <<'X'",
    "sudo -s bash <<'X'",
    "su root <<'X'",
    "su - root <<'X'",
    "bash <<'X' >/var/log/run.log 2>&1",
    "cat <<'X' | bash 2>/dev/null",
  ];
  for (const opener of guards) {
    it(`S-A–S-D guard: a local body with stdin intact and a named shell stays shown: ${opener}`, () => {
      expect(opened(opener)).toEqual([]);
    });
  }

  it("S-D guard: other exports, reading PATH and IFS= read before the body leave it shown", () => {
    expect(opened("bash <<'X'", "export DEBIAN_FRONTEND=noninteractive\necho \"$PATH\" ${PATH}\nwhile IFS= read -r l; do echo \"$l\"; done </etc/hosts\n")).toEqual([]);
  });

  it("S-D guard: an export in a later step does not reach this step's body", () => {
    expect(hiddenPinnedScripts(manifest([{ name: "s1", run: `bash <<'X'\n${body}\nX\n${pin}\n${P}` }, { name: "s2", run: "export BASH_ENV=/srv/e" }]) as never)).toEqual([]);
  });
});

describe("hash-pinned scripts: wrapper options by positive list, directory, fd 0 and expansions at the opener (Befund t_683da1d6)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const body = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const hidden = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never);
  const opened = (opener: string, before = "") => hidden(`${before}${opener}\n${body}\nX\n${pin}\n${P}`);
  // The body writes run.sh relative to the directory it runs in.
  const relative = (opener: string) => hidden(`cd /opt/x\n${opener}\ncat > run.sh <<'EOF'\necho hi\nEOF\nX\n${pin}\n${P}`);

  const wrappers = ["sudo", "doas", "su", "runuser", "setpriv", "env", "nice", "ionice", "chrt", "timeout", "stdbuf", "systemd-run", "systemd-cat", "nohup", "setsid"];
  const unlisted = [
    ...wrappers.flatMap((wrapper) => [`${wrapper} --help bash <<'X'`, `${wrapper} --version bash <<'X'`]),
    "sudo -V bash <<'X'",
    "sudo -l bash <<'X'",
    "sudo --list bash <<'X'",
    "sudo -K bash <<'X'",
    "sudo -S bash <<'X'",
    "sudo -b bash <<'X'",
    "doas -C /etc/doas.conf bash <<'X'",
    "chrt -p 10 bash <<'X'",
    "setpriv -d bash <<'X'",
    "setsid -f bash <<'X'",
    "systemd-run --pipe --root-directory=/srv/r bash <<'X'",
    "systemd-run --pipe --root-directory /srv/r bash <<'X'",
    "systemd-run --pipe --root-image=/srv/i.raw bash <<'X'",
    "systemd-run --pipe --root-image /srv/i.raw bash <<'X'",
    "systemd-run -S <<'X'",
    "systemd-run --shell <<'X'",
    "systemd-run --pty bash <<'X'",
    "systemd-run -t bash <<'X'",
    "systemd-run bash <<'X'",
    "systemd-run --wait bash <<'X'",
    "systemd-run --pipe --no-block bash <<'X'",
    "cat <<'X' | systemd-run -u x bash",
    "env --argv0=-bash bash <<'X'",
    "env --argv0 -bash bash <<'X'",
    "exec -a -bash bash <<'X'",
    "exec -a-bash bash <<'X'",
    "exec -l bash <<'X'",
  ];
  for (const opener of unlisted) {
    it(`T-A: a wrapper option outside its positive list makes the body not local: ${opener}`, () => {
      expect(opened(opener)).toEqual([{ path: P, pinnedAt: "S1:L6", executedAt: "S1:L7" }]);
    });
  }

  const moved = [
    "env -C /tmp bash <<'X'",
    "env --chdir=/tmp bash <<'X'",
    "env --chdir /tmp bash <<'X'",
    "sudo -D /tmp bash <<'X'",
    "sudo --chdir=/tmp bash <<'X'",
    "sudo -i <<'X'",
    "sudo --login <<'X'",
    "su - root <<'X'",
    "su -l root <<'X'",
    "su --login root <<'X'",
    "runuser -l root <<'X'",
    "systemd-run --pipe bash <<'X'",
    "systemd-run --pipe --working-directory=/tmp bash <<'X'",
    "systemd-run --pipe --same-dir --working-directory=/tmp bash <<'X'",
    "cat <<'X' | env -C /tmp bash",
  ];
  for (const opener of moved) {
    it(`T-B: a relative write behind a wrapper that changes the directory is not the shown file: ${opener}`, () => {
      expect(relative(opener)).toEqual([{ path: P, pinnedAt: "S1:L7", executedAt: "S1:L8" }]);
    });
  }

  for (const opener of ["bash <<'X'", "sudo -u root bash <<'X'", "systemd-run --pipe --same-dir bash <<'X'", "systemd-run --pipe -d bash <<'X'", "systemd-run --scope bash <<'X'", "su root <<'X'"]) {
    it(`T-B guard: a relative write behind a wrapper that keeps the directory stays shown: ${opener}`, () => {
      expect(relative(opener)).toEqual([]);
    });
  }

  it("T-B guard: after a body in another directory the caller's directory holds again", () => {
    expect(hidden(`cd /opt/x\nenv -C /tmp bash <<'X'\ntrue\nX\ncat > run.sh <<'EOF'\necho hi\nEOF\n${pin}\n${P}`)).toEqual([]);
  });

  it("T-B: the second body of a line starts in the directory of its own wrapper", () => {
    expect(hidden(`cd /opt/x\ncat > /tmp/a <<'A'; env -C /tmp bash <<'X'\nhi\nA\ncat > run.sh <<'EOF'\necho hi\nEOF\nX\n${pin}\n${P}`)).toHaveLength(1);
  });

  const fd0 = [
    "bash <<'X' 0>&-",
    "bash <<'X' 0>/dev/null",
    "bash <<'X' 0>>/srv/x",
    "bash <<'X' 00>&-",
    "bash <<'X' 0>&3",
    "bash 0>&- <<'X'",
    "sudo bash <<'X' 0>&-",
    "cat <<'X' | bash 0>&-",
    "cat <<'X' | bash 0>&3",
  ];
  for (const opener of fd0) {
    it(`T-C: a redirection of fd 0 without < replaces the body's stdin: ${opener}`, () => {
      expect(opened(opener)).toEqual([{ path: P, pinnedAt: "S1:L6", executedAt: "S1:L7" }]);
    });
  }

  it("T-C: the same after exec 3</srv/evil.sh, and on a top-level heredoc", () => {
    expect(opened("bash <<'X' 0>&3", "exec 3</srv/evil.sh\n")).toHaveLength(1);
    expect(hidden(`exec 3</srv/evil.sh\ncat > ${P} <<'EOF' 0>&3\necho hi\nEOF\n${pin}\n${P}`)).toHaveLength(1);
    expect(hidden(`cat > ${P} <<'EOF' 0>&-\necho hi\nEOF\n${pin}\n${P}`)).toHaveLength(1);
  });

  const expanded = [
    "bash -s $o <<'X'",
    "bash -s ${o} <<'X'",
    "sudo -u root bash -s $o <<'X'",
    "su $u <<'X'",
    "su \"$u\" <<'X'",
    "runuser $u <<'X'",
    "sudo -u $u bash <<'X'",
    "env `echo -C /tmp` bash <<'X'",
    "env $(echo -C /tmp) bash <<'X'",
    "ssh $(echo other) bash <<'X'",
    "bash <<'X' $(echo -c true)",
    "bash <<'X' `echo -c true`",
  ];
  for (const opener of expanded) {
    it(`T-D: an expansion in the opener chain is not read as a word: ${opener}`, () => {
      expect(opened(opener, "o='-c true'; u='-c true'\n")).toHaveLength(1);
    });
  }

  const unshown = [
    `cat /srv/evil.sh > ${P} <<'EOF'\necho hi\nEOF\n${pin}\n${P}`,
    `f=/srv/evil.sh\ncat $f > ${P} <<'EOF'\necho hi\nEOF\n${pin}\n${P}`,
    `cat -n > ${P} <<'EOF'\necho hi\nEOF\n${pin}\n${P}`,
    `export $(cat /srv/env)\nbash <<'X'\n${body}\nX\n${pin}\n${P}`,
    `set -a; . /srv/env; set +a\nbash <<'X'\n${body}\nX\n${pin}\n${P}`,
    `n=BAS; export "\${n}H_ENV=/srv/e"\nbash <<'X'\n${body}\nX\n${pin}\n${P}`,
  ];
  for (const run of unshown) {
    it(`hints: a file operand of cat and names the plan does not export by name: ${JSON.stringify(run.split("\n").slice(0, 2).join("; "))}`, () => {
      expect(hidden(run)).toHaveLength(1);
    });
  }

  const guards = [
    "bash <<'X'",
    "sudo -u root bash <<'X'",
    "cat <<'X' | sudo bash",
    "timeout 60 bash <<'X'",
    "systemd-run --pipe bash <<'X'",
    "bash -s <<'X'",
    "sudo -i <<'X'",
    "su root <<'X'",
    "su - root <<'X'",
    "setpriv --reuid 0 bash <<'X'",
    "setpriv --reuid=0 --regid=0 --init-groups bash <<'X'",
    "chrt -f 10 bash <<'X'",
    "env --argv0=ssh bash <<'X'",
    "exec -a ssh bash <<'X'",
    "systemd-run --pipe -uM bash <<'X'",
    "systemd-run --pipe --wait --collect --unit=x --same-dir bash <<'X'",
    "systemd-run -PWG bash <<'X'",
    "systemd-run --scope bash <<'X'",
    "ionice -c 3 nice -n 10 bash <<'X'",
    "nice -10 bash <<'X'",
    "stdbuf -oL bash <<'X'",
    "sudo -E -H -n -u root bash <<'X'",
    "env -i FOO=1 bash <<'X'",
    "timeout -k 5 --foreground 60 bash <<'X'",
    "cat <<'X' | tee -a /var/log/run.log | bash",
    "bash <<'X' 2>&1",
    "bash <<'X' >&2",
  ];
  for (const opener of guards) {
    it(`T-A–T-D guard: a local body with listed options stays shown: ${opener}`, () => {
      expect(opened(opener)).toEqual([]);
    });
  }

  it("T-D guard: the value of an assignment and of a named export may expand", () => {
    expect(opened("LANG=$L bash <<'X'")).toEqual([]);
    expect(opened("bash <<'X'", "export STAMP=$(date +%s)\n")).toEqual([]);
  });

  it("hint guard: cat - and cat -u still write their heredoc", () => {
    expect(hidden(`cat - > ${P} <<'EOF'\necho hi\nEOF\n${pin}\n${P}`)).toEqual([]);
  });
});

// Befunde U-A, U-B der Zweitprüfung t_f7778d43 (PR #86), Nacharbeit t_53bfc494:
// /opt/data/out/t_f7778d43/zweitpruefung-pr86-r5.md, Sonden probe14–probe16.
describe("hash-pinned scripts: the body must reach the write, braces and globs at the opener (Befund t_f7778d43)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const body = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const hidden = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never);
  const found = (run: string) => hidden(run).map(({ path }) => path);
  // A line in the body in front of the write, behind both openers of the finding.
  const before = (opener: string, pre: string, tail = "") => found(`${opener}\n${pre}\n${body}\n${tail}X\n${pin}\n${P}`);
  const openers = ["bash <<'X'", "cat <<'X' | sudo bash"];

  const stoppers = [
    "head -n 1 >/dev/null",
    "cat >/dev/null",
    "sed -n 1p >/dev/null",
    "ssh other true",
    "read -r _",
    "read -r _; read -r _; read -r _",
    "read -r _ || true",
    "exit 0",
    "exec true",
    "exec 0<&-",
    "exec </srv/evil.sh",
    "return 0 2>/dev/null || exit 0",
    "kill $$",
    "set -e; false",
    // Builtins and keywords stay foreign with </dev/null as well.
    "exit 0 </dev/null",
    "eval exit </dev/null",
    "command exit </dev/null",
    "builtin exit </dev/null",
    "source /srv/x.sh </dev/null",
    ". /srv/x.sh </dev/null",
    "trap 'exit 0' ERR",
    "/bin/kill -9 $$ </dev/null",
    "ssh -n other true </dev/null",
    "{exit,0} </dev/null",
    "$X </dev/null",
    "set +e",
    "PATH=/srv/bin",
    "X=$(head -n 1)",
    "mkdir -p $(cat)",
    "bash <<'Y'\ntrue\nY",
    // Control flow in the body (hint): the write may never run.
    "if false; then\ntrue",
    "f() {",
  ];
  for (const opener of openers) {
    for (const pre of stoppers) {
      it(`U-A: a line in front of the write in the body keeps it from being shown: ${opener} / ${JSON.stringify(pre)}`, () => {
        expect(before(opener, pre, /^(?:if|f\(\))/.test(pre) ? "fi\n}\n" : "")).toEqual([P]);
      });
    }
  }

  it("U-A: the same on the write line itself and in front of a nested body's opener", () => {
    expect(found(`bash <<'X'\nhead -n 1 >/dev/null; ${body}\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`bash <<'X'\nfalse && ${body}\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`bash <<'X'\nset -e\nhead -n 1 >/dev/null\nbash <<'Y'\n${body}\nY\nX\n${pin}\n${P}`)).toEqual([P]);
  });

  const tolerated = [
    "bash <<'X' || true",
    "bash <<'X' && true",
    "! bash <<'X'",
    "if bash <<'X'; then",
    "while bash <<'X'; do",
    "{ bash <<'X'",
    "( bash <<'X'",
    "cat <<'X' | sudo bash || true",
  ];
  for (const opener of tolerated) {
    it(`U-A: an opener line that catches a failure does not show the write: ${opener}`, () => {
      expect(found(`${opener}\nset -e\nmkdir -p /opt/x\n${body}\nX\n${pin}\n${P}`)).toEqual([P]);
    });
  }

  it("U-A: a failure caught around the opener on another line, or after set +e, does not show the write", () => {
    expect(found(`f() {\nbash <<'X'\n${body}\nX\n}\nf || true\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`{\nbash <<'X'\n${body}\nX\n} || true\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`if true; then\nbash <<'X'\n${body}\nX\nfi\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`set +e\nbash <<'X'\n${body}\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`set +o pipefail\nbash <<'X' | tee /var/log/x\n${body}\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`case a in a) true;; esac\nbash <<'X'\n${body}\nX\n${pin}\n${P}`)).toEqual([P]);
  });

  it("U-A: the write's own failure must end the body (set -e, or the write is its last command)", () => {
    expect(found(`bash <<'X'\n${body}\ntrue\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`bash <<'X'\ncat > ${P} <<'EOF' || true\necho hi\nEOF\nX\n${pin}\n${P}`)).toEqual([P]);
    // || true is no listed command either, even under set -e.
    expect(found(`bash <<'X'\nset -e\ncat > ${P} <<'EOF' || true\necho hi\nEOF\nX\n${pin}\n${P}`)).toEqual([P]);
    // A nested body that fails must fail its parent as well.
    expect(found(`bash <<'X'\nbash <<'Y'\n${body}\nY\ntrue\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`bash <<'X'\nset -e\nbash <<'Y' | tee /var/log/y\n${body}\nY\nX\n${pin}\n${P}`)).toEqual([P]);
  });

  it("U-A: an unknown directory counts a relative run by its base name (hint T-B)", () => {
    expect(found(`${body}\n${pin}\nsudo -i <<'X'\n./run.sh\nX`)).toEqual([]);
    expect(found(`${pin}\nsudo -i <<'X'\n./run.sh\nX`)).toEqual([P]);
    expect(found(`${pin}\nsudo -i <<'X'\ncd x\nbash ../x/run.sh\nX`)).toEqual([P]);
  });

  const guards = [
    "set -euo pipefail\nmkdir -p /opt/x\ncd /opt/x",
    "set -e\nset -u\nset -x\nset -o pipefail",
    "# comment\n\numask 022\ninstall -d -m 0755 /opt/x\nchown root:root /opt/x\nchmod 0755 /opt/x",
    "MODE=0755\nNAME='x'",
    "cat > /etc/x.conf <<'C'\na=1\nC\ntee /etc/y.conf >/dev/null <<'C'\nb=2\nC",
    "apt-get update -q </dev/null\nsystemctl stop x.service </dev/null\necho start </dev/null",
  ];
  for (const opener of openers) {
    for (const pre of guards) {
      it(`U-A guard: listed lines in front of the write keep it shown: ${opener} / ${JSON.stringify(pre)}`, () => {
        expect(before(opener, pre)).toEqual([]);
        if (pre.startsWith("set -e")) expect(before(opener, pre, "chmod 0755 /opt/x/run.sh\n")).toEqual([]);
      });
    }
  }

  it("U-A guard: set -e in the body or at the shell keeps a write with commands after it shown", () => {
    expect(found(`bash <<'X'\nset -euo pipefail\nmkdir -p /opt/x\n${body}\nchmod 0755 ${P}\nsystemctl daemon-reload </dev/null\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`bash -euo pipefail <<'X'\n${body}\nchmod 0755 ${P}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`cat <<'X' | sudo bash -e\n${body}\nchmod 0755 ${P}\nX\n${pin}\n${P}`)).toEqual([]);
  });

  it("U-A guard: a pipe or ; behind the opener under the step's pipefail, nested bodies as the parent's last command", () => {
    expect(found(`bash <<'X' 2>&1 | tee -a /var/log/x\n${body}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`cat <<'A' >/dev/null; bash <<'B'\nfoo\nA\n${body}\nB\n${pin}\n${P}`)).toEqual([]);
    expect(found(`sudo bash -s <<'X'\nsudo -u root bash <<'Y'\n${body}\nY\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`bash <<'X'\nset -e\nbash <<'Y'\n${body}\nY\ntrue\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`while IFS= read -r l; do echo "$l"; done </etc/hosts\nf() { true; }\nbash <<'X'\n${body}\nX\n${pin}\n${P}`)).toEqual([]);
  });

  const braces = [
    "bash -s {-c,true} <<'X'",
    "bash -s {-n,} <<'X'",
    "bash -s {-l,} <<'X'",
    "bash -s {--rcfile,/srv/rc} <<'X'",
    "sudo -u root bash -s {-c,true} <<'X'",
    "cat <<'X' | bash -s {-c,true}",
    "su {-c,true} <<'X'",
    "bash -s {1..2} <<'X'",
    "bash -s -[c] true <<'X'",
    "bash -s -? <<'X'",
    "bash -s /srv/* <<'X'",
    "sudo {-u,root} bash <<'X'",
  ];
  for (const opener of braces) {
    it(`U-B: a word with braces or a glob in the opener chain is not read as a word: ${opener}`, () => {
      expect(found(`${opener}\n${body}\nX\n${pin}\n${P}`)).toEqual([P]);
    });
  }

  it("U-B guard: the value of an assignment and plain options stay local", () => {
    expect(found(`OPTS={a,b} bash <<'X'\n${body}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`systemd-run --pipe --unit=x-1 --same-dir bash <<'X'\n${body}\nX\n${pin}\n${P}`)).toEqual([]);
  });
});

// Befunde V-A, V-B, V-C und Hinweise der Zweitprüfung t_cdad398e (PR #86), Nacharbeit t_4b1ccb4a:
// /opt/data/out/t_cdad398e/zweitpruefung-pr86-r6.md, Sonde probe17, echte bash in bash-gegenprobe.txt.
describe("hash-pinned scripts: the line of a nested opener, the form of a write, nested shells (Befund t_cdad398e)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const body = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const hidden = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never);
  const found = (run: string) => hidden(run).map(({ path }) => path);
  const outer = (opener: string, inner: string) => found(`${opener}\n${inner}\nX\n${pin}\n${P}`);
  const openers = ["bash <<'X'", "cat <<'X' | sudo bash"];

  // V-A: bash reads the whole line with heredoc Y first, then runs what stands in
  // front of the opener; exit, exec, read, cat … end or drain the parent body.
  const front = ["exit 0", "exec true", "exec 0<&-", "read -r _", "head -n 1 >/dev/null", "cat >/dev/null", "kill $$", "false", "return 0 2>/dev/null || exit 0", "sh -c true </dev/null"];
  for (const opener of openers) {
    for (const pre of front) {
      it(`V-A: a segment in front of a nested opener on its line keeps the write from being shown: ${opener} / ${pre}`, () => {
        expect(outer(opener, `${pre}; bash <<'Y'\n${body}\nY`)).toEqual([P]);
        expect(outer(opener, `set -e\n${pre}; bash <<'Y'\n${body}\nY\ntrue`)).toEqual([P]);
        expect(outer(opener, `${pre}; cat <<'Y' | bash\n${body}\nY`)).toEqual([P]);
      });
    }
  }

  it("V-A guard: listed segments in front of a nested opener keep it trusted", () => {
    for (const opener of openers) {
      expect(outer(opener, `set -e; bash <<'Y'\n${body}\nY`)).toEqual([]);
      expect(outer(opener, `mkdir -p /opt/x; cd /opt/x; bash <<'Y'\n${body}\nY`)).toEqual([]);
      expect(outer(opener, `cat <<'A' >/dev/null; bash <<'Y'\nfoo\nA\n${body}\nY`)).toEqual([]);
    }
  });

  // V-B: cat /proc/$$/fd/0 >/dev/null <<'E2' drains the body's stdin pipe (rc 0, old file).
  const writes = [
    "cat /proc/$$/fd/0 >/dev/null <<'E2'\nE2",
    "cat /proc/self/fd/0 >/dev/null <<'E2'\nE2",
    "cat /dev/stdin >/dev/null <<'E2'\nE2",
    "cat /srv/x >/dev/null <<'E2'\nE2",
    "cat -n >/dev/null <<'E2'\nE2",
    "cat >/dev/stdin <<'E2'\ntrue\nE2",
    "cat >/proc/$PPID/fd/0 <<'E2'\ntrue\nE2",
    "cat >&0 <<'E2'\ntrue\nE2",
    "cat > $F <<'E2'\nE2",
    "tee /proc/$$/fd/0 >/dev/null <<'E2'\nE2",
    "tee /dev/stdin <<'E2'\nE2",
    "tee --output-error=warn /etc/x <<'E2'\nE2",
    "tee /etc/{a,b} <<'E2'\nE2",
    "install -m 0644 /proc/self/fd/0 /etc/x <<'E2'\nE2",
    "install -m 0644 /srv/x /etc/x <<'E2'\nE2",
    "install -s --strip-program=/srv/x /dev/stdin /etc/x <<'E2'\nE2",
    "install -m 0644 /dev/stdin /etc/x /etc/y <<'E2'\nE2",
  ];
  for (const opener of openers) {
    for (const pre of writes) {
      it(`V-B: a heredoc write in a form that does not show its content is not listed: ${opener} / ${JSON.stringify(pre)}`, () => {
        expect(outer(opener, `${pre}\n${body}`)).toEqual([P]);
      });
    }
  }

  it("V-B guard: cat, tee and install in the form that shows the content stay listed", () => {
    for (const opener of openers) {
      expect(outer(opener, `cat > /etc/x.conf <<'C'\na=1\nC\n${body}`)).toEqual([]);
      expect(outer(opener, `cat - >> /etc/x.conf <<'C'\na=1\nC\n${body}`)).toEqual([]);
      expect(outer(opener, `tee -a /etc/y.conf >/dev/null <<'C'\nb=2\nC\n${body}`)).toEqual([]);
      expect(outer(opener, `install -D -m 0644 -o root /dev/stdin /etc/z.conf <<'C'\nc=3\nC\n${body}`)).toEqual([]);
      expect(outer(opener, `install --mode=0644 /dev/stdin /etc/z.conf <<'C'\nc=3\nC\n${body}`)).toEqual([]);
    }
  });

  // V-C: host-run.md says a nested shell never counts; sh -c '…' </dev/null did.
  const nested = [
    "sh -c 'cat /proc/$PPID/fd/0 >/dev/null' </dev/null",
    "sh -c true </dev/null",
    "bash -c true </dev/null",
    "/bin/sh -c true </dev/null",
    "busybox sh -c true </dev/null",
    "python3 -c pass </dev/null",
    "perl -e 1 </dev/null",
    "env sh -c true </dev/null",
    "env true </dev/null",
    "xargs true </dev/null",
    "sudo true </dev/null",
    "doas true </dev/null",
    "su -c true root </dev/null",
    "runuser -u root true </dev/null",
    "setsid true </dev/null",
    "nohup true </dev/null",
    "timeout 5 true </dev/null",
    "nice true </dev/null",
    "systemd-run --pipe true </dev/null",
    "find / -maxdepth 0 -exec sh -c true ';' </dev/null",
  ];
  for (const opener of openers) {
    for (const pre of nested) {
      it(`V-C: a nested shell or a starter never counts in front of the write, not even with </dev/null: ${opener} / ${pre}`, () => {
        expect(outer(opener, `${pre}\n${body}`)).toEqual([P]);
      });
    }
  }

  it("V-C guard: an ordinary program with </dev/null stays listed", () => {
    expect(outer("bash <<'X'", `apt-get update -q </dev/null\nsystemctl stop x.service </dev/null\n${body}`)).toEqual([]);
  });

  // Hint: an opener or writer rebound earlier in the step need not run the body.
  const rebinds = [
    ["bash() { cat >/dev/null; }", "bash <<'X'"],
    ["function bash { true; }", "bash <<'X'"],
    ["hash -p /bin/true bash", "bash <<'X'"],
    ["shopt -s expand_aliases; alias bash=true", "bash <<'X'"],
    ["shopt -s expand_aliases\nalias bash=true", "bash <<'X'"],
    ["sudo() { true; }", "sudo bash <<'X'"],
    ["cat() { true; }", "cat <<'X' | bash"],
    ["enable -n echo", "bash <<'X'"],
  ];
  for (const [pre, opener] of rebinds) {
    it(`hint: a rebound opener makes later bodies not local: ${pre.replace("\n", "⏎")} / ${opener}`, () => {
      expect(found(`${pre}\n${opener}\n${body}\nX\n${pin}\n${P}`)).toEqual([P]);
    });
  }

  it("hint: a rebound cat or tee in front of a write at top level shows nothing", () => {
    expect(found(`cat() { true; }\n${body}\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`hash -p /bin/true cat\n${body}\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`tee() { true; }\ntee ${P} >/dev/null <<'EOF'\necho hi\nEOF\n${pin}\n${P}`)).toEqual([P]);
  });

  it("hint guard: a function with another name stays free", () => {
    expect(found(`retry() { "$@" || "$@"; }\nbash <<'X'\n${body}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`f() { true; }\n${body}\n${pin}\n${P}`)).toEqual([]);
  });

  it("hint: the ) of a case pattern is no closing parenthesis", () => {
    expect(found(`case a in a)\nbash <<'X'\n${body}\nX\n;; esac\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`case b in a)\nbash <<'X'\n${body}\nX\n;; esac\n${pin}\n${P}`)).toEqual([P]);
  });
});

describe("hash-pinned scripts: heredoc bounds read as bash reads them (Befund t_ebbf1e40)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const body = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const hidden = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never);
  const found = (run: string) => hidden(run).map(({ path }) => path);
  const outer = (opener: string, inner: string) => found(`${opener}\n${inner}\nX\n${pin}\n${P}`);

  // W-A: a << in a comment or in quotes opens nothing for bash; the lines up to C run.
  const comments = [
    "mkdir -p /opt/x # <<'C'\nexit 0\nC",
    "set -euo pipefail\ncd /opt/x # <<'C'\nexit 0\nC",
    "mkdir -p '/tmp/<<C'\nexit 0\nC",
    "mkdir -p \"/tmp/<<C\"\nexit 0\nC",
    "mkdir -p /tmp/a\\<<C\nexit 0\nC",
  ];
  for (const opener of ["bash <<'X'", "cat <<'X' | sudo bash", "sudo -u root bash <<'X'"]) {
    for (const pre of comments) {
      it(`W-A: a << in a comment or in quotes opens no heredoc in a body: ${opener} / ${pre.split("\n").slice(-3, -2)[0]}`, () => {
        expect(outer(opener, `${pre}\n${body}`)).toEqual([P]);
      });
    }
  }

  // Hint M: the same at top level; : <<'Z' swallows the write the tool takes for code.
  it("W-A (hint M): a << in a comment or in quotes at top level", () => {
    expect(found(`mkdir -p /opt/x # <<'C'\n: <<'Z'\nC\n${body}\nZ\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`mkdir -p '/tmp/<<C'\n: <<'Z'\nC\n${body}\nZ\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`mkdir -p /opt/x # <<'C'\nexit 0\nC\n${body}\n${pin}\n${P}`)).toEqual([P]);
  });

  // Other forms bash reads differently: the delimiter goes on after the quote or
  // holds a dot, a backslash quotes it, the << sits in a quote inside $( … )
  // inside double quotes.
  const forms = [
    `: <<'Z'x\nZ\n${body}\nZx`,
    `: <<Z.1\nZ\n${body}\nZ.1`,
    `: <<\\Z\n${body}\nZ`,
    `echo "$(echo "<<C")"\n: <<'Z'\nC\n${body}\nZ`,
  ];
  for (const pre of forms) {
    it(`W-A: an opener of another form or bounds bash reads otherwise show nothing after it: ${pre.split("\n")[0]}`, () => {
      expect(found(`${pre}\n${pin}\n${P}`)).toEqual([P]);
      expect(outer("bash <<'X'", `${pre}`)).toEqual([P]);
    });
  }

  it("W-A: a comment ending in a backslash in a body continues nothing", () => {
    expect(outer("bash <<'X'", `mkdir -p /opt/x # \\\nexit 0\n${body}`)).toEqual([P]);
  });

  it("W-A: a body line with a comment after its beginning is unlisted", () => {
    expect(outer("bash <<'X'", `mkdir -p /opt/x # Ziel\n${body}`)).toEqual([P]);
  });

  // W-B: bash ends the body of bash <<'X' at the first line X, also inside the
  // content of a heredoc in the body; : <<'X' then swallows the write.
  for (const opener of ["bash <<'X'", "cat <<'X' | sudo bash"]) {
    it(`W-B: the outer delimiter in the content of an inner heredoc ends the body: ${opener}`, () => {
      expect(outer(opener, `cat > /tmp/a <<'EOF'\nX\n: <<'X'\nEOF\n${body}`)).toEqual([P]);
    });
  }

  it("W-B: an earlier write in the body and the rest of the step show nothing either", () => {
    expect(found(`bash <<'X'\n${body}\ncat > /tmp/a <<'EOF'\nX\ncp /srv/evil.sh ${P}\nEOF\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`bash <<'X'\nbash <<'Y'\n${body}\nX\nY\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`bash <<-'X'\ncat > /tmp/a <<'EOF'\n\t\tX\n: <<'X'\nEOF\n${body}\nX\n${pin}\n${P}`)).toEqual([P]);
  });

  // Hint: the rule of V-B for every program with </dev/null.
  it("hint: a program with </dev/null and a /proc or /dev path or a $ is unlisted", () => {
    expect(outer("bash <<'X'", `true >/proc/self/fd/0 </dev/null\n${body}`)).toEqual([P]);
    expect(outer("bash <<'X'", `cat /proc/$$/fd/0 >/dev/null </dev/null\n${body}`)).toEqual([P]);
    expect(outer("bash <<'X'", `cp /dev/stdin /tmp/x </dev/null\n${body}`)).toEqual([P]);
  });

  const guards = [
    "bash <<'X'",
    "sudo -u root bash <<'X'",
    "cat <<'X' | sudo bash",
    "timeout 60 bash <<'X'",
    "systemd-run --pipe bash <<'X'",
    "bash -s <<'X'",
    "sudo -i <<'X'",
    "su root <<'X'",
    "setpriv --reuid 0 bash <<'X'",
    "chrt -f 10 bash <<'X'",
    "env --argv0=ssh bash <<'X'",
    "exec -a ssh bash <<'X'",
    "systemd-run --pipe -uM bash <<'X'",
  ];
  for (const opener of guards) {
    it(`guard: real bodies stay free: ${opener}`, () => {
      expect(outer(opener, body)).toEqual([]);
      expect(outer(opener, `set -euo pipefail\nmkdir -p /opt/x\ncd /opt/x\napt-get update -q </dev/null\n${body}`)).toEqual([]);
      expect(outer(opener, `set -euo pipefail\ncat > /etc/x.conf <<'EOF'\nkey = "a # b <<c"\nEOF\n${body}`)).toEqual([]);
    });
  }

  it("guard: comments, quotes and here-strings without a << opener stay free", () => {
    expect(found(`mkdir -p /opt/x # Zielordner\n${body}\n${pin}\n${P}`)).toEqual([]);
    expect(found(`echo "a # b" >/dev/null\ngrep -q x <<<"$v" || true\n${body}\n${pin}\n${P}`)).toEqual([]);
    expect(found(`cat <<'A' >/dev/null; bash <<'X'\nfoo\nA\n${body}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`bash <<-'X'\n\tcat > ${P} <<-'EOF'\n\techo hi\n\tEOF\n\tX\n${pin}\n${P}`)).toEqual([]);
  });
});

describe("hash-pinned scripts: tabs an outer <<- strips, << in arithmetic and ${…} (Befund t_6024cbc7)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const body = `cat > ${P} <<'EOF'\necho hi\nEOF`;
  const found = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never).map(({ path }) => path);

  // X-A: bash strips the leading tabs of every line of a <<- body, also of the
  // lines of a heredoc in it; <TAB>EOF ends the inner heredoc for the inner shell,
  // and the lines after it run instead of being content.
  for (const opener of ["bash <<-'X'", "cat <<-'X' | sudo bash", "sudo -u root bash <<-'X'"]) {
    for (const inner of ["'EOF'", "EOF"]) {
      for (const pre of ["", "set -euo pipefail\n"]) {
        it(`X-A: a tab-indented delimiter ends the inner heredoc of a <<- body: ${opener} / <<${inner}${pre ? " / set -e" : ""}`, () => {
          expect(found(`${opener}\n${pre}cat > ${P} <<${inner}\necho hi\n\tEOF\nprintf 'echo BOESE\\n' > ${P}\nexit 0\nEOF\nX\n${pin}\n${P}`)).toEqual([P]);
        });
      }
    }
  }

  it("X-A: the lines of a <<- body are read without their tabs, in a nested body as well", () => {
    expect(found(`bash <<-'X'\n\tcat > ${P} <<-'EOF'\n\techo hi\n\tEOF\n\tprintf 'echo BOESE\\n' > ${P}\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`bash <<-'X'\nbash <<'Y'\ncat > ${P} <<'EOF'\necho hi\n\tEOF\nexit 0\nEOF\nY\nX\n${pin}\n${P}`)).toEqual([P]);
    expect(found(`bash <<-'X'\nbash <<'Y'\n${body}\n\tY\nexit 0\nY\nX\n${pin}\n${P}`)).toEqual([P]);
  });

  // Hint: in ((…)), $((…)), $[…] and ${…} a << is a shift or text for bash; at top
  // level : <<'Z' then swallows the write the tool takes for code.
  const lines = [
    "(( y = 1 << C ))",
    "echo $(( 1 << C ))",
    "y=$(( 1 << C ))",
    "echo ${x:-<<C }",
    "echo \"${x:-\"<<C \"}\"",
    "[[ $(( 1 << C )) ]]",
    "echo ${x/<<C /y}",
    "echo $[ 1 << C ]",
    "echo \"$(( 1 << C ))\"",
    "echo $(( 1 \\\n<< C ))",
  ];
  for (const line of lines) {
    it(`hint: a << in arithmetic or \${…} opens nothing: ${line.split("\n")[0]}`, () => {
      expect(found(`${line}\n: <<'Z'\nC\n${body}\nZ\n${pin}\n${P}`)).toEqual([P]);
    });
  }

  it("hint: a write whose target holds a << in ${…} shows nothing", () => {
    expect(found(`cat > /tmp/a\${x:-<<C } <<'E'\nE\n: <<'Z'\nC\nE\n${body}\nZ\n${pin}\n${P}`)).toEqual([P]);
  });

  it("guard: <<- bodies with tabs, arithmetic and ${…} without << stay free", () => {
    expect(found(`bash <<-'X'\n\tset -euo pipefail\n\tcat > ${P} <<-'EOF'\n\techo hi\n\tEOF\n\tX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`bash <<-'X'\n\tset -euo pipefail\n${body}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`n=$(( 1 + 2 ))\n(( n++ )) || true\necho "\${n:-0} $[n]" >/dev/null\n${body}\n${pin}\n${P}`)).toEqual([]);
  });
});

describe("hash-pinned scripts: a backslash at the end of an unquoted heredoc line (Hinweis B1, t_0bc8fac5)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const found = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never).map(({ path }) => path);
  // In an unquoted heredoc bash joins a line ending in an odd number of
  // backslashes with the next before it compares the delimiter: EOF after
  // echo hi\ ends nothing, and : <<'true' after it swallows the write.
  const swallowed = (open: string, tab = "") => `cat > ${P} <<${open}\n${tab}echo hi\\\n${tab}EOF\n: <<'true'\n${tab}EOF\nprintf 'echo BOESE\\n' > ${P}\ntrue`;

  for (const open of ["EOF", "-EOF"]) {
    it(`B1: top level, <<${open}`, () => {
      expect(found(`${swallowed(open)}\n${pin}\n${P}`)).toEqual([P]);
    });
    for (const opener of ["bash <<'X'", "cat <<'X' | sudo bash", "bash <<-'X'"]) {
      it(`B1: in the body of ${opener}, <<${open}`, () => {
        expect(found(`${opener}\n${swallowed(open)}\nX\n${pin}\n${P}`)).toEqual([P]);
      });
    }
    it(`B1: in a stripped <<- body with tabs, <<${open}`, () => {
      expect(found(`bash <<-'X'\n${swallowed(open, "\t").replace(/\n(?!\t)/g, "\n\t")}\n\tX\n${pin}\n${P}`)).toEqual([P]);
    });
  }

  it("B1: three backslashes join as well", () => {
    expect(found(`cat > ${P} <<EOF\necho hi\\\\\\\nEOF\n: <<'true'\nEOF\nprintf 'echo BOESE\\n' > ${P}\ntrue\n${pin}\n${P}`)).toEqual([P]);
  });

  it("guard: a quoted heredoc and an even number of backslashes stay free", () => {
    for (const open of ["'EOF'", "\"EOF\"", "-'EOF'"]) {
      expect(found(`cat > ${P} <<${open}\necho hi \\\nEOF\n${pin}\n${P}`)).toEqual([]);
      expect(found(`bash <<'X'\ncat > ${P} <<${open}\necho hi \\\nEOF\nX\n${pin}\n${P}`)).toEqual([]);
    }
    expect(found(`cat > ${P} <<EOF\necho hi \\\\\nEOF\n${pin}\n${P}`)).toEqual([]);
  });
});

describe("hash-pinned scripts: an unquoted heredoc a shell reads (R1, t_42ae4123)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const found = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never).map(({ path }) => path);
  const shown = `cat > ${P} <<'EOF'\necho gut\nEOF`;
  // bash expands the body before the inner shell reads it: echo foo\\ arrives as
  // echo foo\ and the inner shell joins it with the # line, echo foo#;cp … runs.
  const joined = (tab = "") => `${tab}echo foo\\\\\n${tab}#;cp /tmp/evil ${P}`;

  for (const [name, run] of [
    ["bash <<X", `bash <<X\n${joined()}\nX`],
    ["cat <<X | sudo bash", `cat <<X | sudo bash\n${joined()}\nX`],
    ["bash <<-X with tabs", `bash <<-X\n${joined("\t")}\n\tX`],
    // $ and backticks put a \ or code there as well.
    ["$B with B=\\", `B=$(printf '\\134')\nbash <<X\necho foo$B\n#;cp /tmp/evil ${P}\nX`],
    ["$(…) that prints code", `bash <<X\n$(printf 'cp /tmp/evil ${P}')\nX`],
    ["backticks that print code", `bash <<X\n\`printf 'cp /tmp/evil ${P}'\`\nX`],
  ]) {
    it(`R1: ${name}`, () => {
      expect(found(`${shown}\n${run}\n${pin}\n${P}`)).toEqual([P]);
    });
  }

  it("guard: a quoted shell body, an unquoted one without \\, $ or backticks and unquoted content stay free", () => {
    expect(found(`${shown}\nbash <<'X'\n${joined()}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\ncat <<'X' | sudo bash\necho foo$B\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\nbash <<X\necho hallo\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\ncat > /tmp/n <<X\necho foo\\\\ $HOME\nX\n${pin}\n${P}`)).toEqual([]);
  });
});

describe("hash-pinned scripts: a heredoc a shell reads by way of a group, a function, <(…) or a quoted name (X5, t_cee07772)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const found = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never).map(({ path }) => path);
  const shown = `cat > ${P} <<'EOF'\necho gut\nEOF`;
  const evil = `cp /tmp/boese ${P}`;
  // Zweitprüfung t_63a24b37 (H1): real bash runs the cp in each body, the tool
  // took it for content. Gegenprobe with bash: /opt/data/out/t_cee07772/harness.
  const forms = (q: string): Array<[string, string]> => [
    ["{ cat <<X … } | bash", `{ cat <<${q}\n${evil}\nX\n} | bash`],
    ["( cat <<X … ) | bash", `( cat <<${q}\n${evil}\nX\n) | bash`],
    ["f() { cat <<X …; }; f | bash", `f() { cat <<${q}\n${evil}\nX\n}\nf | bash`],
    ["f() { … }; f | bash on one line", `f() { cat <<${q}\n${evil}\nX\n}; f | bash`],
    ["bash <(cat <<X …)", `bash <(cat <<${q}\n${evil}\nX\n)`],
    ["bash < <(cat <<X …)", `bash < <(cat <<${q}\n${evil}\nX\n)`],
    ["b\\ash <<X", `b\\ash <<${q}\n${evil}\nX`],
    ["{ cat <<X; } | bash on one line", `{ cat <<${q}; } | bash\n${evil}\nX`],
    ["bash <(cat <<X) on one line", `bash <(cat <<${q})\n${evil}\nX`],
    ["source <(cat <<X)", `source <(cat <<${q})\n${evil}\nX`],
    ["sudo bash <(cat <<X)", `sudo bash <(cat <<${q})\n${evil}\nX`],
    ["eval $(cat <<X)", `eval $(cat <<${q})\n${evil}\nX`],
    ["$(cat <<X) as the command", `$(cat <<${q})\n${evil}\nX`],
    ["env $(cat <<X)", `env $(cat <<${q})\n${evil}\nX`],
    ["sudo $(cat <<X)", `sudo $(cat <<${q})\n${evil}\nX`],
    ["FOO=1 $(cat <<X)", `FOO=1 $(cat <<${q})\n${evil}\nX`],
    ["cat <<X > >(bash)", `cat <<${q} > >(bash)\n${evil}\nX`],
    ["{ cat <<X … } > >(bash)", `{ cat <<${q}\n${evil}\nX\n} > >(bash)`],
    ["bash <(f)", `f() { cat <<${q}\n${evil}\nX\n}\nbash <(f)`],
    ["bash <( open over the line's end", `bash <(\ncat <<${q}\n${evil}\nX\n)`],
    ["if … fi | bash", `if true; then cat <<${q}\n${evil}\nX\nfi | bash`],
    ["for … done | bash", `for i in 1; do cat <<${q}\n${evil}\nX\ndone | bash`],
    ["{ … } 2>&1 | bash", `{ cat <<${q}\n${evil}\nX\n} 2>&1 | bash`],
    ["{ … } |& bash", `{ cat <<${q}\n${evil}\nX\n} |& bash`],
    ["cat <<X | b\\ash", `cat <<${q} | b\\ash\n${evil}\nX`],
    ["ba''sh <<X", `ba''sh <<${q}\n${evil}\nX`],
    ["\\bash <<X", `\\bash <<${q}\n${evil}\nX`],
    ["$'bash' <<X", `$'bash' <<${q}\n${evil}\nX`],
    ["$'\\x62ash' <<X", `$'\\x62ash' <<${q}\n${evil}\nX`],
    ["/bin/b\\ash <<X", `/bin/b\\ash <<${q}\n${evil}\nX`],
    ["sudo b\\ash <<X", `sudo b\\ash <<${q}\n${evil}\nX`],
  ];
  for (const q of ["X", "'X'"]) {
    for (const [name, run] of forms(q)) {
      it(`X5: ${name} (${q === "X" ? "unquoted" : "quoted"})`, () => {
        expect(found(`${shown}\n${run}\n${pin}\n${P}`)).toEqual([P]);
      });
    }
  }

  it("guard: a group into a file, a pipe without a shell, python3 -, a function without a shell and the plain bodies stay free", () => {
    expect(found(`${shown}\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\n{ cat <<'X'\nhallo\nX\n} > /tmp/log\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\n( cd /tmp && ls ) | tee /tmp/l\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\npython3 - <<'X'\nprint("hallo")\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\nf() { echo hi; }\nf\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\nwhile read -r l; do echo "$l"; done < <(printf 'x\\n')\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\nx=$(cat <<'X'\nhallo\nX\n)\necho "$x"\n${pin}\n${P}`)).toEqual([]);
    expect(found(`bash <<'X'\nset -e\n${shown}\nX\n${pin}\n${P}`)).toEqual([]);
    expect(found(`cat <<'X' | bash\nset -e\n${shown}\nX\n${pin}\n${P}`)).toEqual([]);
  });
});

describe("hash-pinned scripts: the whole pipeline behind a group or function, | at the line's end, exec > >(bash), $'\\x62ash' <(…), a[0]=1 $(…) (X5 Nachtrag, t_a533d05c)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const found = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never).map(({ path }) => path);
  const shown = `cat > ${P} <<'EOF'\necho gut\nEOF`;
  const evil = `cp /tmp/boese ${P}`;
  // Zweitprüfung t_fa3d3327 (B1–B8): real bash runs the cp, the tool took it for
  // content. Gegenprobe with bash: /opt/data/out/t_fa3d3327/h, /opt/data/out/t_a533d05c.
  const forms = (q: string): Array<[string, string]> => {
    const fn = `f() {\ncat <<${q}\n${evil}\nX\n}\n`;
    return [
      // B1: the whole pipeline behind the closer, not only its first command
      ["} | tee /dev/null | bash", `{ cat <<${q}\n${evil}\nX\n} | tee /dev/null | bash`],
      ["} | cat | bash", `{ cat <<${q}\n${evil}\nX\n} | cat | bash`],
      ["} |& tee /dev/null | bash", `{ cat <<${q}\n${evil}\nX\n} |& tee /dev/null | bash`],
      ["while … done | tee /dev/null | bash", `while true; do cat <<${q}\n${evil}\nX\nbreak; done | tee /dev/null | bash`],
      ["} | tr '\\n' ';' | xargs -0 bash -c", `{ cat <<${q}\n${evil}\nX\n} | tr '\\n' ';' | xargs -0 bash -c`],
      ["} | { bash; }", `{ cat <<${q}\n${evil}\nX\n} | { bash; }`],
      ["} | tee >(bash) >/dev/null", `{ cat <<${q}\n${evil}\nX\n} | tee >(bash) >/dev/null`],
      ["} | xargs -0 $SH -c (a value names the shell)", `SH=bash\n{ cat <<${q}\n${evil}\nX\n} | xargs -0 $SH -c`],
      // B2: the same behind a function call, and the call read like bash
      ["f | tee /dev/null | bash", `${fn}f | tee /dev/null | bash`],
      ["\\f | bash", `${fn}\\f | bash`],
      ["'f' | bash", `${fn}'f' | bash`],
      ["f | (bash)", `${fn}f | (bash)`],
      ["f | tee >(bash) >/dev/null", `${fn}f | tee >(bash) >/dev/null`],
      // B3: | at the line's end, the pipeline goes on after the bodies
      ["} |⏎bash", `{ cat <<${q}\n${evil}\nX\n} |\nbash`],
      ["cat <<X |⏎ body ⏎ bash", `cat <<${q} |\n${evil}\nX\nbash`],
      ["cat <<X |&⏎ body ⏎ bash", `cat <<${q} |&\n${evil}\nX\nbash`],
      ["for … done |⏎bash", `for i in 1; do cat <<${q}\n${evil}\nX\ndone |\nbash`],
      // B4: any redirection at the closer
      ["} 2>\"/tmp/a b\" | bash", `{ cat <<${q}\n${evil}\nX\n} 2>"/tmp/a b" | bash`],
      ["} 2>$(echo /dev/null) | bash", `{ cat <<${q}\n${evil}\nX\n} 2>$(echo /dev/null) | bash`],
      ["} 2>\"/tmp/a b\" |& bash", `{ cat <<${q}\n${evil}\nX\n} 2>"/tmp/a b" |& bash`],
      // B5: a substitution behind the pipe that runs as code
      ["cat <<X | source <(cat)", `cat <<${q} | source <(cat)\n${evil}\nX`],
      ["cat <<X | . <(cat)", `cat <<${q} | . <(cat)\n${evil}\nX`],
      ["cat <<X | eval \"$(cat)\"", `cat <<${q} | eval "$(cat)"\n${evil}\nX`],
      ["cat <<X | tee /dev/null | source <(cat)", `cat <<${q} | tee /dev/null | source <(cat)\n${evil}\nX`],
      ["cat <<X | bash <(cat)", `cat <<${q} | bash <(cat)\n${evil}\nX`],
      ["} | source <(cat)", `{ cat <<${q}\n${evil}\nX\n} | source <(cat)`],
      ["} | cat - | eval \"$(cat)\"", `{ cat <<${q}\n${evil}\nX\n} | cat - | eval "$(cat)"`],
      // B6: a >( … ) a shell reads, anywhere on the line
      ["exec > >(bash); cat <<X", `exec > >(bash)\ncat <<${q}\n${evil}\nX`],
      ["exec 1> >(sh); cat <<X", `exec 1> >(sh)\ncat <<${q}\n${evil}\nX`],
      ["exec 2> >(bash); cat <<X >&2", `exec 2> >(bash)\ncat <<${q} >&2\n${evil}\nX`],
      ["exec {fd}> >(bash)", `exec {fd}> >(bash)\ncat <<${q} >&$fd\n${evil}\nX`],
      ["exec > >(sudo bash)", `exec > >(sudo bash)\ncat <<${q}\n${evil}\nX`],
      ["exec > >(eval \"$(cat)\")", `exec > >(eval "$(cat)")\ncat <<${q}\n${evil}\nX`],
      // B7: $'…\…' around a substitution
      ["$'\\x62ash' <(cat <<X)", `$'\\x62ash' <(cat <<${q}\n${evil}\nX\n)`],
      ["$'\\x62ash' < <(cat <<X)", `$'\\x62ash' < <(cat <<${q}\n${evil}\nX\n)`],
      ["$'\\x62ash' -s < <(cat <<X)", `$'\\x62ash' -s < <(cat <<${q}\n${evil}\nX\n)`],
      // B8: assignments only in front of the substitution
      ["a[0]=1 $(cat <<X)", `a[0]=1 $(cat <<${q}\n${evil}\nX\n)`],
      ["x=\"a b\" $(cat <<X)", `x="a b" $(cat <<${q}\n${evil}\nX\n)`],
      ["a[1]+=x $(cat <<X)", `a[1]+=x $(cat <<${q}\n${evil}\nX\n)`],
      ["x='a b' y=1 $(cat <<X)", `x='a b' y=1 $(cat <<${q}\n${evil}\nX\n)`],
      ["x[0]=\"a b\" $(cat <<X)", `x[0]="a b" $(cat <<${q}\n${evil}\nX\n)`],
    ];
  };
  for (const q of ["X", "'X'"]) {
    for (const [name, run] of forms(q)) {
      it(`X5 Nachtrag: ${name} (${q === "X" ? "unquoted" : "quoted"})`, () => {
        expect(found(`${shown}\n${run}\n${pin}\n${P}`)).toEqual([P]);
      });
    }
  }

  it("X5 Nachtrag B6: exec > >(bash) after the pin as well", () => {
    expect(found(`${shown}\n${pin}\nexec > >(bash)\ncat <<'X'\n${evil}\nX\n${P}`)).toEqual([P]);
  });

  it("guard: a pipeline that ends before the shell, a redirection into a file, || at the line's end and assignments stay free", () => {
    expect(found(`${shown}\n{ cat <<'X'\nhallo\nX\n} 2>"/tmp/a b" > /tmp/log; echo ok\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\n{ cat <<'X'\nhallo\nX\n} | tee /tmp/log | grep -c x\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\nf() { echo hi; }\nf | tee /tmp/log | grep -c x\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\nexec > >(tee /tmp/log)\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\ntrue ||\n  echo nie\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\na[0]=$(cat <<'X'\nhallo\nX\n)\nx="a b"\n${pin}\n${P}`)).toEqual([]);
    expect(found(`${shown}\nprintf '%s\\n' "a;b" | tee /tmp/l\n${pin}\n${P}`)).toEqual([]);
  });
});

describe("hash-pinned scripts: nested ; in the pipeline, | # comment, wrapper options and quoted assignments before bash <(…), coproc, source over other fds, rbash, aliases (Nacharbeit 2, t_72c02efd)", () => {
  const P = "/opt/x/run.sh";
  const pin = `echo "${HASH}  ${P}" | sha256sum -c -`;
  const found = (run: string) => hiddenPinnedScripts(manifest([{ name: "s1", run }]) as never).map(({ path }) => path);
  const shown = `cat > ${P} <<'EOF'\necho gut\nEOF`;
  const evil = `cp /tmp/boese ${P}`;
  // Zweitprüfung t_219850ba (N1–N9): real bash runs the cp, the tool took it for
  // content. Gegenprobe with bash: /opt/data/out/t_219850ba/e, /opt/data/out/t_72c02efd.
  const forms = (q: string): Array<[string, string]> => {
    const body = `${evil}\nX`;
    const fn = `f() {\ncat <<${q}\n${body}\n}\n`;
    return [
      // N1: a ; && || in a substitution, subshell, group or block ends no pipeline
      ["cat <<X | (cat;true) | bash", `cat <<${q} | (cat;true) | bash\n${body}`],
      ["cat <<X | tee $(true; echo /dev/null) | bash", `cat <<${q} | tee $(true; echo /dev/null) | bash\n${body}`],
      ["cat <<X | tee `true; echo /dev/null` | bash", `cat <<${q} | tee \`true; echo /dev/null\` | bash\n${body}`],
      ["cat <<X | tee >(true; cat >/dev/null) | bash", `cat <<${q} | tee >(true; cat >/dev/null) | bash\n${body}`],
      ["} | tee $(true;echo /dev/null) | bash", `{ cat <<${q}\n${body}\n} | tee $(true;echo /dev/null) | bash`],
      ["} | (cat;true) | bash", `{ cat <<${q}\n${body}\n} | (cat;true) | bash`],
      ["f | (cat;true) | bash", `${fn}f | (cat;true) | bash`],
      ["f | tee $(:;echo /dev/null) | bash", `${fn}f | tee $(:;echo /dev/null) | bash`],
      ["cat <<X | ( : ; bash )", `cat <<${q} | ( : ; bash )\n${body}`],
      ["cat <<X | { :; bash; }", `cat <<${q} | { :; bash; }\n${body}`],
      ["cat <<X | if :; then bash; fi", `cat <<${q} | if :; then bash; fi\n${body}`],
      ["cat <<X | while :; do bash; break; done", `cat <<${q} | while :; do bash; break; done\n${body}`],
      ["cat <<X | for i in 1; do bash; done", `cat <<${q} | for i in 1; do bash; done\n${body}`],
      ["cat <<X | (true; (cat)) | bash", `cat <<${q} | (true; (cat)) | bash\n${body}`],
      ["cat <<X | (true && cat) | bash", `cat <<${q} | (true && cat) | bash\n${body}`],
      // N2: | at the line's end before a comment
      ["} | # k⏎bash", `{ cat <<${q}\n${body}\n} | # k\nbash`],
      ["cat <<X | # k⏎body⏎bash", `cat <<${q} | # k\n${body}\nbash`],
      ["f | # k⏎bash", `${fn}f | # k\nbash`],
      ["cat <<X |# k⏎body⏎bash", `cat <<${q} |# k\n${body}\nbash`],
      // N3: a wrapper with option arguments in front of bash <(…)
      ["env -u Z bash <(cat <<X)", `env -u Z bash <(cat <<${q})\n${body}`],
      ["stdbuf -o L bash <(cat <<X)", `stdbuf -o L bash <(cat <<${q})\n${body}`],
      ["setpriv bash <(cat <<X)", `setpriv bash <(cat <<${q})\n${body}`],
      ["flock /tmp/l bash <(cat <<X)", `flock /tmp/l bash <(cat <<${q})\n${body}`],
      ["sudo -u root bash <(cat <<X)", `sudo -u root bash <(cat <<${q})\n${body}`],
      ["sudo -u root bash <(f)", `${fn}sudo -u root bash <(f)`],
      ["nice -n 5 bash <(cat <<X)", `nice -n 5 bash <(cat <<${q})\n${body}`],
      ["timeout -s KILL 9 bash <(cat <<X)", `timeout -s KILL 9 bash <(cat <<${q})\n${body}`],
      // N4: quoted assignments in front of it
      ["x=\"a b\" bash <(cat <<X)", `x="a b" bash <(cat <<${q})\n${body}`],
      ["x=\"a b\" source <(cat <<X)", `x="a b" source <(cat <<${q})\n${body}`],
      ["x=\"a b\" . <(cat <<X)", `x="a b" . <(cat <<${q})\n${body}`],
      ["x=\"a b\" eval \"$(cat <<X)\"", `x="a b" eval "$(cat <<${q})"\n${body}`],
      ["x='a;b' $(cat <<X)", `x='a;b' $(cat <<${q})\n${body}`],
      ["x='a|b' $(cat <<X)", `x='a|b' $(cat <<${q})\n${body}`],
      ["x='a;b' bash <(cat <<X)", `x='a;b' bash <(cat <<${q})\n${body}`],
      ["x=\"a;b\" bash <(cat <<X)", `x="a;b" bash <(cat <<${q})\n${body}`],
      // N5: coproc
      ["coproc bash; cat <<X >&${COPROC[1]}", `coproc bash\ncat <<${q} >&\${COPROC[1]}\n${body}`],
      ["coproc S { bash; }; cat <<X >&${S[1]}", `coproc S { bash; }\ncat <<${q} >&\${S[1]}\n${body}`],
      ["coproc S {⏎bash⏎}", `coproc S {\nbash\n}\ncat <<${q} >&\${S[1]}\n${body}`],
      // N6: source over another fd or path
      ["source /dev/fd/3 3<<X", `source /dev/fd/3 3<<${q}\n${body}`],
      [". /dev/fd/3 3<<X", `. /dev/fd/3 3<<${q}\n${body}`],
      ["source /proc/self/fd/3 3<<X", `source /proc/self/fd/3 3<<${q}\n${body}`],
      ["cat <<X | source //dev/stdin", `cat <<${q} | source //dev/stdin\n${body}`],
      ["cat <<X | source /dev/./stdin", `cat <<${q} | source /dev/./stdin\n${body}`],
      ["cat <<X | . /proc/thread-self/fd/0", `cat <<${q} | . /proc/thread-self/fd/0\n${body}`],
      ["source //dev/stdin <<X", `source //dev/stdin <<${q}\n${body}`],
      [". /proc/$$/fd/3 3<<X", `. /proc/$$/fd/3 3<<${q}\n${body}`],
      // N7: rbash
      ["cat <<X | rbash", `cat <<${q} | rbash\n${body}`],
      ["rbash <<X", `rbash <<${q}\n${body}`],
      ["} | rbash", `{ cat <<${q}\n${body}\n} | rbash`],
      ["rbash <(cat <<X)", `rbash <(cat <<${q})\n${body}`],
      // N8: aliases
      ["shopt -s expand_aliases; alias b=bash; cat <<X | b", `shopt -s expand_aliases\nalias b=bash\ncat <<${q} | b\n${body}`],
      // N9: a call the plan does not name, and a function that reads the body
      ["g=f; $g | bash", `${fn}g=f; $g | bash`],
      ["eval f | bash", `${fn}eval f | bash`],
      ["$(echo f) | bash", `${fn}$(echo f) | bash`],
      ["b() { bash; }; cat <<X | b", `b() { bash; }\ncat <<${q} | b\n${body}`],
    ];
  };
  for (const q of ["X", "'X'"]) {
    for (const [name, run] of forms(q)) {
      it(`Nacharbeit 2: ${name} (${q === "X" ? "unquoted" : "quoted"})`, () => {
        expect(found(`${shown}\n${run}\n${pin}\n${P}`)).toEqual([P]);
      });
      it(`Nacharbeit 2: ${name} (${q === "X" ? "unquoted" : "quoted"}, pin before)`, () => {
        expect(found(`${shown}\n${pin}\n${run}\n${P}`)).toEqual([P]);
      });
    }
  }

  it("guard: pipelines into files, assignments, comments, blocks and functions without a shell stay free", () => {
    const free = [
      `cat <<'X' | tee /tmp/a | wc -l\nhallo\nX`,
      `cat <<'X' | grep h | sort > /tmp/a\nhallo\nX`,
      `{ cat <<'X'\nhallo\nX\n} > /tmp/a\nls | wc -l`,
      `cat <<'X' > /tmp/a # a | b\nhallo\nX`,
      `f() {\ncat <<'X'\nhallo\nX\n}\nf > /tmp/a`,
      `cat <<'X' | (cd /tmp && cat > a)\nhallo\nX`,
      `cat <<'X' | (cd /tmp; cat > a)\nhallo\nX`,
      `x="$(date)"; echo "$x"`,
      `echo "a; b $(date)"`,
      `for f in a b; do echo $f; done | wc -l`,
      `if true; then echo a; fi; ls | wc -l`,
      `ls | grep -c x # zaehlen`,
      `f() { echo hi; }\nf > /tmp/a`,
      `diff <(sort /tmp/a) <(sort /tmp/b) || true`,
      `grep -q bash /etc/shells`,
    ];
    for (const run of free) {
      expect(found(`${shown}\n${run}\n${pin}\n${P}`)).toEqual([]);
      expect(found(`${shown}\n${pin}\n${run}\n${P}`)).toEqual([]);
    }
  });
});
