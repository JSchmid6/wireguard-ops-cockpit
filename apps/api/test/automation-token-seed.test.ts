import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CockpitDatabase } from "../src/db.js";

// deploy/helpers/cockpit-automation-token-seed: James' bearer on a fresh box.
// Runs for real (python3, sqlite3) against a database the API itself created.

const HELPER = fileURLToPath(new URL("../../../deploy/helpers/cockpit-automation-token-seed", import.meta.url));
const SCOPES = fileURLToPath(new URL("../../../deploy/config/automation-scopes.json", import.meta.url));
const RAW = "ab".repeat(32);
const HASH = "271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a"; // sha256 of RAW, checked below

let dir: string;
let dbPath: string;

function inspect() {
  const db = new CockpitDatabase(dbPath);
  db.initialize();
  return db;
}

function seed(hashFile = path.join(dir, "hash"), scopes = SCOPES) {
  const out = spawnSync("python3", [HELPER, dbPath, hashFile, scopes], { encoding: "utf8" });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "token-seed-"));
  dbPath = path.join(dir, "cockpit.sqlite");
  const created = new CockpitDatabase(dbPath); created.initialize(); created.close();
  writeFileSync(path.join(dir, "hash"), `${HASH}\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("cockpit-automation-token-seed", () => {
  it("the fixture hash is sha256 of the hex part, as schluessel.py and db.ts compute it", async () => {
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(RAW).digest("hex")).toBe(HASH);
  });

  it("creates hermes-automation and the hermes-tresor token; the API then accepts exactly the scoped routes", () => {
    const out = seed();
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, action: "created", accountCreated: true, scopes: 13 });
    const identity = inspect().findUserByApiToken(`cpt_${RAW}`);
    expect(identity?.actor).toMatchObject({ username: "hermes-automation", role: "automation" });
    expect(identity?.scopes).toContain("POST /api/hermes/runbook");
    expect(identity?.scopes).not.toContain("POST /api/hermes/jobs/:jobId/approval");
    // The bootstrap hash seeds once: the file is consumed.
    expect(existsSync(path.join(dir, "hash"))).toBe(false);
    expect(existsSync(path.join(dir, "hash.used"))).toBe(true);
  });

  it("a token revoked by deleting its row does not come back: the hash file is gone after the first seed", () => {
    expect(seed().code).toBe(0);
    const raw = new Database(dbPath);
    raw.prepare("DELETE FROM api_tokens WHERE label = 'hermes-tresor'").run();
    raw.close();
    const again = seed();
    expect(again.code).not.toBe(0);
    expect(inspect().findUserByApiToken(`cpt_${RAW}`)).toBeNull();
  });

  it("keeps an existing hermes-tresor token (a rotation must survive every re-run)", () => {
    expect(seed().code).toBe(0);
    writeFileSync(path.join(dir, "hash"), `${"c".repeat(64)}\n`);
    const again = seed();
    expect(JSON.parse(again.stdout)).toMatchObject({ action: "kept", accountCreated: false });
    expect(existsSync(path.join(dir, "hash"))).toBe(false);
    expect(inspect().findUserByApiToken(`cpt_${RAW}`)).not.toBeNull();
  });

  it("refuses an account with another role, a malformed hash and a scope that is not a route", () => {
    const raw = new Database(dbPath);
    raw.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('x', 'hermes-automation', '!', 'admin', 'now')").run();
    raw.close();
    const promoted = seed();
    expect(promoted.code).toBe(65);
    expect(promoted.stderr).toContain("nothing changed");
    expect(existsSync(path.join(dir, "hash"))).toBe(true);   // not consumed on a refusal
    writeFileSync(path.join(dir, "bad-hash"), "nicht-hex\n");
    expect(seed(path.join(dir, "bad-hash")).code).toBe(65);
    writeFileSync(path.join(dir, "scopes.json"), JSON.stringify({ scopes: ["GET /api/me; rm -rf /"] }));
    expect(seed(undefined, path.join(dir, "scopes.json")).code).toBe(65);
  });

  it("refuses when the API has not created its database yet", () => {
    rmSync(dbPath);
    expect(seed().code).toBe(66);
  });
});
