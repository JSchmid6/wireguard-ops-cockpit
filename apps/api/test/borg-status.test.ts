import { describe, expect, it } from "vitest";
import {
  borgStatusRequestDigest,
  createBorgStatusService,
  parseBorgStatusReport,
  sanitizeReason,
  BORG_STATUS_MARKER,
} from "../src/borg-status.js";

// Ein Block, wie `cockpit-borg-action status` ihn schreibt. Die Zahlen sind der
// echte Stand des VPS vom 28.09.2026 (letzter Lauf 02:26–02:56, rc 0; der letzte
// echte Check vom 21.09. mit rc 2; danach übersprungen, weil borgmatic den Check
// nur nach seiner Frequenz fährt) — nachgestellt als Beispiel, nicht gemessen.
const VPS_BLOCK = [
  "cockpit-borg-action status — 2026-09-28T11:40:00+02:00",
  "Host: vmd61162.contaboserver.net",
  "Rolle: VPS (borgmatic vorhanden, Repo-Schlüssel bleibt hier)",
  "",
  "== VPS: borgmatic ==",
  "Timer: active",
  "",
  BORG_STATUS_MARKER,
  "schema=cockpit-borg-status/v1",
  "measured_at=2026-09-28T11:40:00+02:00",
  "host=vmd61162.contaboserver.net",
  "role=vps",
  "timer_unit=borgmatic.timer",
  "timer_active=active",
  "timer_next=2026-09-29T23:53:08Z",
  "last_run_start=2026-09-28T02:26:10+02:00",
  "last_run_end=2026-09-28T02:56:06+02:00",
  "last_run_result=success",
  "last_run_exit=0",
  "maintenance_running=no",
  "maintenance_unit=cockpit-borg-check-20260921T034512Z",
  "maintenance_kind=check",
  "maintenance_rc=2",
  "maintenance_end=2026-09-21T05:12:44+02:00",
  "maintenance_source=unit-journal",
  "scheduled_check=skipped",
  "scheduled_check_at=2026-09-28T02:56:05+02:00",
  "",
].join("\n");

function blockWith(...lines: string[]): string {
  return [BORG_STATUS_MARKER, "schema=cockpit-borg-status/v1", ...lines].join("\n");
}

describe("parseBorgStatusReport", () => {
  it("liest den echten Stand: letzter Lauf, Exit-Status und Check-Ergebnis", () => {
    const snapshot = parseBorgStatusReport(VPS_BLOCK);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.generatedAt).toBe("2026-09-28T11:40:00+02:00");
    expect(snapshot?.host).toBe("vmd61162.contaboserver.net");
    expect(snapshot?.role).toBe("vps");
    expect(snapshot?.timer).toEqual({
      unit: "borgmatic.timer",
      active: "active",
      next: "2026-09-29T23:53:08Z",
      source: "systemctl list-timers <timer> --output=json",
    });
    expect(snapshot?.lastRun.start).toBe("2026-09-28T02:26:10+02:00");
    expect(snapshot?.lastRun.end).toBe("2026-09-28T02:56:06+02:00");
    expect(snapshot?.lastRun.result).toBe("success");
    expect(snapshot?.lastRun.exitStatus).toBe(0);
    expect(snapshot?.lastRun.source).toBe("journalctl -u borgmatic + systemctl show borgmatic.service");
    expect(snapshot?.check).toEqual({
      state: "failed",
      rc: 2,
      at: "2026-09-21T05:12:44+02:00",
      unit: "cockpit-borg-check-20260921T034512Z",
      kind: "check",
      source: "journalctl -u cockpit-borg-check-20260921T034512Z",
    });
    expect(snapshot?.scheduledCheck).toEqual({
      state: "skipped",
      at: "2026-09-28T02:56:05+02:00",
      source: "journalctl -u borgmatic (Konsistenzprüfung)",
    });
  });

  it("meldet grün nur mit rc=0 aus einem echten Lauf", () => {
    const snapshot = parseBorgStatusReport(
      blockWith(
        "maintenance_running=no",
        "maintenance_unit=cockpit-borg-check-20260928T120000Z",
        "maintenance_kind=check",
        "maintenance_rc=0",
        "maintenance_end=2026-09-28T13:40:00+02:00",
        "maintenance_source=unit-journal",
        "scheduled_check=skipped",
        "scheduled_check_at=2026-09-28T02:56:05+02:00",
      ),
    );
    expect(snapshot?.check.state).toBe("ok");
    expect(snapshot?.check.rc).toBe(0);
    expect(snapshot?.check.unit).toBe("cockpit-borg-check-20260928T120000Z");
  });

  it("nennt einen laufenden Check laufend und repariert nichts daran", () => {
    const snapshot = parseBorgStatusReport(
      blockWith("maintenance_running=yes", "maintenance_unit=cockpit-borg-repair-20260928T120000Z", "maintenance_kind=repair"),
    );
    expect(snapshot?.check.state).toBe("running");
    expect(snapshot?.check.rc).toBeNull();
    expect(snapshot?.check.kind).toBe("repair");
    expect(snapshot?.check.source).toBe("systemctl is-active cockpit-borg-repair-20260928T120000Z");
  });

  it("nimmt den übersprungenen Nachtcheck als eigenen Wert und nie als grün", () => {
    const snapshot = parseBorgStatusReport(
      blockWith("maintenance_running=no", "scheduled_check=skipped", "scheduled_check_at=2026-09-28T02:56:05+02:00"),
    );
    expect(snapshot?.scheduledCheck.state).toBe("skipped");
    expect(snapshot?.check.state).toBe("skipped");
    expect(snapshot?.check.rc).toBeNull();
    expect(snapshot?.check.source).toBe("journalctl -u borgmatic (Konsistenzprüfung)");
  });

  it("übernimmt einen roten Nachtcheck als Befund, aber ohne rc", () => {
    const snapshot = parseBorgStatusReport(
      blockWith("scheduled_check=failed", "scheduled_check_at=2026-09-21T03:45:06+02:00"),
    );
    expect(snapshot?.check.state).toBe("failed");
    expect(snapshot?.check.rc).toBeNull();
    expect(snapshot?.check.at).toBe("2026-09-21T03:45:06+02:00");
  });

  it("bleibt bei unbekannt, wenn der Block nichts über den Check sagt", () => {
    const snapshot = parseBorgStatusReport(blockWith("role=vps", "last_run_result=success"));
    expect(snapshot?.check.state).toBe("unknown");
    expect(snapshot?.scheduledCheck.state).toBe("unknown");
  });

  it("liefert null ohne Block — die Anzeige rät nicht", () => {
    expect(parseBorgStatusReport("nur Prosa, kein Datenblock")).toBeNull();
    expect(parseBorgStatusReport("")).toBeNull();
  });

  it("verwirft jede Zeile, die nicht in das Muster passt (auch Pfade und Freitext)", () => {
    const snapshot = parseBorgStatusReport(
      [
        BORG_STATUS_MARKER,
        "host=/etc/borgmatic/config.yaml",
        "role=admin; rm -rf /",
        "timer_unit=../../etc/passwd",
        "timer_active=$(id)",
        "timer_next=gestern",
        "last_run_start=2026-09-28 02:26:10",
        "last_run_exit=nan",
        "last_run_result=SUCCESS",
        "maintenance_unit=other-unit.service",
        "maintenance_kind=delete",
        "maintenance_rc=-1",
        "scheduled_check=gruen",
        "passphrase=hunter2",
        "nicht_erlaubter Schlüssel=wert",
      ].join("\n"),
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot?.host).toBeNull();
    expect(snapshot?.role).toBeNull();
    expect(snapshot?.timer.unit).toBeNull();
    expect(snapshot?.timer.active).toBeNull();
    expect(snapshot?.timer.next).toBeNull();
    expect(snapshot?.lastRun.start).toBeNull();
    expect(snapshot?.lastRun.exitStatus).toBeNull();
    expect(snapshot?.lastRun.result).toBeNull();
    expect(snapshot?.check.unit).toBeNull();
    expect(snapshot?.check.kind).toBeNull();
    expect(snapshot?.check.rc).toBeNull();
    expect(snapshot?.scheduledCheck.state).toBe("unknown");
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
  });

  it("liest nur den letzten Block, wenn eine Ausgabe zwei enthält", () => {
    const snapshot = parseBorgStatusReport([VPS_BLOCK, blockWith("last_run_result=exit-code", "last_run_exit=1")].join("\n"));
    expect(snapshot?.lastRun.result).toBe("exit-code");
    expect(snapshot?.lastRun.exitStatus).toBe(1);
  });

  it("verwirft überlange Werte, statt sie abzuschneiden", () => {
    const snapshot = parseBorgStatusReport(
      blockWith(`host=${"a".repeat(400)}`, `timer_unit=/usr/local/sbin/cockpit-borg-action-${"b".repeat(200)}`),
    );
    expect(snapshot?.host).toBeNull();
    expect(snapshot?.timer.unit).toBeNull();
  });
});

describe("borgStatusRequestDigest", () => {
  it("bindet die Leseabfrage an ihre Parameter", () => {
    const payload = { action: "borg.status", target: "state", expiresAt: "2026-09-28T12:00:00.000Z" };
    const digest = borgStatusRequestDigest(payload);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(borgStatusRequestDigest(payload)).toBe(digest);
    expect(borgStatusRequestDigest({ ...payload, expiresAt: "2026-09-28T12:01:00.000Z" })).not.toBe(digest);
    expect(borgStatusRequestDigest({ ...payload, target: "repo" })).not.toBe(digest);
  });
});

describe("sanitizeReason", () => {
  it("macht aus Fehlertexten eine Zeile und schwärzt Zugangsdaten", () => {
    const reason = sanitizeReason("sudo:\n  failed\r\npassphrase=hunter2 token: abc123");
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("hunter2");
    expect(reason).not.toContain("abc123");
    expect(reason).toContain("sudo:");
  });

  it("deckelt lange Texte", () => {
    expect(sanitizeReason("x".repeat(500)).length).toBe(200);
  });

  it("entfernt Pfade, URLs und Adressen — der Fehlerpfad trägt die rohe Helfer-Ausgabe", () => {
    const reason = sanitizeReason(
      "CRITICAL ssh://borg@10.0.0.5/media/RAID/backup_VServer/borg: Connection refused; host 10.0.0.5:22 unreachable\npassphrase=hunter2",
    );
    expect(reason).not.toContain("/media");
    expect(reason).not.toContain("ssh://");
    expect(reason).not.toContain("10.0.0.5");
    expect(reason).not.toContain("hunter2");
    expect(reason).toContain("[pfad]");
    expect(reason).toContain("[adresse]");
    expect(reason).toContain("Connection refused");
  });

  it("entfernt auch IPv6-Adressen, lässt aber eine Uhrzeit stehen", () => {
    const reason = sanitizeReason(
      "connect to fe80::1 and 2001:db8:0:0:1:2:3:4 and [2001:db8::5]:22 refused at 02:56:06",
    );
    expect(reason).not.toContain("fe80");
    expect(reason).not.toContain("2001");
    expect(reason).toContain("[adresse]");
    expect(reason).toContain("02:56:06");
  });
});

describe("createBorgStatusService", () => {
  it("sagt vor der ersten Messung ehrlich unknown", () => {
    const service = createBorgStatusService({ readReport: async () => VPS_BLOCK });
    expect(service.view()).toEqual({
      state: "unknown",
      measuring: false,
      measuredAt: null,
      ageSeconds: null,
      note: null,
      borg: null,
    });
  });

  it("misst, merkt sich den Stand und liefert ihn danach als frisch", async () => {
    let reads = 0;
    const service = createBorgStatusService({
      readReport: async () => { reads += 1; return VPS_BLOCK; },
      now: () => 1_000_000,
    });
    const first = await service.measure({ waitMs: 1000 });
    expect(reads).toBe(1);
    expect(first.state).toBe("fresh");
    expect(first.measuring).toBe(false);
    expect(first.measuredAt).toBe(new Date(1_000_000).toISOString());
    expect(first.ageSeconds).toBe(0);
    expect(first.borg?.lastRun.exitStatus).toBe(0);
    // Ein frischer Stand wird nicht noch einmal geholt.
    const second = await service.measure({ waitMs: 1000 });
    expect(reads).toBe(1);
    expect(second.state).toBe("fresh");
  });

  it("erzwingt auf Wunsch eine neue Messung", async () => {
    let reads = 0;
    const service = createBorgStatusService({ readReport: async () => { reads += 1; return VPS_BLOCK; } });
    await service.measure({ waitMs: 1000 });
    await service.measure({ waitMs: 1000, force: true });
    expect(reads).toBe(2);
  });

  it("misst nach Ablauf der Frische neu, ohne zu blockieren", async () => {
    let reads = 0;
    let clock = 0;
    const service = createBorgStatusService({
      readReport: async () => { reads += 1; return VPS_BLOCK; },
      now: () => clock,
      ttlMs: 1000,
    });
    await service.measure({ waitMs: 1000 });
    clock += 5000;
    expect(service.view().state).toBe("stale");
    const background = await service.measure({ waitMs: 0 });
    // Der alte Stand bleibt sichtbar, während im Hintergrund gemessen wird.
    expect(["stale", "fresh"]).toContain(background.state);
    expect(reads).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reads).toBe(2);
    expect(service.view().state).toBe("fresh");
  });

  it("führt nur eine Messung gleichzeitig aus", async () => {
    let reads = 0;
    const service = createBorgStatusService({
      readReport: async () => { reads += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return VPS_BLOCK; },
    });
    await Promise.all([service.measure({ waitMs: 1000 }), service.measure({ waitMs: 1000 })]);
    expect(reads).toBe(1);
  });

  it("gibt bei einer langsamen Messung 'measuring' zurück, statt zu hängen", async () => {
    const service = createBorgStatusService({ readReport: () => new Promise<string>(() => {}), maxWaitMs: 50 });
    const view = await service.measure({ waitMs: 30 });
    expect(view.state).toBe("measuring");
    expect(view.measuring).toBe(true);
    expect(view.borg).toBeNull();
  });

  it("meldet einen gescheiterten Lauf als Zustand samt Grund — ohne Pfade", async () => {
    const service = createBorgStatusService({
      readReport: async () => { throw new Error("sudo: /usr/local/sbin/cockpit-borg-action: command not found"); },
    });
    const view = await service.measure({ waitMs: 1000 });
    expect(view.state).toBe("failed");
    expect(view.note).toContain("command not found");
    expect(view.note).not.toContain("/usr/local/sbin");
    expect(view.note).toContain("[pfad]");
    expect(view.borg).toBeNull();
  });

  it("übernimmt die Werte, wenn der Helfer mit Befund endet (rc≠0) — und nennt den Grund", async () => {
    // So sieht der Fehlerpfad wirklich aus: der Broker hängt stderr und die
    // Helfer-Ausgabe aneinander, der Datenblock steht am Ende darin.
    const raw = [
      "CRITICAL ssh://borg@10.0.0.5/media/RAID/backup_VServer/borg: Connection refused",
      VPS_BLOCK,
    ].join("\n");
    const service = createBorgStatusService({ readReport: async () => { throw new Error(raw); } });
    const view = await service.measure({ waitMs: 1000 });
    expect(view.borg?.lastRun.end).toBe("2026-09-28T02:56:06+02:00");
    expect(view.borg?.lastRun.exitStatus).toBe(0);
    expect(view.borg?.check.state).toBe("failed");
    expect(view.note).toMatch(/^Messung mit Befund:/);
    expect(view.note).not.toContain("/media");
    expect(view.note).not.toContain("10.0.0.5");
    expect(view.note).not.toContain("ssh://");
  });

  it("bleibt bei einer Ausgabe ohne Datenblock bei failed und erfindet keine Werte", async () => {
    const service = createBorgStatusService({ readReport: async () => "== VPS: borgmatic ==\nTimer: active\n" });
    const view = await service.measure({ waitMs: 1000 });
    expect(view.state).toBe("failed");
    expect(view.note).toContain("Datenblock");
    expect(view.borg).toBeNull();
  });

  it("behält den letzten guten Stand sichtbar, wenn die neue Messung scheitert", async () => {
    let failNow = false;
    const service = createBorgStatusService({
      readReport: async () => {
        if (failNow) throw new Error("executor broker timed out");
        return VPS_BLOCK;
      },
    });
    await service.measure({ waitMs: 1000 });
    failNow = true;
    const view = await service.measure({ waitMs: 1000, force: true });
    expect(view.state).toBe("fresh");
    expect(view.note).toContain("timed out");
    expect(view.borg?.lastRun.result).toBe("success");
  });
});
