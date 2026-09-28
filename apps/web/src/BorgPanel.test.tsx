import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import BorgPanel from "./BorgPanel";

// Der gemessene Stand, wie ihn /api/borg/status liefert.
const measured = {
  state: "fresh",
  measuring: false,
  measuredAt: "2026-09-28T09:40:00.000Z",
  ageSeconds: 42,
  note: null,
  borg: {
    generatedAt: "2026-09-28T11:40:00+02:00",
    host: "vmd61162.contaboserver.net",
    role: "vps",
    timer: {
      unit: "borgmatic.timer",
      active: "active",
      next: "2026-09-29T23:53:08Z",
      source: "systemctl list-timers <timer> --output=json",
    },
    lastRun: {
      start: "2026-09-28T02:26:10+02:00",
      end: "2026-09-28T02:56:06+02:00",
      result: "success",
      exitStatus: 0,
      source: "journalctl -u borgmatic + systemctl show borgmatic.service",
    },
    check: {
      state: "failed",
      rc: 2,
      at: "2026-09-21T05:12:44+02:00",
      unit: "cockpit-borg-check-20260921T034512Z",
      kind: "check",
      source: "journalctl -u cockpit-borg-check-20260921T034512Z",
    },
    scheduledCheck: {
      state: "skipped",
      at: "2026-09-28T02:56:05+02:00",
      source: "journalctl -u borgmatic (Konsistenzprüfung)",
    },
  },
};

const emptyView = {
  state: "unknown",
  measuring: false,
  measuredAt: null,
  ageSeconds: null,
  note: null,
  borg: null,
};

const measuringView = { ...emptyView, state: "measuring", measuring: true };

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function stubFetch(responses: unknown[]) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const body = responses.length > 1 ? responses.shift() : responses[0];
    return jsonResponse(body);
  }));
  return calls;
}

describe("BorgPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("zeigt ohne Messung ehrlich unknown und erfindet keine Werte", async () => {
    stubFetch([emptyView]);

    render(<BorgPanel />);

    const unavailable = await screen.findByTestId("borg-unavailable");
    expect(unavailable.textContent).toContain("No measurement yet");
    expect(screen.queryByTestId("borg-last-run")).toBeNull();
  });

  it("zeigt letzter Lauf, Exit-Status, Check-Ergebnis und Quelle je Wert", async () => {
    stubFetch([measured]);

    render(<BorgPanel />);

    await waitFor(() => expect(screen.getByTestId("borg-last-run")).toBeTruthy());
    const lastRun = screen.getByTestId("borg-last-run");
    expect(lastRun.textContent).toContain("2026-09-28 02:56:06+02:00");
    expect(lastRun.textContent).toContain("success");
    expect(lastRun.textContent).toContain("exit 0");
    expect(lastRun.textContent).toContain("journalctl -u borgmatic + systemctl show borgmatic.service");

    const check = screen.getByTestId("borg-check");
    expect(check.textContent).toContain("Repository check (check)");
    expect(check.textContent).toContain("failed");
    expect(check.textContent).toContain("rc 2");
    expect(check.textContent).toContain("2026-09-21 05:12:44+02:00");
    expect(check.textContent).toContain("journalctl -u cockpit-borg-check-20260921T034512Z");

    const scheduled = screen.getByTestId("borg-scheduled-check");
    expect(scheduled.textContent).toContain("skipped");
    expect(scheduled.textContent).toContain("not a passed check");

    const timer = screen.getByTestId("borg-timer");
    expect(timer.textContent).toContain("borgmatic.timer");
    expect(timer.textContent).toContain("2026-09-29 23:53:08Z");

    expect(screen.getByTestId("borg-freshness").textContent).toContain("fresh");
  });

  it("fordert mit 'Measure now' eine neue Messung an (POST) und zeigt sie", async () => {
    const calls = stubFetch([emptyView, measured]);
    const user = userEvent.setup();

    render(<BorgPanel />);
    await screen.findByTestId("borg-unavailable");

    await user.click(screen.getByRole("button", { name: "Measure now" }));

    await waitFor(() => expect(screen.getByTestId("borg-last-run")).toBeTruthy());
    expect(calls).toContainEqual({ url: "/api/borg/status/refresh", method: "POST" });
  });

  it("holt nach, solange eine Messung läuft", async () => {
    vi.useFakeTimers();
    const calls = stubFetch([measuringView, measured]);

    render(<BorgPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls.length).toBe(1);
    expect(screen.getByTestId("borg-unavailable").textContent).toContain("measurement is running");

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(calls.length).toBe(2);
    expect(screen.getByTestId("borg-last-run").textContent).toContain("success");
  });

  it("meldet eine nicht erreichbare Route als Fehler, statt zu verschwinden", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "authentication required" }, false)));

    render(<BorgPanel />);

    expect((await screen.findByText(/authentication required/)).textContent).toBeTruthy();
    expect(screen.getByText("Borg backup")).toBeTruthy();
  });

  it("nennt den Grund, wenn eine Messung scheitert, und bleibt bei unknown", async () => {
    stubFetch([{ ...emptyView, state: "failed", note: "sudo: [pfad] command not found" }]);

    render(<BorgPanel />);

    const unavailable = await screen.findByTestId("borg-unavailable");
    expect(unavailable.textContent).toContain("command not found");
    expect(unavailable.textContent).not.toContain("/usr/local/sbin");
  });

  it("zeigt bei einer Messung mit Befund die Werte und daneben den Grund", async () => {
    // Der Helfer endete mit rc≠0 (z. B. Repo nicht erreichbar), hat aber Werte
    // geschrieben: die Anzeige zeigt sie und behauptet trotzdem nichts.
    stubFetch([{ ...measured, state: "fresh", note: "Messung mit Befund: CRITICAL [pfad] Connection refused" }]);

    render(<BorgPanel />);

    const lastRun = await screen.findByTestId("borg-last-run");
    expect(lastRun.textContent).toContain("exit 0");
    expect(screen.getByText(/Messung mit Befund:/).textContent).toBeTruthy();
  });
});
