import { NextResponse, type NextRequest } from "next/server";
import { BASE_PATH } from "./lib/base-path";
import { VISITOR_COOKIE, isVisitorId, newVisitorId } from "./lib/visitor";

// Gives each browser its anonymous visitor id (src/lib/visitor.ts) on its first page load, before
// the page calls any API route.
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (!isVisitorId(request.cookies.get(VISITOR_COOKIE)?.value)) {
    response.cookies.set(VISITOR_COOKIE, newVisitorId(), {
      path: BASE_PATH || "/",
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}

// Pages only: not API routes, Next's own files, or files in public/. "/" is listed on its own:
// under a base path the pattern doesn't match the bare root.
export const config = { matcher: ["/", "/((?!api/|_next/|.*\\.).*)"] };
