import type { NextRequest } from "next/server";
import { since } from "../../../lib/data/activity";
import { noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

/** The visitor's data-layer activity after `since` (an event id), for the dashboard panel's live strip. */
export async function GET(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  const sinceId = Number(request.nextUrl.searchParams.get("since")) || 0;
  return Response.json({ events: since(sinceId, visitor) });
}
