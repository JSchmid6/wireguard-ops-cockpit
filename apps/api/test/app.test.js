import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
async function login(app) {
    const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
            username: "admin",
            password: "test-password"
        }
    });
    const cookie = response.headers["set-cookie"];
    expect(cookie).toContain("cockpit_session=");
    return cookie;
}
describe("control API", () => {
    const openApps = [];
    afterEach(async () => {
        await Promise.all(openApps.splice(0).map((app) => app.close()));
    });
    it("creates sessions and records audit output", async () => {
        const app = await createApp({
            config: {
                apiHost: "127.0.0.1",
                apiPort: 3001,
                dbPath: ":memory:",
                adminUsername: "admin",
                adminPassword: "test-password",
                sessionTtlHours: 12,
                cookieSecure: false,
                tmuxMode: "disabled",
                ttydBaseUrl: null,
                repoRoot: process.cwd()
            }
        });
        openApps.push(app);
        const cookie = await login(app);
        const createSession = await app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: { cookie },
            payload: { name: "Incident Debug" }
        });
        expect(createSession.statusCode).toBe(201);
        const created = createSession.json();
        expect(created.session.name).toBe("incident-debug");
        expect(created.session.tmuxBackend).toBe("disabled");
        const audits = await app.inject({
            method: "GET",
            url: "/api/audits",
            headers: { cookie }
        });
        expect(audits.statusCode).toBe(200);
        expect(audits.json().audits.some((entry) => entry.action === "session.ensure")).toBe(true);
    });
    it("gates privileged-marked runbooks behind approvals", async () => {
        const app = await createApp({
            config: {
                apiHost: "127.0.0.1",
                apiPort: 3001,
                dbPath: ":memory:",
                adminUsername: "admin",
                adminPassword: "test-password",
                sessionTtlHours: 12,
                cookieSecure: false,
                tmuxMode: "disabled",
                ttydBaseUrl: null,
                repoRoot: process.cwd()
            }
        });
        openApps.push(app);
        const cookie = await login(app);
        const session = (await app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: { cookie },
            payload: { name: "Nextcloud Upgrade" }
        })).json().session;
        const runbook = await app.inject({
            method: "POST",
            url: "/api/runbooks/nextcloud-update-plan/execute",
            headers: { cookie },
            payload: { sessionId: session.id }
        });
        expect(runbook.statusCode).toBe(202);
        expect(runbook.json().job.status).toBe("pending_approval");
        const approval = runbook.json().approval;
        const decision = await app.inject({
            method: "POST",
            url: `/api/approvals/${approval.id}/decision`,
            headers: { cookie },
            payload: { decision: "approved", reason: "reviewed" }
        });
        expect(decision.statusCode).toBe(200);
        expect(decision.json().job.status).toBe("completed");
        expect(decision.json().approval.status).toBe("approved");
    });
});
//# sourceMappingURL=app.test.js.map