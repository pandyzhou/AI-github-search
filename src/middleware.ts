import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PATHS = ["/login"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function isPublicApiRoute(pathname: string): boolean {
  if (pathname === "/api/health") return true;
  if (pathname.startsWith("/api/auth/")) return true;
  return false;
}

function isStaticAsset(pathname: string): boolean {
  const staticPrefixes = [
    "/_next/",
    "/favicon.ico",
    "/robots.txt",
    "/sitemap.xml",
    "/logo.png",
    "/context.png",
  ];
  return staticPrefixes.some((p) => pathname === p || pathname.startsWith(p));
}

function isHttpsRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
  }
  return request.nextUrl.protocol === "https:";
}

function buildAuthSecret(): string | undefined {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (isPublicApiRoute(pathname)) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secureCookie: isHttpsRequest(request),
    secret: buildAuthSecret(),
  });

  if (!token) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname + (search || ""));
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files and Next internals:
     * - _next/static, _next/image, favicon.ico
     */
    "/((?!_next/static|_next/image).*)",
  ],
};