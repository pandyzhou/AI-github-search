import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  OAUTH_STATE_COOKIE,
  buildStateCookieOptions,
  generateOAuthState,
} from "@/lib/oauth-state";
import { assertAdmin } from "@/server/github-pool.actions";

function canonicalOrigin() {
  return (
    process.env.NEXTAUTH_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

// OAuth 一键授权入口：仅管理员可用，将 token 纳入共享账号池。
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  try {
    await assertAdmin();
  } catch {
    return NextResponse.redirect(new URL("/dashboard", canonicalOrigin()));
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(
      new URL("/admin/github-pool?error=OAuthNotConfigured", request.url)
    );
  }

  const redirectUri = `${canonicalOrigin()}/api/auth/github-bind/callback`;
  const state = generateOAuthState();

  const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubAuthUrl.searchParams.set("client_id", clientId);
  githubAuthUrl.searchParams.set("redirect_uri", redirectUri);
  githubAuthUrl.searchParams.set("scope", "read:user");
  githubAuthUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(githubAuthUrl.toString());
  res.cookies.set(
    OAUTH_STATE_COOKIE,
    state,
    buildStateCookieOptions(process.env.NODE_ENV === "production")
  );
  return res;
}