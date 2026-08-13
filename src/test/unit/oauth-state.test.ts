import { describe, expect, it } from "vitest";
import {
  buildStateCookieOptions,
  constantTimeEqual,
  generateOAuthState,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_SECONDS,
  verifyOAuthState,
} from "@/lib/oauth-state";

describe("oauth state", () => {
  it("generates high-entropy, unique state values", () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a.length).toBeGreaterThanOrEqual(48);
    expect(a).not.toBe(b);
  });

  it("builds strict cookie options, secure only in production", () => {
    const dev = buildStateCookieOptions(false);
    expect(dev).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    });
    const prod = buildStateCookieOptions(true);
    expect(prod.secure).toBe(true);
  });

  it("constant-time compares equal strings and rejects mismatches", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", null)).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("verifies callback state against cookie strictly", () => {
    const cookie = generateOAuthState();
    expect(verifyOAuthState(cookie, cookie)).toBeNull();
    expect(verifyOAuthState(cookie, "other")).toContain("失败");
    expect(verifyOAuthState(null, cookie)).toContain("过期");
    expect(verifyOAuthState(cookie, null)).toContain("缺少");
  });

  it("uses a stable, descriptive cookie name", () => {
    expect(OAUTH_STATE_COOKIE).toBe("github_oauth_state");
  });
});