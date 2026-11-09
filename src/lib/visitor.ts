import { AsyncLocalStorage } from "node:async_hooks";
import type { NextRequest } from "next/server";

// There's no sign-in, so each browser gets an anonymous visitor id: src/proxy.ts sets it in a
// cookie on the first page load, and the API routes read it back. Dashboards in OpenUI Cloud
// belong to it, so visitors list, open and edit only their own. It separates visitors; it doesn't
// prove who anyone is. Use the signed-in user's id instead when you add authentication.

export const VISITOR_COOKIE = "northstar-visitor";

const PATTERN = /^northstar_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const newVisitorId = () => `northstar_${crypto.randomUUID()}`;

export const isVisitorId = (value: string | undefined): value is string =>
  value !== undefined && PATTERN.test(value);

/** The visitor id in the request's cookie, or null when it's missing or malformed. */
export function readVisitorId(request: NextRequest): string | null {
  const id = request.cookies.get(VISITOR_COOKIE)?.value;
  return isVisitorId(id) ? id : null;
}

/** What an API route answers when the request has no visitor id. */
export const noVisitor = () =>
  Response.json({ error: "Missing visitor id. Reload the page." }, { status: 400 });

// The visitor some work runs for. The chat model, not a route, calls the dashboard tools, and the
// data layer records activity deep in the call stack, so both read the visitor from here.
const scope = new AsyncLocalStorage<string>();

/** Runs `work` for `visitorId`: currentVisitor() inside it returns that id. */
export const asVisitor = <T>(visitorId: string, work: () => T): T => scope.run(visitorId, work);

/** The visitor the current work runs for, or undefined outside asVisitor(). */
export const currentVisitor = () => scope.getStore();
