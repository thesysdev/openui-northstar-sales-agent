import { OpenUIApiError } from "@openuidev/server";
import type { NextRequest } from "next/server";
import { openui } from "../../../lib/openui";
import { noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

// Mints the short-lived frontend token the browser sends to OpenUI Cloud, for the thread list and
// for streaming dashboards. It's scoped to the visitor, so the browser reaches only that visitor's
// dashboards and never sees THESYS_API_KEY.
export async function POST(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  try {
    const token = await openui.createFrontendToken({ userId: visitor }, { signal: request.signal });
    return Response.json(token, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof OpenUIApiError ? (error.status ?? 500) : 500;
    return Response.json({ error: "OpenUI Cloud could not create a frontend token." }, { status });
  }
}
