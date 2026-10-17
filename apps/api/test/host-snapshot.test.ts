import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Harness for Lab0's net of the general door (deploy/helpers/cockpit-host-snapshot).
// The helper runs for real (python3, GNU tar); /etc is a fixture below the
// harness root, dpkg-query and systemctl are stubs on PATH.

const HELPER = fileURLToPath(new URL("../../../deploy/helpers/cockpit-host-snapshot", import.meta.url));

let dir: string;

function write(file: string, content: string, mode = 0o755) {
  writeFileSync(file, content);
  chmodSync(file, mode);
}

function snap(args: string[], extra: Record<string, string> = {}) {
  const out = spawnSync("python3", [HELPER, ...args], {
    encoding: "utf8", timeout: 60_000,
    env: {
      PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
      COCKPIT_HOST_SNAPSHOT_ROOT: path.join(dir, "root"),
      COCKPIT_HOST_SNAPSHOT_STORE: path.join(dir, "store"),
      COCKPIT_HOST_SNAPSHOT_MARGIN: "0",
      ...extra,
    },
  });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "host-snapshot-"));
  mkdirSync(path.join(dir, "root", "etc", "systemd", "system"), { recursive: true });
  writeFileSync(path.join(dir, "root", "etc", "systemd", "system", "android-emulator.service"), "[Service]\nExecStart=/bin/true\n");
  writeFileSync(path.join(dir, "root", "etc", "hostname"), "lab0\n");
  mkdirSync(path.join(dir, "bin"));
  write(path.join(dir, "bin", "dpkg-query"), `#!/bin/bash\n[ -e "${dir}/dpkg-fail" ] && { echo 'dpkg: database locked' >&2; exit 2; }\nprintf 'adb\\t1:34\\tii \\n'\n`);
  write(path.join(dir, "bin", "systemctl"), "#!/bin/bash\necho \"systemctl $*\"\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("cockpit-host-snapshot", () => {
  it("copies /etc, the package selection and the unit states into a complete, private snapshot", () => {
    const out = snap(["create", "cockpit-run-98a12e31"]);
    expect(out.code).toBe(0);
    const result = JSON.parse(out.stdout);
    expect(result.snapshot).toMatchObject({ snapshotId: "cockpit-run-98a12e31", name: "cockpit-run-98a12e31" });
    expect(result.rotated).toBeNull();
    const target = path.join(dir, "store", "cockpit-run-98a12e31");
    expect(statSync(path.join(dir, "store")).mode & 0o777).toBe(0o700);
    const manifest = JSON.parse(readFileSync(path.join(target, "manifest.json"), "utf8"));
    expect(manifest.complete).toBe(true);
    expect(Object.keys(manifest.files).sort()).toEqual(["etc.tar.gz", "packages.tsv", "unit-files.txt", "units.txt"]);
    for (const file of readdirSync(target)) expect(statSync(path.join(target, file)).mode & 0o777).toBe(0o600);
    const listed = spawnSync("tar", ["--list", "--gzip", "--file", path.join(target, "etc.tar.gz")], { encoding: "utf8" });
    expect(listed.stdout).toContain("etc/systemd/system/android-emulator.service");
    expect(readFileSync(path.join(target, "packages.tsv"), "utf8")).toContain("adb\t1:34");
    expect(readFileSync(path.join(target, "units.txt"), "utf8")).toContain("systemctl list-units --all");
  });

  it("keeps the newest KEEP snapshots and rotates only its own name form", () => {
    mkdirSync(path.join(dir, "store", "fremd"), { recursive: true });
    for (const name of ["cockpit-run-a", "cockpit-run-b"]) expect(snap(["create", name], { COCKPIT_HOST_SNAPSHOT_KEEP: "2" }).code).toBe(0);
    // Same second is possible: order by creation time, then name.
    const third = JSON.parse(snap(["create", "cockpit-run-c"], { COCKPIT_HOST_SNAPSHOT_KEEP: "2" }).stdout);
    expect(third.rotated).toEqual({ snapshotId: "cockpit-run-a" });
    expect(readdirSync(path.join(dir, "store")).sort()).toEqual(["cockpit-run-b", "cockpit-run-c", "fremd"]);
    const listed = JSON.parse(snap(["list"]).stdout);
    expect(listed.snapshots.map((item: { name: string }) => item.name)).toEqual(["cockpit-run-b", "cockpit-run-c"]);
  });

  it("refuses a foreign name, an existing snapshot and a full disk", () => {
    expect(snap(["create", "../etc"]).code).toBe(64);
    expect(snap(["create", "cockpit-run-x"]).code).toBe(0);
    expect(snap(["create", "cockpit-run-x"]).code).toBe(65);
    const full = snap(["create", "cockpit-run-y"], { COCKPIT_HOST_SNAPSHOT_MARGIN: String(2 ** 60) });
    expect(full.code).toBe(66);
    expect(existsSync(path.join(dir, "store", "cockpit-run-y"))).toBe(false);
    expect(snap(["delete", "cockpit-run-x"]).code).toBe(64);
  });

  it("leaves no half snapshot when a part fails", () => {
    writeFileSync(path.join(dir, "dpkg-fail"), "");
    const out = snap(["create", "cockpit-run-z"]);
    expect(out.code).toBe(67);
    expect(JSON.parse(out.stderr).error).toContain("database locked");
    expect(readdirSync(path.join(dir, "store"))).toEqual([]);
  });

  it("refuses a store that belongs to someone else or is no directory", () => {
    writeFileSync(path.join(dir, "store"), "not a directory");
    expect(snap(["create", "cockpit-run-q"]).code).toBe(65);
  });
});
