import { afterEach, describe, expect, it, vi } from "vitest";
import { formatOutput, request } from "./lib";

describe("web request helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("formats structured output for the job timeline", () => {
    expect(formatOutput(null)).toBe("No structured output recorded yet.");
    expect(formatOutput({ summary: "completed", details: { safe: true } })).toBe(
      'summary: completed\ndetails: {"safe":true}'
    );
  });

  it("sends requests to the API base path with credentials included", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true })
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(request<{ ok: boolean }>("/health", { method: "POST" })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      })
    );
  });

  it("surfaces API error messages and falls back to status codes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: vi.fn().mockResolvedValue({ message: "forbidden" })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: vi.fn().mockRejectedValue(new Error("bad response"))
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(request("/forbidden")).rejects.toThrow("forbidden");
    await expect(request("/unavailable")).rejects.toThrow("Request failed with status 503");
  });
});