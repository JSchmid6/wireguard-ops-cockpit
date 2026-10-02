import { cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import RetentionPanel from "./RetentionPanel";

// Wie in BorgPanel.test.tsx: unter Last braucht der erste Render bis ~1 s.
configure({ asyncUtilTimeout: 5000 });

const bounds = {
  keepDaily: { floor: 1, min: 3, max: 30 },
  keepWeekly: { floor: 0, min: 2, max: 12 },
  keepMonthly: { floor: 0, min: 0, max: 24 },
};

function view(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    note: null,
    bounds,
    window: { earliest: "04:00", latest: "22:00" },
    report: {
      measuredAt: "2026-10-02T10:00:00.000Z",
      host: "lab0",
      installed: { service: true, timer: true, passphrase: "ok" },
      settings: { keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "06:00", approved: false, changedAt: null, source: "default" },
      settingsError: null,
      timer: { active: "active", next: "2026-10-03T04:00:00.000Z" },
      service: { active: "inactive" },
      state: { status: "ok", anomaly: null, approval: null, baselineAt: "2026-10-02T04:00:10.000Z" },
      inventory: { at: "2026-10-02T04:00:10.000Z", count: 3, archives: [{ name: "vmd61162-2026-10-02T00:37:11", time: null }] },
      space: { totalBytes: 6_000_000_000_000, freeBytes: 780_000_000_000, usedPercent: 87 },
      repoStats: { uniqueCompressedBytes: 4_600_000_000_000 },
      runs: [{ start: "2026-10-02T04:00:00.000Z", end: "2026-10-02T04:01:00.000Z", result: "ok", before: 5, after: 3, pruned: 2, compacted: true, compactSkipped: null, note: null }],
      ...overrides,
    },
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    const { status = 200, body } = handler(String(input), init);
    return { ok: status < 400, status, json: async () => body } as Response;
  }));
  return calls;
}

describe("RetentionPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows status, space, inventory and the last runs", async () => {
    stubFetch(() => ({ body: view() }));
    render(<RetentionPanel />);
    await waitFor(() => expect(screen.getByTestId("retention-status").textContent).toContain("ok"));
    expect(screen.getByTestId("retention-space").textContent).toContain("780.0 GB free of 6.0 TB (87 % used)");
    expect(screen.getByTestId("retention-inventory").textContent).toContain("3 archive(s)");
    expect(screen.getByTestId("retention-runs").textContent).toContain("5 → 3");
    expect(screen.getByText("min 3, max 30")).toBeTruthy();
  });

  it("saves a change inside the bounds without asking for approval", async () => {
    const calls = stubFetch(() => ({ body: view() }));
    const user = userEvent.setup();
    render(<RetentionPanel />);
    const daily = await screen.findByDisplayValue("3");
    await user.clear(daily);
    await user.type(daily, "7");
    await user.click(screen.getByRole("button", { name: "Save retention" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")!.body).toEqual({ keepDaily: 7, keepWeekly: 2, keepMonthly: 0, time: "06:00" });
  });

  it("asks for Jochen's approval below the minimum and sends it with the change", async () => {
    const calls = stubFetch(() => ({ body: view() }));
    const user = userEvent.setup();
    render(<RetentionPanel />);
    const daily = await screen.findByDisplayValue("3");
    await user.clear(daily);
    await user.type(daily, "2");
    await user.click(screen.getByRole("button", { name: "Save retention" }));
    expect((await screen.findByTestId("retention-needs-approval")).textContent).toContain("keep daily 2 is below the minimum 3");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    const save = screen.getByRole("button", { name: "Approve and save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(screen.getByLabelText(/I approve keeping fewer backups/));
    await user.type(screen.getByPlaceholderText("reason (at least 10 characters)"), "RAID ist voll");
    await user.click(save);
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")!.body).toMatchObject({ keepDaily: 2, approval: { confirmed: true, reason: "RAID ist voll" } });
  });

  it("shows a halted service with the missing archives and resumes only after approval", async () => {
    const halted = view({
      state: { status: "angehalten", anomaly: { id: "0123456789abcdef", detectedAt: "2026-10-02T04:00:05.000Z", count: 1, missing: [{ id: "a".repeat(64), name: "vmd61162-2026-09-30T00:37:11" }] }, approval: null, baselineAt: null },
    });
    const calls = stubFetch(() => ({ body: halted }));
    const user = userEvent.setup();
    render(<RetentionPanel />);
    const anomaly = await screen.findByTestId("retention-anomaly");
    expect(anomaly.textContent).toContain("vmd61162-2026-09-30T00:37:11");
    expect(anomaly.textContent).toContain("Nothing was compacted");
    expect(screen.getByTestId("retention-status").textContent).toContain("halted");
    const resume = screen.getByRole("button", { name: "Approve and resume" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    await user.click(screen.getByLabelText(/I approve: these archives are gone/));
    await user.type(screen.getAllByPlaceholderText("reason (at least 10 characters)")[0], "habe ich selbst gelöscht");
    await user.click(resume);
    await waitFor(() => expect(calls.some((call) => call.url === "/api/borg/retention/resume")).toBe(true));
    expect(calls.find((call) => call.url === "/api/borg/retention/resume")!.body).toEqual({ anomalyId: "0123456789abcdef", approval: { confirmed: true, reason: "habe ich selbst gelöscht" } });
  });

  it("shows the server's refusal", async () => {
    stubFetch((_url, init) => (init?.method === "PUT" ? { status: 502, body: { message: "the retention helper refused or failed: needs Jochen's approval" } } : { body: view() }));
    const user = userEvent.setup();
    render(<RetentionPanel />);
    const daily = await screen.findByDisplayValue("3");
    await user.clear(daily);
    await user.type(daily, "4");
    await user.click(screen.getByRole("button", { name: "Save retention" }));
    expect((await screen.findByTestId("retention-error")).textContent).toContain("the retention helper refused");
  });

  it("says honestly when the service is not on this host", async () => {
    stubFetch(() => ({ body: { available: false, note: "sudo: [pfad] command not found", bounds, window: { earliest: "04:00", latest: "22:00" }, report: null } }));
    render(<RetentionPanel />);
    expect((await screen.findByTestId("retention-unavailable")).textContent).toContain("command not found");
    expect((screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
