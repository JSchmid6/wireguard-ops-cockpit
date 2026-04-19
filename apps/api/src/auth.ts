import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const AUTH_COOKIE = "cockpit_session";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, existingHash] = storedHash.split(":");
  if (!salt || !existingHash) {
    return false;
  }

  const candidate = scryptSync(password, salt, 64);
  const existing = Buffer.from(existingHash, "hex");
  return existing.length === candidate.length && timingSafeEqual(existing, candidate);
}

export function createAuthToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: sha256(raw) };
}

export function hashAuthToken(rawToken: string): string {
  return sha256(rawToken);
}

export function parseCookies(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) {
    return {};
  }

  return headerValue.split(";").reduce<Record<string, string>>((cookies, part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key || rest.length === 0) {
      return cookies;
    }

    cookies[key] = decodeURIComponent(rest.join("="));
    return cookies;
  }, {});
}

export function serializeAuthCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function clearAuthCookie(secure: boolean): string {
  return serializeAuthCookie("", 0, secure);
}

export { AUTH_COOKIE };

