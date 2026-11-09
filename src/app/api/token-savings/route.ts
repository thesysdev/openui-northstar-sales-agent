import { encode } from "gpt-tokenizer";
import type { NextRequest } from "next/server";
import { baseUrl, openui } from "../../../lib/openui";
import { noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

// How many fewer tokens the model spent writing a dashboard in OpenUI Lang than the HTML it
// renders to. Same method as OpenUI's GitHub dashboard demo (gpt-tokenizer, percent saved vs
// the bulkier format), with rendered HTML as the baseline instead of JSON. The browser sends
// the dashboard's HTML; the program comes from OpenUI Cloud.

const MAX_HTML = 2_000_000;

export async function POST(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  const { id, html } = (await request.json().catch(() => ({}))) as { id?: unknown; html?: unknown };
  if (typeof id !== "string" || !/^art_[A-Za-z0-9_-]+$/.test(id)) {
    return Response.json({ error: "Bad dashboard id" }, { status: 400 });
  }
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_HTML) {
    return Response.json({ error: "Bad html" }, { status: 400 });
  }

  // The frontend token reads only this visitor's dashboards.
  const { token } = await openui.createFrontendToken({ userId: visitor });
  const response = await fetch(`${baseUrl}/v1/artifacts/${encodeURIComponent(id)}`, {
    headers: { "x-thesys-frontend-token": token },
    signal: request.signal,
  });
  if (!response.ok) {
    return Response.json({ error: `Dashboard not found (${response.status})` }, { status: 404 });
  }
  const artifact = (await response.json()) as { content?: unknown };
  if (typeof artifact.content !== "string" || !artifact.content) {
    return Response.json({ error: "Dashboard has no program yet" }, { status: 409 });
  }

  const langTokens = encode(artifact.content).length;
  const htmlTokens = encode(html).length;
  const pct =
    htmlTokens > langTokens ? Math.round(((htmlTokens - langTokens) / htmlTokens) * 100) : 0;
  return Response.json({ langTokens, htmlTokens, pct });
}
