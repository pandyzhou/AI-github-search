import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { encryptSecret } from "@/lib/secret-crypto";

export async function GET(request: Request) {
  const reqUrl = new URL(request.url);
  const code = reqUrl.searchParams.get("code");
  const errorParam = reqUrl.searchParams.get("error");

  if (errorParam || !code) {
    return NextResponse.redirect(
      new URL("/dashboard/settings?error=GitHubAuthCancelled", request.url)
    );
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      new URL("/dashboard/settings?error=OAuthNotConfigured", request.url)
    );
  }

  try {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return NextResponse.redirect(
        new URL("/dashboard/settings?error=TokenExchangeFailed", request.url)
      );
    }

    const accessToken: string = tokenData.access_token;
    const encryptedToken = encryptSecret(accessToken);

    await db
      .update(users)
      .set({
        githubToken: encryptedToken,
      })
      .where(eq(users.id, session.user.id));

    return NextResponse.redirect(
      new URL("/dashboard/settings?bind=success", request.url)
    );
  } catch (err) {
    console.error("GitHub token exchange error:", err);
    return NextResponse.redirect(
      new URL("/dashboard/settings?error=UnknownError", request.url)
    );
  }
}
