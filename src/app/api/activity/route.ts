import { since } from "../../../lib/data/activity";

export const runtime = "nodejs";

/** Data-layer activity after `since` (an event id), for the dashboard panel's live strip. */
export async function GET(request: Request) {
  const sinceId = Number(new URL(request.url).searchParams.get("since")) || 0;
  return Response.json({ events: since(sinceId) });
}
