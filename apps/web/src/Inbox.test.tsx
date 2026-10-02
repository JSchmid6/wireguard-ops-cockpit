import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Inbox, { countdown, statusLine, type InboxCard } from "./Inbox";

// "Wartet auf dich": Karten mit Frist, Befunden und Knöpfen; Grund ist Pflicht;
// ein abgelaufener Envelope bietet "Neu bestellen lassen" statt Freigeben.
// Die Handyansicht prüfen wir an den CSS-Regeln, die sie tragen (jsdom
// rechnet kein Layout): eine Spalte zuerst, große Knöpfe, nichts breiter als
// der Bildschirm.

configure({ asyncUtilTimeout: 5000 });

const status = {
  lastRuns: [{ id: "j0", status: "completed", at: new Date(Date.now() - 2 * 3_600_000).toISOString() }],
  backup: { lastRunEnd: new Date(Date.now() - 5 * 3_600_000).toISOString(), lastRunResult: "success", measuredAt: null },
  disk: { path: "/", freeBytes: 120e9, totalBytes: 400e9 },
};

function hermesCard(overrides: Partial<InboxCard> = {}): InboxCard {
  return {
    id: "job-j1", kind: "hermes-change", title: "Selbstupdate auf PR #25 einspielen.",
    reason: "The update reviewer flagged G1.", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), expired: false,
    link: "/#karte-job-j1", jobId: "j1",
    findings: [{ source: "update-review", title: "Doorkeeper approves root", guarantee: "G1", location: "apps/api/src/host-run.ts:461", severity: "high", detail: "no operator in the loop" }],
    ...overrides,
  };
}

function serve(cards: InboxCard[], answers: Record<string, { status: number; body: unknown }> = {}) {
  let current = cards;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/inbox") return { ok: true, status: 200, json: async () => ({ generatedAt: new Date().toISOString(), cards: current, reorders: [], status }) };
    const answer = answers[url] ?? { status: 200, body: { ok: true } };
    if (answer.status < 300 && init?.method === "POST") current = [];
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function posted(fetchMock: ReturnType<typeof serve>, url: string) {
  const call = fetchMock.mock.calls.find(([target, init]) => String(target) === url && (init as RequestInit | undefined)?.method === "POST");
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
}

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("helpers", () => {
  it("counts down and stops at the deadline", () => {
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    expect(countdown("2026-10-02T12:19:59.000Z", now)).toBe("19:59");
    expect(countdown("2026-10-02T13:05:09.000Z", now)).toBe("1:05:09");
    expect(countdown("2026-10-02T12:00:00.000Z", now)).toBeNull();
    expect(countdown("garbage", now)).toBeNull();
  });

  it("summarizes runs, backup age and disk in one line", () => {
    const now = Date.now();
    expect(statusLine(status, now)).toBe("Letzter Lauf vor 2 h (completed) · Backup vor 5 h (success) · Platte /: 120 GB frei von 400 GB");
    expect(statusLine({ lastRuns: [], backup: null, disk: null }, now)).toBe("Noch keine Läufe · Backup-Alter unbekannt · Plattenplatz unbekannt");
    expect(statusLine({ lastRuns: [{ id: "x", status: "failed", at: new Date(now - 10 * 60_000).toISOString() }], backup: { lastRunEnd: new Date(now - 72 * 3_600_000).toISOString(), lastRunResult: null, measuredAt: null }, disk: { path: "/", freeBytes: 5e9, totalBytes: 50e9 } }, now))
      .toBe("Letzter Lauf vor 10 min (failed) · Backup vor 3 Tagen · Platte /: 5.0 GB frei von 50.0 GB");
  });
});

describe("Wartet auf dich", () => {
  it("says loudly when nothing waits, with the state line below", async () => {
    serve([]);
    render(<Inbox />);
    expect(await screen.findByText("Nichts wartet auf dich")).toBeTruthy();
    expect(screen.getByTestId("inbox-status").textContent).toContain("Backup vor 5 h (success)");
    expect(screen.getByTestId("inbox-status").textContent).toContain("Platte /: 120 GB frei");
  });

  it("shows intent, reason, collapsed findings and the countdown, and approves only with a reason", async () => {
    const fetchMock = serve([hermesCard()]);
    const onDecided = vi.fn();
    const user = userEvent.setup();
    render(<Inbox onDecided={onDecided} />);

    expect(await screen.findByText("Selbstupdate auf PR #25 einspielen.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Wartet auf dich\s*\(1\)/ })).toBeTruthy();
    expect(screen.getByText(/The update reviewer flagged G1\./)).toBeTruthy();
    expect(screen.getByLabelText("Frist").textContent).toMatch(/läuft ab in (19|20):\d\d/);

    // Befund: Titel, Garantie, Datei und Zeile sichtbar; die Begründung ausklappbar.
    const details = screen.getByText("Doorkeeper approves root").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Update-Prüfer · G1 · apps/api/src/host-run.ts:461 · high");
    await user.click(screen.getByText("Doorkeeper approves root"));
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("no operator in the loop");

    const approve = screen.getByRole("button", { name: "Freigeben" }) as HTMLButtonElement;
    const reject = screen.getByRole("button", { name: "Ablehnen" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    await user.type(screen.getByLabelText(/Grund \(Pflicht\)/), "   ");
    expect(approve.disabled).toBe(true);
    await user.type(screen.getByLabelText(/Grund \(Pflicht\)/), "G1 ist gewollt, eine Tür");
    await user.click(approve);

    await waitFor(() => expect(posted(fetchMock, "/api/hermes/jobs/j1/approval")).toEqual({ decision: "approved", reason: "G1 ist gewollt, eine Tür" }));
    expect(await screen.findByText("Freigegeben: Selbstupdate auf PR #25 einspielen.")).toBeTruthy();
    expect(await screen.findByText("Nichts wartet auf dich")).toBeTruthy();
    expect(onDecided).toHaveBeenCalled();
  });

  it("rejects with the reason", async () => {
    const fetchMock = serve([hermesCard()]);
    const user = userEvent.setup();
    render(<Inbox />);
    await user.type(await screen.findByLabelText(/Grund \(Pflicht\)/), "nicht jetzt");
    await user.click(screen.getByRole("button", { name: "Ablehnen" }));
    await waitFor(() => expect(posted(fetchMock, "/api/hermes/jobs/j1/approval")).toEqual({ decision: "rejected", reason: "nicht jetzt" }));
  });

  it("offers a re-order instead of approval once the envelope expired", async () => {
    const fetchMock = serve([hermesCard({ expiresAt: new Date(Date.now() - 60_000).toISOString(), expired: true })]);
    const user = userEvent.setup();
    render(<Inbox />);
    expect(await screen.findByText("Abgelaufen")).toBeTruthy();
    expect(screen.getByText(/Die Frist ist abgelaufen/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Freigeben" })).toBeNull();
    await user.type(screen.getByLabelText("Notiz an James (optional)"), "bitte frisch prüfen");
    await user.click(screen.getByRole("button", { name: "Neu bestellen lassen" }));
    await waitFor(() => expect(posted(fetchMock, "/api/inbox/jobs/j1/reorder")).toEqual({ note: "bitte frisch prüfen" }));
    expect(await screen.findByText("Neu bestellt: Selbstupdate auf PR #25 einspielen.")).toBeTruthy();
  });

  it("decides plan approvals through the approval queue", async () => {
    const fetchMock = serve([{ ...hermesCard(), id: "approval-a1", kind: "approval", jobId: "jx", approvalId: "a1", findings: [] }]);
    const user = userEvent.setup();
    render(<Inbox />);
    expect(await screen.findByText("Freigabe")).toBeTruthy();
    await user.type(screen.getByLabelText(/Grund \(Pflicht\)/), "ok");
    await user.click(screen.getByRole("button", { name: "Freigeben" }));
    await waitFor(() => expect(posted(fetchMock, "/api/approvals/a1/decision")).toEqual({ decision: "approved", reason: "ok" }));
  });

  it("resumes the retention service only with a 10-character reason, or keeps it halted", async () => {
    const anomaly: InboxCard = { ...hermesCard(), id: "retention-0123456789abcdef", kind: "retention-anomaly", jobId: undefined, anomalyId: "0123456789abcdef", expiresAt: null, title: "Der Aufräum-Dienst auf Lab0 ist angehalten." };
    const fetchMock = serve([anomaly]);
    const user = userEvent.setup();
    render(<Inbox />);
    const field = await screen.findByLabelText(/mind\. 10 Zeichen/);
    expect(screen.queryByLabelText("Frist")).toBeNull();
    await user.type(field, "kurz");
    expect((screen.getByRole("button", { name: "Freigeben" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Ablehnen (angehalten lassen)" }));
    await waitFor(() => expect(posted(fetchMock, "/api/inbox/retention/0123456789abcdef/keep")).toEqual({ reason: "kurz" }));

    cleanup();
    const second = serve([anomaly]);
    render(<Inbox />);
    await user.type(await screen.findByLabelText(/mind\. 10 Zeichen/), "ich habe sie selbst gelöscht");
    await user.click(screen.getByRole("button", { name: "Freigeben" }));
    await waitFor(() => expect(posted(second, "/api/borg/retention/resume")).toEqual({ anomalyId: "0123456789abcdef", approval: { confirmed: true, reason: "ich habe sie selbst gelöscht" } }));
  });

  it("shows the server's refusal on the card and keeps it", async () => {
    serve([hermesCard()], { "/api/hermes/jobs/j1/approval": { status: 409, body: { message: "execution envelope validation failed" } } });
    const user = userEvent.setup();
    render(<Inbox />);
    await user.type(await screen.findByLabelText(/Grund \(Pflicht\)/), "los");
    await user.click(screen.getByRole("button", { name: "Freigeben" }));
    expect((await screen.findByRole("alert")).textContent).toBe("execution envelope validation failed");
    expect(screen.getByText("Selbstupdate auf PR #25 einspielen.")).toBeTruthy();
  });

  it("offers the re-order when the server refuses an approval as expired", async () => {
    const fetchMock = serve([hermesCard()], { "/api/hermes/jobs/j1/approval": { status: 409, body: { message: "execution envelope validation failed" } } });
    const user = userEvent.setup();
    render(<Inbox />);
    await user.type(await screen.findByLabelText(/Grund \(Pflicht\)/), "knapp");
    await user.click(screen.getByRole("button", { name: "Freigeben" }));
    expect(await screen.findByRole("button", { name: "Neu bestellen lassen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Freigeben" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Neu bestellen lassen" }));
    await waitFor(() => expect(posted(fetchMock, "/api/inbox/jobs/j1/reorder")).toEqual({ note: "knapp" }));
  });

  it("tells an expired plan approval to be planned again and only allows rejecting it", async () => {
    serve([{ ...hermesCard(), id: "approval-a1", kind: "approval", jobId: "jx", approvalId: "a1", findings: [], expired: true, expiresAt: new Date(Date.now() - 1000).toISOString() }]);
    render(<Inbox />);
    expect(await screen.findByText(/Plane den Lauf unter „Mehr“ neu/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Freigeben" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Neu bestellen lassen" })).toBeNull();
    expect(screen.getByLabelText(/Grund \(Pflicht\)/)).toBeTruthy();
  });

  it("shows a load error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ message: "authentication required" }) })));
    render(<Inbox />);
    expect((await screen.findByRole("alert")).textContent).toBe("authentication required");
  });

  it("jumps to the card from a direct link and says when it no longer waits", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.location.hash = "#karte-job-j1";
    serve([hermesCard(), hermesCard({ id: "job-j2", jobId: "j2", title: "Andere Änderung." })]);
    render(<Inbox />);
    const card = (await screen.findByText("Selbstupdate auf PR #25 einspielen.")).closest("article") as HTMLElement;
    expect(card.id).toBe("karte-job-j1");
    expect(card.className).toContain("inbox-card-highlight");
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(screen.getByText("Andere Änderung.").closest("article")!.className).not.toContain("inbox-card-highlight");

    cleanup();
    window.location.hash = "#karte-job-gone";
    serve([]);
    render(<Inbox />);
    expect(await screen.findByText(/Die verlinkte Karte wartet nicht mehr/)).toBeTruthy();
  });
});

describe("Handyansicht", () => {
  const css = readFileSync(path.join(__dirname, "styles.css"), "utf8");
  const rule = (selector: string, source = css) => {
    const match = source.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    return match ? match[2] : "";
  };
  const rem = (value: string) => Number(value.replace("rem", "")) * 16;

  it("stacks the buttons in one full-width column by default and splits only on wider screens", () => {
    expect(rule(".inbox-actions")).toMatch(/grid-template-columns:\s*1fr;/);
    const wide = css.match(/@media \(min-width: (\d+)rem\) \{\s*\.inbox-actions \{([^}]*)\}/);
    expect(wide).not.toBeNull();
    expect(rem(`${wide![1]}rem`)).toBeGreaterThanOrEqual(600);
    expect(wide![2]).toMatch(/grid-template-columns:\s*1fr 1fr;/);
    expect(rule(".inbox-button")).toMatch(/width:\s*100%;/);
  });

  it("makes the decision buttons and finding rows big enough for a thumb (≥ 44 px)", () => {
    expect(rem(rule(".inbox-button").match(/min-height:\s*([\d.]+rem)/)![1])).toBeGreaterThanOrEqual(44);
    expect(rem(rule(".more-toggle").match(/min-height:\s*([\d.]+rem)/)![1])).toBeGreaterThanOrEqual(44);
    expect(rem(rule(".inbox-finding summary").match(/min-height:\s*([\d.]+rem)/)![1])).toBeGreaterThanOrEqual(44);
  });

  it("never gets wider than the phone", () => {
    expect(rule(".inbox")).toMatch(/width:\s*min\(48rem, 100%\);/);
    // Die Raster hinter "Mehr" dürfen auf 360 px nicht seitlich überlaufen.
    expect(rule(".two-column")).toContain("minmax(min(22rem, 100%), 1fr)");
    expect(rule(".three-column")).toContain("minmax(min(18rem, 100%), 1fr)");
    expect(rule(".inbox-reason,\n.inbox-expired-note")).toContain("overflow-wrap: anywhere");
    const viewport = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    expect(viewport).toContain('name="viewport" content="width=device-width, initial-scale=1.0"');
  });

  it("renders every card control on a 360 px wide window", async () => {
    window.innerWidth = 360;
    window.dispatchEvent(new Event("resize"));
    serve([hermesCard()]);
    render(<Inbox />);
    const card = (await screen.findByText("Selbstupdate auf PR #25 einspielen.")).closest("article") as HTMLElement;
    const order = Array.from(card.querySelectorAll("h3, .inbox-reason, details, textarea, button")).map((element) => element.tagName + (element.className ? `.${element.className.split(" ")[0]}` : ""));
    // Absicht, Grund, Befunde, dann Grund-Feld und Knöpfe — in Lesereihenfolge.
    expect(order).toEqual(["H3.inbox-title", "P.inbox-reason", "DETAILS", "TEXTAREA", "BUTTON.inbox-button", "BUTTON.inbox-button"]);
  });
});
