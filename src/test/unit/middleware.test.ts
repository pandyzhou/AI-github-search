import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { middleware } from "@/middleware";

const getTokenMock = vi.fn();

vi.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
}));

function buildRequest(
  pathname: string,
  options: {
    cookies?: Record<string, string>;
    proto?: "http" | "https";
    forwardedProto?: string;
  } = {}
): NextRequest {
  const { cookies = {}, proto = "http", forwardedProto } = options;
  const headers: Record<string, string> = {};
  if (Object.keys(cookies).length > 0) {
    headers["cookie"] = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  if (forwardedProto !== undefined) {
    headers["x-forwarded-proto"] = forwardedProto;
  }
  const url =
    proto === "https" ? `https://localhost${pathname}` : `http://localhost${pathname}`;
  return new NextRequest(url, { headers });
}

describe("middleware auth", () => {
  beforeEach(() => {
    getTokenMock.mockReset();
  });

  it("lets /login pass without verifying token", async () => {
    const res = await middleware(buildRequest("/login"));
    expect(res instanceof NextResponse).toBe(true);
    expect(res.status).toBe(200);
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("lets /api/health pass without verifying token", async () => {
    const res = await middleware(buildRequest("/api/health"));
    expect(res.status).toBe(200);
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("lets /api/auth/* (OAuth callback) pass without verifying token", async () => {
    const res = await middleware(
      buildRequest("/api/auth/callback/github?code=abc&state=xyz")
    );
    expect(res.status).toBe(200);
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("lets static assets pass without verifying token", async () => {
    const res = await middleware(buildRequest("/_next/static/chunk.js"));
    expect(res.status).toBe(200);
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("redirects to /login when getToken returns null (no token)", async () => {
    getTokenMock.mockResolvedValue(null);
    const res = await middleware(buildRequest("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).toContain(
      "callbackUrl=%2Fdashboard"
    );
    expect(getTokenMock).toHaveBeenCalledTimes(1);
    // secureCookie reflects http request
    expect(getTokenMock.mock.calls[0][0]).toMatchObject({ secureCookie: false });
  });

  it("redirects to /login when token is forged / decode fails", async () => {
    getTokenMock.mockResolvedValue(null);
    const res = await middleware(
      buildRequest("/dashboard/reports?tab=overview", {
        cookies: { "next-auth.session-token": "forged.value" },
      })
    );
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).toContain(
      "callbackUrl=%2Fdashboard%2Freports%3Ftab%3Doverview"
    );
  });

  it("passes through when getToken returns a valid JWT", async () => {
    getTokenMock.mockResolvedValue({ sub: "user-1", role: "USER" });
    const res = await middleware(
      buildRequest("/dashboard", {
        cookies: { "next-auth.session-token": "valid-token" },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(getTokenMock).toHaveBeenCalledTimes(1);
  });

  it("uses secureCookie=true and __Secure cookie path for HTTPS requests", async () => {
    getTokenMock.mockResolvedValue({ sub: "user-1" });
    await middleware(
      buildRequest("/dashboard", {
        proto: "https",
        cookies: { "__Secure-next-auth.session-token": "valid-token" },
      })
    );
    expect(getTokenMock.mock.calls[0][0]).toMatchObject({ secureCookie: true });
  });

  it("respects x-forwarded-proto for secureCookie detection", async () => {
    getTokenMock.mockResolvedValue(null);
    await middleware(
      buildRequest("/dashboard", {
        proto: "http",
        forwardedProto: "https",
      })
    );
    expect(getTokenMock.mock.calls[0][0]).toMatchObject({ secureCookie: true });
  });

  it("forwards AUTH_SECRET to getToken", async () => {
    const previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "test-secret-value";
    getTokenMock.mockResolvedValue({ sub: "user-1" });
    try {
      await middleware(buildRequest("/dashboard"));
      expect(getTokenMock.mock.calls[0][0]).toMatchObject({
        secret: "test-secret-value",
      });
    } finally {
      if (previous === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previous;
    }
  });
});