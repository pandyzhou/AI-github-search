import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { addPoolTokenFromOAuthService, exchangeOAuthCode } from "@/server/github-pool.service";
import { OAUTH_STATE_COOKIE, verifyOAuthState } from "@/lib/oauth-state";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

const POOL_HOME_PATH = "/admin/github-pool";

function canonicalOrigin(): string {
  return (
    process.env.NEXTAUTH_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function redirectWithMessage(message: string, kind: "error" | "bind", clearState: boolean): NextResponse {
  const url = new URL(POOL_HOME_PATH, canonicalOrigin());
  url.searchParams.set(kind === "bind" ? "bind" : "error", message);
  const res = NextResponse.redirect(url.toString());
  if (clearState) res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}

async function isCurrentUserAdmin(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return false;
  try {
    const rows = (await db
      .select()
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)) as Array<Record<string, unknown>>;
    return rows[0]?.role === "ADMIN";
  } catch {
    return false;
  }
}

// OAuth 回调：仅管理员；严格校验一次性 state；交换后验证身份+额度并入池，不覆盖个人 token。
export async function GET(request: NextRequest) {
  const reqUrl = new URL(request.url);
  const code = reqUrl.searchParams.get("code");
  const state = reqUrl.searchParams.get("state");
  const errorParam = reqUrl.searchParams.get("error");

  // 无 code/error 时不清除当前 state，避免无关请求破坏正在进行的授权事务。
  if (errorParam) {
    return redirectWithMessage("GitHubAuthCancelled", "error", true);
  }
  if (!code) {
    return redirectWithMessage("MissingCode", "error", false);
  }

  // 正式回调：校验一次性 state，校验后立即清除
  const cookieState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const stateError = verifyOAuthState(cookieState, state);
  if (stateError) {
    return redirectWithMessage("StateInvalid", "error", true);
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login", canonicalOrigin()));
  }
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.redirect(new URL("/dashboard", canonicalOrigin()));
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return redirectWithMessage("OAuthNotConfigured", "error", true);
  }

  const redirectUri = `${canonicalOrigin()}/api/auth/github-bind/callback`;
  const exchange = await exchangeOAuthCode(code, clientId, clientSecret, redirectUri);
  if (!exchange.accessToken) {
    return redirectWithMessage(exchange.error ?? "TokenExchangeFailed", "error", true);
  }

  try {
    await addPoolTokenFromOAuthService(exchange.accessToken);
    return redirectWithMessage("success", "bind", true);
  } catch (err) {
    console.error("GitHub OAuth bind error:", err instanceof Error ? err.message : "unknown");
    return redirectWithMessage(
      err instanceof Error ? err.message : "UnknownError",
      "error",
      true
    );
  }
}