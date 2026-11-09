import { OpenUIApiError, ToolExecutionError } from "@openuidev/server";
import type { NextRequest } from "next/server";
import { dashboards } from "../../../lib/openui";
import { asVisitor, noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

// Runs a dashboard's Query() calls for the browser: a data tool by name, or a script the
// dashboard was generated with, which OpenUI Cloud runs and which calls the same data tools.
// The data stays on this server; only the dashboard's results reach the browser.
export async function POST(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  try {
    // Your tools get the visitor, and generated scripts run only for the dashboard's owner.
    const body = await request.json();
    const result = await asVisitor(visitor, () =>
      dashboards.interpreter.execute(body, { userId: visitor }, { signal: request.signal }),
    );
    return Response.json({ result });
  } catch (error) {
    const known = error instanceof ToolExecutionError || error instanceof OpenUIApiError;
    return Response.json(
      {
        error: {
          code: known ? error.code : "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: known ? (error.status ?? 500) : 500 },
    );
  }
}
