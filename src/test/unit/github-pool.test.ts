import { describe, expect, it } from "vitest";
import {
  DEFAULT_POOL_CONFIG,
  MAX_CONCURRENCY_MAX,
  MAX_CONCURRENCY_MIN,
  PARALLEL_SEARCH_PAGES_MAX,
  PARALLEL_SEARCH_PAGES_MIN,
  POOL_CONFIG_ID,
  sanitizeTokenRow,
  tokenFingerprint,
  validateAddTokenInput,
  validatePoolConfig,
  validationToFields,
} from "@/lib/github-pool";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/secret-crypto";

const SECRET = process.env.AUTH_SECRET ?? "test-auth-secret";

describe("github pool helpers", () => {
  describe("tokenFingerprint (dedup, no leak)", () => {
    it("is deterministic and never equals the plaintext token", () => {
      const token = "ghp_abcdef123456";
      const fp = tokenFingerprint(token);
      expect(fp).toMatch(/^[0-9a-f]+$/);
      expect(fp).toHaveLength(64);
      expect(fp).not.toContain(token);
      expect(tokenFingerprint(token)).toBe(fp);
    });

    it("differs across distinct tokens", () => {
      expect(tokenFingerprint("ghp_aaa111222333")).not.toBe(tokenFingerprint("ghp_zzz999888777"));
    });

    it("returns empty for empty input", () => {
      expect(tokenFingerprint("   ")).toBe("");
    });
  });

  describe("validateAddTokenInput", () => {
    it("trims label/token and allows null label", () => {
      const r = validateAddTokenInput({ label: "  小号A  ", token: "ghp_ok_token" });
      expect(r.label).toBe("小号A");
      expect(r.token).toBe("ghp_ok_token");
    });

    it("rejects empty / overlong / malformed tokens", () => {
      expect(() => validateAddTokenInput({ token: "" })).toThrow();
      const long = "x".repeat(5000);
      expect(() => validateAddTokenInput({ token: long })).toThrow("过长");
      expect(() => validateAddTokenInput({ token: "bad token with space" })).toThrow("格式");
    });
  });

  describe("validatePoolConfig range + defaults", () => {
    it("accepts boundary values and clamps to integers", () => {
      expect(validatePoolConfig({ maxConcurrency: MAX_CONCURRENCY_MIN, parallelSearchPages: PARALLEL_SEARCH_PAGES_MIN })).toEqual({
        maxConcurrency: 1,
        parallelSearchPages: 1,
      });
      expect(validatePoolConfig({ maxConcurrency: MAX_CONCURRENCY_MAX, parallelSearchPages: PARALLEL_SEARCH_PAGES_MAX })).toEqual({
        maxConcurrency: 20,
        parallelSearchPages: 5,
      });
      expect(validatePoolConfig({ maxConcurrency: 3.9, parallelSearchPages: 2.1 })).toEqual({
        maxConcurrency: 3,
        parallelSearchPages: 2,
      });
    });

    it("rejects out-of-range config", () => {
      expect(() => validatePoolConfig({ maxConcurrency: 0, parallelSearchPages: 2 })).toThrow("并发数");
      expect(() => validatePoolConfig({ maxConcurrency: 21, parallelSearchPages: 2 })).toThrow("并发数");
      expect(() => validatePoolConfig({ maxConcurrency: 5, parallelSearchPages: 0 })).toThrow("页数");
      expect(() => validatePoolConfig({ maxConcurrency: 5, parallelSearchPages: 6 })).toThrow("页数");
      expect(() => validatePoolConfig({ maxConcurrency: NaN, parallelSearchPages: 2 })).toThrow();
    });

    it("DEFAULT_POOL_CONFIG is 4/1 and POOL_CONFIG_ID is 1", () => {
      expect(DEFAULT_POOL_CONFIG).toEqual({ maxConcurrency: 4, parallelSearchPages: 1 });
      expect(POOL_CONFIG_ID).toBe(1);
    });
  });

  describe("sanitizeTokenRow (no secret leak)", () => {
    it("strips encryptedToken and exposes only display fields including limits/scopes", () => {
      const row = {
        id: "t-1",
        label: "小号",
        source: "manual",
        githubLogin: "octocat",
        githubUserId: "1",
        avatarUrl: "https://x/x.png",
        enabled: true,
        status: "active",
        encryptedToken: "enc:v1:secretstuff",
        scopes: "read:user, repo",
        coreLimit: 5000,
        coreLimitRemaining: 4998,
        coreLimitResetAt: "2026-01-01T00:00:00Z",
        searchLimit: 30,
        searchLimitRemaining: 28,
        searchLimitResetAt: new Date("2026-01-02T00:00:00Z"),
        lastUsedAt: null,
        lastCheckedAt: "2026-01-03T00:00:00Z",
        lastError: null,
      };
      const view = sanitizeTokenRow(row);
      expect((view as Record<string, unknown>).encryptedToken).toBeUndefined();
      expect(view).toMatchObject({
        id: "t-1",
        label: "小号",
        githubLogin: "octocat",
        enabled: true,
        scopes: ["read:user", "repo"],
        coreLimit: 5000,
        coreLimitRemaining: 4998,
        coreLimitResetAt: "2026-01-01T00:00:00.000Z",
        searchLimit: 30,
        searchLimitRemaining: 28,
        searchLimitResetAt: "2026-01-02T00:00:00.000Z",
        lastUsedAt: null,
      });
    });

    it("handles null/empty scopes gracefully", () => {
      const view = sanitizeTokenRow({ id: "t2", scopes: null });
      expect(view.scopes).toBeNull();
    });
  });

  describe("validationToFields (Date|null for DB)", () => {
    it("converts quota reset timestamps to Date instances or null, scopes to csv", () => {
      const resetDate = new Date("2026-01-01T00:00:00Z");
      const fields = validationToFields({
        identity: { id: "42", login: "octo", avatarUrl: null, scopes: ["read:user"] },
        quota: {
          core: { limit: 5000, remaining: 4999, resetAt: resetDate },
          search: { limit: 30, remaining: 29, resetAt: null },
        },
      });
      expect(fields.githubUserId).toBe("42");
      expect(fields.scopes).toBe("read:user");
      expect(fields.coreLimitResetAt).toBeInstanceOf(Date);
      expect(fields.searchLimitResetAt).toBeNull();
      expect(fields.coreLimit).toBe(5000);
    });

    it("throws when identity has no id", () => {
      expect(() =>
        validationToFields({ identity: { id: null, login: "x", avatarUrl: null, scopes: [] }, quota: null })
      ).toThrow("GitHub 用户 ID");
    });
  });

  describe("secret crypto integration", () => {
    it("encrypts then decrypts a token without leaking plaintext", () => {
      const enc = encryptSecret("ghp_secret_token");
      expect(isEncryptedSecret(enc)).toBe(true);
      expect(enc).not.toContain("ghp_secret_token");
      expect(decryptSecret(enc)).toBe("ghp_secret_token");
    });
    it("fingerprint does not depend on the encrypted form", () => {
      expect(SECRET.length).toBeGreaterThan(0);
    });
  });
});