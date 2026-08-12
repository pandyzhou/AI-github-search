import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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

function hasSessionToken(request: NextRequest): boolean {
  const httpToken = request.cookies.get("next-auth.session-token")?.value;
  const httpsToken = request.cookies.get("__Secure-next-auth.session-token")?.value;
  return Boolean(httpToken || httpsToken);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (isPublicApiRoute(pathname)) {
    return NextResponse.next();
  }

  if (!hasSessionToken(request)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
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