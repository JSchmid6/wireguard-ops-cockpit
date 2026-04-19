import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE,
  clearAuthCookie,
  createAuthToken,
  hashAuthToken,
  hashPassword,
  parseCookies,
  serializeAuthCookie,
  verifyPassword
} from "../src/auth.js";

describe("auth helpers", () => {
  it("hashes and verifies passwords safely", () => {
    const storedHash = hashPassword("super-secret");

    expect(storedHash).toContain(":");
    expect(verifyPassword("super-secret", storedHash)).toBe(true);
    expect(verifyPassword("incorrect", storedHash)).toBe(false);
    expect(verifyPassword("super-secret", "broken")).toBe(false);
  });

  it("creates token pairs whose hashes can be recomputed", () => {
    const token = createAuthToken();

    expect(token.raw).not.toBe(token.hash);
    expect(hashAuthToken(token.raw)).toBe(token.hash);
  });

  it("parses and serializes cookies", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("theme=dark; message=hello%20world; empty=")).toEqual({
      theme: "dark",
      message: "hello world",
      empty: ""
    });

    const cookie = serializeAuthCookie("opaque=token", 120, true);
    expect(cookie).toContain(`${AUTH_COOKIE}=opaque%3Dtoken`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=120");
    expect(cookie).toContain("Secure");

    const cleared = clearAuthCookie(false);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).not.toContain("Secure");
  });
});