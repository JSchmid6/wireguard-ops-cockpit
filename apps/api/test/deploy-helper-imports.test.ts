import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Jeder relative Import eines installierten Helfers muss im selben Deploy
// mitinstalliert werden (16.10.2026: Lab0 installierte cockpit-host-run ohne
// cockpit-state-steps.mjs → ERR_MODULE_NOT_FOUND im Root-Helfer). Die Helfer
// liegen nebeneinander in LIB, also muss `./x.mjs` dort als genau diese Quelle liegen.

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const LIB = "/usr/local/lib/wireguard-ops-cockpit";

type Installed = Map<string, string>; // Zielname in LIB → Quelle (repo-relativ)

function vpsInstalled(): Installed {
  const text = readFileSync(join(REPO, "deploy/vps/vps-cockpit-deploy.sh"), "utf8");
  const out: Installed = new Map();
  for (const m of text.matchAll(/^\s*"([^"|#]+)\|\$LIB\/([^"|]+)\|\d+"/gm)) {
    out.set(m[2], m[1]);
  }
  return out;
}

function lab0Installed(): Installed {
  const text = readFileSync(join(REPO, "deploy/lab0/homeserver-cockpit-deploy.sh"), "utf8");
  const out: Installed = new Map();
  const re = /^install\b[^\n]*"\$COCKPIT_DIR\/([^"]+)"\s*\\\n\s*(\S+)/gm;
  for (const m of text.matchAll(re)) {
    if (m[2].startsWith(`${LIB}/`)) out.set(m[2].slice(LIB.length + 1), m[1]);
  }
  return out;
}

function relativeImports(source: string): string[] {
  const text = readFileSync(join(REPO, source), "utf8");
  const specs = new Set<string>();
  for (const m of text.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g)) specs.add(m[1]);
  for (const m of text.matchAll(/\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) specs.add(m[1]);
  for (const m of text.matchAll(/^\s*import\s*["'](\.{1,2}\/[^"']+)["']/gm)) specs.add(m[1]);
  return [...specs].map((spec) => relative(REPO, join(REPO, dirname(source), spec)));
}

// Fehlende Importe, transitiv über alle installierten Module: "<importeur> → <ziel>".
function missingImports(installed: Installed): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue = [...installed.entries()];
  while (queue.length > 0) {
    const [name, source] = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const dep of relativeImports(source)) {
      const want = basename(dep);
      if (installed.get(want) !== dep) {
        missing.push(`${name} → ${want} (Quelle ${dep})`);
        continue;
      }
      queue.push([want, dep]);
    }
  }
  return missing;
}

describe.each([
  ["vps", vpsInstalled],
  ["lab0", lab0Installed],
])("%s deploy: installierte Helfer bringen ihre Importe mit", (_name, collect) => {
  const installed = collect();

  it("findet die Tür im Deploy (Parser greift)", () => {
    expect(installed.get("cockpit-host-run.mjs")).toBe("deploy/helpers/cockpit-host-run");
    expect(installed.get("cockpit-backup-guard.mjs")).toBe("deploy/helpers/cockpit-backup-guard.mjs");
  });

  it("jeder relative Import liegt als dieselbe Quelle in LIB", () => {
    expect(missingImports(installed)).toEqual([]);
  });
});
