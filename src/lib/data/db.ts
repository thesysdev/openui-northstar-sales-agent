import { neon } from "@neondatabase/serverless";
import { ToolExecutionError } from "@openuidev/server";
import { record, toolContext } from "./activity";
import { cached, int, text } from "./fetch";

// Querying the Neon sales database (schema `retail`). Every data tool goes through `query`,
// which parameterizes, times out after 10 seconds, and stops when the dashboard's request ends.

const TIMEOUT_MS = 10_000;

export async function query<T = Record<string, unknown>>(
  sqlText: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<T[]> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new ToolExecutionError("DATABASE_URL is not set", "misconfigured", 500);
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const sql = neon(url, { fetchOptions: { signal: AbortSignal.any([signal, timeout]) } });
  const started = Date.now();
  const event = {
    kind: "sql" as const,
    tool: toolContext.getStore(),
    sql: sqlText.replace(/\s+/g, " ").trim(),
    params,
  };
  try {
    const rows = (await sql.query(sqlText, params)) as T[];
    record({ ...event, rows: rows.length, ms: Date.now() - started });
    return rows;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record({ ...event, ms: Date.now() - started, error: message });
    if (timeout.aborted) {
      throw new ToolExecutionError("The sales database didn't answer in time", "upstream_unavailable", 504);
    }
    if (signal.aborted) throw error;
    throw new ToolExecutionError(`Sales database error: ${message}`, "upstream_error", 502);
  }
}

// Orders that count as sales: completed, payment captured, not test orders, not internal
// customers. Cancelled and voided orders are excluded everywhere.
export const SALES_WHERE = `o.order_status = 'completed' AND o.payment_status = 'captured'
  AND NOT o.excluded_test_flag AND NOT c.is_internal`;

export const ORDERS_JOIN = `retail.orders o
  JOIN retail.customers c ON c.customer_id = o.customer_id
  JOIN retail.order_items oi ON oi.order_id = o.order_id`;

export const PRODUCTS_JOIN = `
  JOIN retail.product_variants v ON v.variant_id = oi.variant_id
  JOIN retail.products p ON p.style_id = v.style_id`;

export const RETURNS_JOIN = `retail.returns r
  JOIN retail.order_items oi ON oi.order_item_id = r.order_item_id
  JOIN retail.orders o ON o.order_id = oi.order_id
  JOIN retail.customers c ON c.customer_id = o.customer_id`;

/** Dollar aggregate as a JS number, rounded to cents. */
export const money = (expr: string) => `coalesce(round(sum(${expr})::numeric, 2), 0)::float8`;

/** The dimensions breakdowns and series can group by. */
export const DIMENSIONS = {
  region: { sql: "o.shipping_region", products: false },
  state: { sql: "coalesce(o.shipping_state, 'Unknown')", products: false },
  category: { sql: "p.category", products: true },
  subcategory: { sql: "p.subcategory", products: true },
  brand: { sql: "p.brand", products: true },
  channel: { sql: "coalesce(o.traffic_source, 'unknown')", products: false },
  device: { sql: "coalesce(o.device_type, 'unknown')", products: false },
} as const;

export type Dimension = keyof typeof DIMENSIONS;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The first and last day with orders (YYYY-MM-DD), checked once an hour. Date ranges count
 * back from the last day, not from today: if the data stops growing, dashboards keep showing
 * its latest months instead of running out of data.
 */
export const dataDays = () =>
  cached("db:days", 60 * 60_000, async () => {
    // Shared by every request in the hour, so it isn't tied to the one that loads it.
    const [row] = await query<{ first: string | null; last: string | null }>(
      "SELECT min(placed_at)::date::text AS first, max(placed_at)::date::text AS last FROM retail.orders",
      [],
      new AbortController().signal,
    );
    const today = day(new Date());
    return { first: row?.first ?? today, last: row?.last ?? today };
  });

/**
 * A lenient date range within the data: explicit `from`/`to` (YYYY-MM-DD) when given,
 * otherwise `months` back (default `defaultMonths`, clamped to 1–24) from its last day.
 */
export async function dateRange(
  args: Record<string, unknown>,
  defaultMonths = 6,
): Promise<{ from: string; to: string }> {
  const { first, last } = await dataDays();
  let to = ISO_DAY.test(text(args.to)) ? text(args.to) : last;
  if (to > last) to = last;
  let from: string;
  if (ISO_DAY.test(text(args.from))) {
    from = text(args.from);
  } else {
    const months = int(args.months, defaultMonths, 1, 24);
    const start = new Date(`${to}T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() - months);
    start.setUTCDate(start.getUTCDate() + 1);
    from = day(start);
  }
  if (from > to) [from, to] = [to, from];
  // A range that reaches past the data is cut to it.
  if (to > last) to = last;
  if (from < first) from = first;
  if (from > to) from = to;
  return { from, to };
}

/** The range of the same length immediately before `from`. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevEnd = new Date(start.getTime() - 86_400_000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000);
  return { from: day(prevStart), to: day(prevEnd) };
}

export function changePct(current: number, previous: number): number {
  if (!previous) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export const round2 = (value: number) => Math.round(value * 100) / 100;
export const pct = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) / 10 : 0;
