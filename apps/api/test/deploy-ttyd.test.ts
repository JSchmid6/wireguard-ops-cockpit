import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ttyd im Deploy-Skript (deploy/lab0/homeserver-cockpit-deploy.sh, Block ttyd-logik):
// Debian trixie (Box) hat kein Paket ttyd, dort kommt das gepinnte Release-Binary.
// Der markierte Block läuft 1:1 in bash; apt-cache und curl sind Stubs, install
// verliert nur -o/-g (der Test läuft nicht als root).

const SCRIPT = fileURLToPath(new URL("../../../deploy/lab0/homeserver-cockpit-deploy.sh", import.meta.url));
const UNIT = fileURLToPath(new URL("../../../deploy/systemd/wireguard-ops-cockpit-ttyd.service", import.meta.url));
// SHA256SUMS von github.com/tsl0922/ttyd/releases/download/1.7.7, Zeile ttyd.x86_64 (gemessen 09.11.2026).
const PINNED_SHA = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55";

let dir: string;

function block(): string {
  const script = readFileSync(SCRIPT, "utf8");
  const start = script.indexOf("# >>> ttyd-logik");
  const end = script.indexOf("# <<< ttyd-logik");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

function stub(name: string, body: string) {
  const file = path.join(dir, "bin", name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

// candidate: was apt-cache policy als Candidate meldet; tail: Befehle nach dem Block.
function runBlock(candidate: string, tail: string) {
  stub("apt-cache", `printf 'ttyd:\\n  Installed: (none)\\n  Candidate: %s\\n' '${candidate}'`);
  const script = [
    "set -euo pipefail",
    'die() { echo "FEHLER: $*"; exit 1; }',
    'install() { local a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) a+=("$1"); shift;; esac; done; command install "${a[@]}"; }',
    block(),
    tail,
  ].join("\n");
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, TTYD_LOCAL: path.join(dir, "usr-local-bin", "ttyd") },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deploy-ttyd-"));
  spawnSync("mkdir", ["-p", path.join(dir, "bin")]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("deploy: ttyd", () => {
  it("pins version 1.7.7, the release sha256 and the x86_64 asset", () => {
    const b = block();
    expect(b).toContain('TTYD_VERSION="1.7.7"');
    expect(b).toContain(`TTYD_SHA256="${PINNED_SHA}"`);
    expect(b).toContain("https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64");
  });

  it("takes the apt package where apt has a candidate (Ubuntu: VPS, Lab0)", () => {
    const out = runBlock("1.7.4-1", 'echo "$TTYD_FROM_APT ${APT_PACKAGES[*]}"');
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("yes ca-certificates curl git tmux nginx openssl python3 sudo ttyd");
  });

  it("leaves ttyd out of the apt list without a candidate (Debian trixie)", () => {
    const out = runBlock("(none)", 'echo "$TTYD_FROM_APT ${APT_PACKAGES[*]}"');
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("no ca-certificates curl git tmux nginx openssl python3 sudo");
  });

  it("installs the downloaded binary when its sha256 matches", () => {
    const payload = "#!/bin/sh\necho fake-ttyd\n";
    stub("curl", `out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; printf '${payload.replace(/\n/g, "\\n")}' > "$out"`);
    const sha = createHash("sha256").update(payload).digest("hex");
    // Der Test setzt den Pin auf den Hash seiner Attrappe; geprüft wird der Ablauf, der Pin oben.
    const out = runBlock("(none)", `TTYD_SHA256=${sha}\nttyd_install_binary\nttyd_install_binary`);
    expect(out.status, out.stdout + out.stderr).toBe(0);
    const local = path.join(dir, "usr-local-bin", "ttyd");
    expect(readFileSync(local, "utf8")).toBe(payload);
    expect(out.stdout).toContain("sha256 geprüft");
    expect(out.stdout).toContain("schon vorhanden");
  });

  it("aborts without installing anything when the sha256 differs", () => {
    stub("curl", 'out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; echo manipuliert > "$out"');
    const out = runBlock("(none)", "ttyd_install_binary");
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("ttyd-Prüfsumme stimmt nicht");
    expect(existsSync(path.join(dir, "usr-local-bin", "ttyd"))).toBe(false);
  });

  it("starts ttyd by name so systemd finds the package or the release binary", () => {
    const unit = readFileSync(UNIT, "utf8");
    expect(unit).toMatch(/^ExecStart=ttyd -i 127\.0\.0\.1 -p 7681 /m);
    expect(unit).not.toContain("/usr/bin/ttyd");
  });
});
