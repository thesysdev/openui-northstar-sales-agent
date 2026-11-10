import { OpenUIApiError, ToolExecutionError } from "@openuidev/server";
import type { NextRequest } from "next/server";
import { dashboards } from "../../../lib/openui";
import { asVisitor, noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

// A Query() call is a tool name and a few short arguments. Anyone can call this route without
// signing in, so a bigger body is refused before it reaches the tools, their cache, or the
// activity log.
const MAX_BODY = 8_000;

// Runs a dashboard's Query() calls for the browser: a data tool by name, or a script the
// dashboard was generated with, which OpenUI Cloud runs and which calls the same data tools.
// The data stays on this server; only the dashboard's results reach the browser.
export async function POST(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  const raw = await request.text();
  // The interpreter checks the request's shape itself.
  let body: Parameters<typeof dashboards.interpreter.execute>[0] | undefined;
  try {
    body = raw.length <= MAX_BODY ? JSON.parse(raw) : undefined;
  } catch {
    // Answered below, like a body that's too large.
  }
  if (!body || typeof body !== "object") {
    return Response.json(
      { error: { code: "invalid_input", message: `Send a query as JSON, up to ${MAX_BODY} bytes` } },
      { status: 400 },
    );
  }
  try {
    // Your tools get the visitor, and generated scripts run only for the dashboard's owner.
    const result = await asVisitor(visitor, () =>
      dashboards.interpreter.execute(body, { userId: visitor }, { signal: request.signal }),
    );
    return Response.json({ result });
  } catch (error) {
    const known = error instanceof ToolExecutionError || error instanceof OpenUIApiError;
    // Unexpected errors can carry internals, so the browser gets a generic message.
    if (!known) console.error("Interpreter failed", error);
    return Response.json(
      {
        error: {
          code: known ? error.code : "internal_error",
          message: known ? error.message : "Something went wrong running this query",
        },
      },
      { status: known ? (error.status ?? 500) : 500 },
    );
  }
}
