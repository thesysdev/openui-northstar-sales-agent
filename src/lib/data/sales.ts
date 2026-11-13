import { z } from "zod";
import {
  DIMENSIONS,
  type Dimension,
  ORDERS_JOIN,
  PRODUCTS_JOIN,
  RETURNS_JOIN,
  SALES_WHERE,
  changePct,
  dataDays,
  dateRange,
  money,
  pct,
  previousRange,
  query,
  round2,
} from "./db";
import { record, toolContext } from "./activity";
import { cacheHas, cached, int, oneOf, text } from "./fetch";
import { dataTool } from "./tool";

// Data tools over the Neon sales database (schema `retail`): 100k orders from Nov 2024 to
// its latest order, in USD. "Net sales" is revenue after discounts (before refunds): completed, captured
// orders only, with test orders and internal customers excluded. Refunds come from returns,
// by the date they were processed. Results are cached for 3 minutes.

const TTL = 3 * 60_000;
const run = <T>(name: string, args: Record<string, unknown>, load: () => Promise<T>) => {
  const key = `sales:${name}:${JSON.stringify(args)}`;
  // One activity event per tool call; a cache hit runs no SQL, and the panel says so.
  record({ kind: "tool", tool: name, args, cache: cacheHas(key) ? "hit" : "miss" });
  return toolContext.run(name, () => cached(key, TTL, load));
};

const INTERVALS = ["day", "week", "month"] as const;
const TREND_DIMS = ["none", "region", "category", "brand", "channel", "device"] as const;
const BREAKDOWN_DIMS = Object.keys(DIMENSIONS) as Dimension[];

const rangeParams = {
  months: z
    .number()
    .int()
    .min(1)
    .max(24)
    .default(6)
    .describe(
      "How many months back from the last day of data, 1 to 24; monthly series count whole months up to the last whole month. Ignored when from/to are set.",
    ),
  from: z.string().optional().describe("Start date YYYY-MM-DD (data starts 2024-11-01)"),
  to: z
    .string()
    .optional()
    .describe("End date YYYY-MM-DD, default the last day of data (the last whole month's end for monthly series)"),
};

// The slice a dashboard's filters narrow every number to. Each is optional; empty means all.
const SLICE_KEYS = ["region", "category", "brand", "channel"] as const;
type Slice = Record<(typeof SLICE_KEYS)[number], string>;

const sliceParams = {
  region: z.string().optional().describe("Filter: West, South, Midwest, or Northeast. Empty for all."),
  category: z.string().optional().describe("Filter: accessories, apparel, or footwear. Empty for all."),
  brand: z.string().optional().describe("Filter by brand name. Empty for all."),
  channel: z
    .string()
    .optional()
    .describe("Filter by channel (traffic source), such as paid_search or email. Empty for all."),
};

/** One filter value, lower-cased; "", "all", "All regions" and the like mean no filter. */
function sliceValue(value: unknown): string {
  const picked = text(value).toLowerCase().slice(0, 60);
  return /^(all|any)\b/.test(picked) ? "" : picked;
}

function readSlice(args: Record<string, unknown>): Slice {
  return Object.fromEntries(SLICE_KEYS.map((key) => [key, sliceValue(args[key])])) as Slice;
}

/**
 * SQL for a slice, numbering its parameters from `first`: ` AND lower(o.shipping_region) = $3…`,
 * and whether it needs the products join (category and brand live on products).
 */
function sliceWhere(slice: Slice, first: number): { sql: string; params: string[]; products: boolean } {
  const params: string[] = [];
  let sql = "";
  for (const key of SLICE_KEYS) {
    if (!slice[key]) continue;
    params.push(slice[key]);
    sql += ` AND lower(${DIMENSIONS[key].sql}) = $${first + params.length - 1}`;
  }
  return { sql, params, products: Boolean(slice.category || slice.brand) };
}

/** Period expression and label format for a trend interval. */
const periodExpr = (interval: (typeof INTERVALS)[number], column: string) =>
  interval === "month"
    ? `to_char(date_trunc('month', ${column}), 'YYYY-MM')`
    : `to_char(date_trunc('${interval}', ${column}), 'YYYY-MM-DD')`;

export const salesTools = {
  get_sales_overview: dataTool(
    "Headline KPIs for a date range, with the previous range of the same length for comparison: net_sales (USD, after discounts, before refunds), orders, units, aov (average order value), discount_amount and discount_rate_pct, gross_margin_pct, refund_amount, returned_units and refund_rate_pct (refunds processed in the range as a share of net sales), plus previous {net_sales, orders, aov} and change {net_sales_pct, orders_pct, aov_pct}. Optional region, category, brand and channel filters narrow every number to that slice.",
    z.object({ ...rangeParams, ...sliceParams }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      net_sales: 5_204_310.5,
      orders: 26_410,
      units: 54_020,
      aov: 197.06,
      discount_amount: 612_480.25,
      discount_rate_pct: 10.5,
      gross_margin_pct: 58.2,
      refund_amount: 948_112.4,
      returned_units: 10_980,
      refund_rate_pct: 18.2,
      previous: { net_sales: 4_890_200.1, orders: 25_100, aov: 194.83 },
      change: { net_sales_pct: 6.4, orders_pct: 5.2, aov_pct: 1.1 },
    },
    async (args, signal) => {
      const { from, to } = await dateRange(args);
      const prev = previousRange(from, to);
      const slice = readSlice(args);
      return run("overview", { from, to, ...slice }, async () => {
        const filter = sliceWhere(slice, 4);
        const joins = filter.products ? PRODUCTS_JOIN : "";
        const params = [prev.from, from, to, ...filter.params];
        const [sales, refunds] = await Promise.all([
          query(
            `SELECT (o.placed_at >= $2::date) AS current,
                    ${money("oi.line_booked_amount")} AS net_sales,
                    count(DISTINCT o.order_id)::int AS orders,
                    coalesce(sum(oi.ordered_qty), 0)::int AS units,
                    ${money("oi.line_discount_amount")} AS discount_amount,
                    ${money("oi.line_list_amount")} AS list_amount,
                    ${money("oi.unit_cogs_at_sale * oi.ordered_qty")} AS cogs
             FROM ${ORDERS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $3::date + 1${filter.sql}
             GROUP BY 1`,
            params,
            signal,
          ),
          query(
            `SELECT (r.processed_at >= $2::date) AS current,
                    ${money("r.product_refund_amount")} AS refund_amount,
                    coalesce(sum(r.returned_qty), 0)::int AS returned_units
             FROM ${RETURNS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND r.processed_at >= $1::date AND r.processed_at < $3::date + 1${filter.sql}
             GROUP BY 1`,
            params,
            signal,
          ),
        ]);
        const bucket = (current: boolean) =>
          (sales.find((row) => row.current === current) ?? {
            net_sales: 0,
            orders: 0,
            units: 0,
            discount_amount: 0,
            list_amount: 0,
            cogs: 0,
          }) as Record<string, number>;
        const cur = bucket(true);
        const was = bucket(false);
        const ref = (refunds.find((row) => row.current === true) ?? {
          refund_amount: 0,
          returned_units: 0,
        }) as Record<string, number>;
        const aov = cur.orders ? round2(cur.net_sales / cur.orders) : 0;
        const prevAov = was.orders ? round2(was.net_sales / was.orders) : 0;
        return {
          from,
          to,
          net_sales: cur.net_sales,
          orders: cur.orders,
          units: cur.units,
          aov,
          discount_amount: cur.discount_amount,
          discount_rate_pct: pct(cur.discount_amount, cur.list_amount),
          gross_margin_pct: pct(cur.net_sales - cur.cogs, cur.net_sales),
          refund_amount: ref.refund_amount,
          returned_units: ref.returned_units,
          refund_rate_pct: pct(ref.refund_amount, cur.net_sales),
          previous: { net_sales: was.net_sales, orders: was.orders, aov: prevAov },
          change: {
            net_sales_pct: changePct(cur.net_sales, was.net_sales),
            orders_pct: changePct(cur.orders, was.orders),
            aov_pct: changePct(aov, prevAov),
          },
        };
      });
    },
  ),

  get_sales_trend: dataTool(
    "Net sales (USD) and orders over time, per day, week, or month, as aligned series: the period labels (weeks are labelled by their Monday), and one series per group with net_sales and orders per period, total, and change_pct (last period vs the one before). group_by none gives a single 'All' series; region, category, brand, channel, or device gives one series each. Monthly series end at the last whole month; day and week series run to the last day of data, so their first and last periods can be partial. Optional region, category, brand and channel filters narrow every series to that slice.",
    z.object({
      interval: z.enum(INTERVALS).default("month").describe("day, week, or month"),
      group_by: z.enum(TREND_DIMS).default("none"),
      ...rangeParams,
      ...sliceParams,
    }),
    {
      from: "2026-08-01",
      to: "2026-10-31",
      interval: "month",
      group_by: "category",
      periods: ["2026-08", "2026-09", "2026-10"],
      series: [
        {
          name: "apparel",
          net_sales: [402_110.4, 438_900.2, 451_220.8],
          orders: [2_210, 2_390, 2_460],
          total: 1_292_231.4,
          change_pct: 2.8,
        },
        {
          name: "footwear",
          net_sales: [281_400.1, 305_220.6, 298_100.3],
          orders: [1_480, 1_610, 1_570],
          total: 884_721.0,
          change_pct: -2.3,
        },
      ],
    },
    async (args, signal) => {
      const interval = oneOf(args.interval, INTERVALS, "month");
      const groupBy = oneOf(args.group_by, TREND_DIMS, "none");
      const { from, to } = await dateRange(args, 6, { wholeMonths: interval === "month" });
      const slice = readSlice(args);
      return run("trend", { from, to, interval, groupBy, ...slice }, async () => {
        const dim = groupBy === "none" ? "'All'" : DIMENSIONS[groupBy as Dimension].sql;
        const filter = sliceWhere(slice, 3);
        const joins =
          filter.products || (groupBy !== "none" && DIMENSIONS[groupBy as Dimension].products)
            ? PRODUCTS_JOIN
            : "";
        const rows = await query(
          `SELECT ${periodExpr(interval, "o.placed_at")} AS period, ${dim} AS name,
                  ${money("oi.line_booked_amount")} AS net_sales,
                  count(DISTINCT o.order_id)::int AS orders
           FROM ${ORDERS_JOIN}${joins}
           WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}
           GROUP BY 1, 2 ORDER BY 1, 2`,
          [from, to, ...filter.params],
          signal,
        );
        const periods = [...new Set(rows.map((row) => row.period as string))].sort();
        const names = [...new Set(rows.map((row) => row.name as string))].sort();
        const index = new Map(rows.map((row) => [`${row.period}|${row.name}`, row]));
        return {
          from,
          to,
          interval,
          group_by: groupBy,
          periods,
          series: names.map((name) => {
            const net_sales = periods.map(
              (period) => (index.get(`${period}|${name}`)?.net_sales as number) ?? 0,
            );
            const orders = periods.map(
              (period) => (index.get(`${period}|${name}`)?.orders as number) ?? 0,
            );
            const [previous, last] = net_sales.slice(-2);
            return {
              name,
              net_sales,
              orders,
              total: round2(net_sales.reduce((sum, value) => sum + value, 0)),
              change_pct:
                previous !== undefined && last !== undefined ? changePct(last, previous) : 0,
            };
          }),
        };
      });
    },
  ),

  get_sales_breakdown: dataTool(
    "Net sales (USD) broken down by one dimension — region, state, category, subcategory, brand, channel (traffic source), or device — for a date range, sorted by net sales: each row's net_sales, share_pct, orders, units, gross_margin_pct, refund_amount and returned_units (returns processed in the range), and return_rate_pct (returned units as a share of units sold). Optional region, category, brand and channel filters narrow the rows to that slice.",
    z.object({
      dimension: z.enum(BREAKDOWN_DIMS as [Dimension, ...Dimension[]]).default("category"),
      limit: z.number().int().min(3).max(25).default(10).describe("How many rows, 3 to 25"),
      ...rangeParams,
      ...sliceParams,
    }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      dimension: "region",
      total_net_sales: 5_204_310.5,
      rows: [
        {
          name: "West",
          net_sales: 1_720_410.2,
          share_pct: 33.1,
          orders: 8_610,
          units: 17_820,
          gross_margin_pct: 58.4,
          refund_amount: 310_200.7,
          returned_units: 3_580,
          return_rate_pct: 20.1,
        },
      ],
    },
    async (args, signal) => {
      const { from, to } = await dateRange(args);
      const dimension = oneOf(args.dimension, BREAKDOWN_DIMS, "category");
      const limit = int(args.limit, 10, 3, 25);
      const slice = readSlice(args);
      return run("breakdown", { from, to, dimension, limit, ...slice }, async () => {
        const { sql: dim, products } = DIMENSIONS[dimension];
        const filter = sliceWhere(slice, 3);
        const joins = products || filter.products ? PRODUCTS_JOIN : "";
        const params = [from, to, ...filter.params];
        const [sales, refunds] = await Promise.all([
          query(
            `SELECT ${dim} AS name, ${money("oi.line_booked_amount")} AS net_sales,
                    count(DISTINCT o.order_id)::int AS orders,
                    coalesce(sum(oi.ordered_qty), 0)::int AS units,
                    ${money("oi.unit_cogs_at_sale * oi.ordered_qty")} AS cogs
             FROM ${ORDERS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}
             GROUP BY 1 ORDER BY 2 DESC`,
            params,
            signal,
          ),
          query(
            `SELECT ${dim} AS name, ${money("r.product_refund_amount")} AS refund_amount,
                    coalesce(sum(r.returned_qty), 0)::int AS returned_units
             FROM ${RETURNS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND r.processed_at >= $1::date AND r.processed_at < $2::date + 1${filter.sql}
             GROUP BY 1`,
            params,
            signal,
          ),
        ]);
        const refundsByName = new Map(refunds.map((row) => [row.name as string, row]));
        const total = sales.reduce((sum, row) => sum + (row.net_sales as number), 0);
        return {
          from,
          to,
          dimension,
          total_net_sales: round2(total),
          rows: sales.slice(0, limit).map((row) => {
            const refund = refundsByName.get(row.name as string);
            const units = row.units as number;
            const returned = (refund?.returned_units as number) ?? 0;
            return {
              name: row.name,
              net_sales: row.net_sales,
              share_pct: pct(row.net_sales as number, total),
              orders: row.orders,
              units,
              gross_margin_pct: pct(
                (row.net_sales as number) - (row.cogs as number),
                row.net_sales as number,
              ),
              refund_amount: (refund?.refund_amount as number) ?? 0,
              returned_units: returned,
              return_rate_pct: pct(returned, units),
            };
          }),
        };
      });
    },
  ),

  get_top_products: dataTool(
    "Top products (styles) for a date range ranked by net_sales, units, margin (gross margin %), or return_rate: each row's name, brand, category, subcategory, net_sales (USD), units, orders, gross_margin_pct, refund_amount, and return_rate_pct (returned units / units sold, returns processed in the range). Optional region, category, brand and channel filters.",
    z.object({
      metric: z.enum(["net_sales", "units", "margin", "return_rate"]).default("net_sales"),
      limit: z.number().int().min(3).max(25).default(10).describe("How many products, 3 to 25"),
      ...rangeParams,
      ...sliceParams,
    }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      metric: "net_sales",
      rows: [
        {
          name: "Alpine Fleece Jacket",
          brand: "Northstar",
          category: "apparel",
          subcategory: "Outerwear",
          net_sales: 148_210.4,
          units: 1_620,
          orders: 1_540,
          gross_margin_pct: 61.2,
          refund_amount: 21_480.1,
          return_rate_pct: 14.8,
        },
      ],
    },
    async (args, signal) => {
      const { from, to } = await dateRange(args);
      const metric = oneOf(args.metric, ["net_sales", "units", "margin", "return_rate"], "net_sales");
      const limit = int(args.limit, 10, 3, 25);
      const slice = readSlice(args);
      return run("top-products", { from, to, metric, limit, ...slice }, async () => {
        const { sql: filters, params: values } = sliceWhere(slice, 3);
        const params = [from, to, ...values];
        const [sales, refunds] = await Promise.all([
          query(
            `SELECT p.style_id, p.name, p.brand, p.category, p.subcategory,
                    ${money("oi.line_booked_amount")} AS net_sales,
                    coalesce(sum(oi.ordered_qty), 0)::int AS units,
                    count(DISTINCT o.order_id)::int AS orders,
                    ${money("oi.unit_cogs_at_sale * oi.ordered_qty")} AS cogs
             FROM ${ORDERS_JOIN}${PRODUCTS_JOIN}
             WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filters}
             GROUP BY 1, 2, 3, 4, 5`,
            params,
            signal,
          ),
          query(
            `SELECT p.style_id, ${money("r.product_refund_amount")} AS refund_amount,
                    coalesce(sum(r.returned_qty), 0)::int AS returned_units
             FROM ${RETURNS_JOIN}${PRODUCTS_JOIN}
             WHERE ${SALES_WHERE} AND r.processed_at >= $1::date AND r.processed_at < $2::date + 1${filters}
             GROUP BY 1`,
            params,
            signal,
          ),
        ]);
        const refundsByStyle = new Map(refunds.map((row) => [row.style_id as string, row]));
        const rows = sales.map((row) => {
          const refund = refundsByStyle.get(row.style_id as string);
          const units = row.units as number;
          const returned = (refund?.returned_units as number) ?? 0;
          return {
            name: row.name,
            brand: row.brand,
            category: row.category,
            subcategory: row.subcategory,
            net_sales: row.net_sales as number,
            units,
            orders: row.orders,
            gross_margin_pct: pct(
              (row.net_sales as number) - (row.cogs as number),
              row.net_sales as number,
            ),
            refund_amount: (refund?.refund_amount as number) ?? 0,
            return_rate_pct: pct(returned, units),
          };
        });
        const key = {
          net_sales: (row: (typeof rows)[number]) => row.net_sales,
          units: (row: (typeof rows)[number]) => row.units,
          margin: (row: (typeof rows)[number]) => row.gross_margin_pct,
          return_rate: (row: (typeof rows)[number]) => row.return_rate_pct,
        }[metric];
        // Rankings by rate only consider products with meaningful volume.
        const ranked = (metric === "margin" || metric === "return_rate"
          ? rows.filter((row) => row.units >= 20)
          : rows
        ).sort((a, b) => key(b) - key(a));
        return { from, to, metric, rows: ranked.slice(0, limit) };
      });
    },
  ),

  get_returns_overview: dataTool(
    "Returns and refunds for a date range (by the date the return was processed): total refund_amount (USD), returned_units, return_rate_pct (returned units / units sold in the range), restocked_pct, and rows split by reason, category, or month — each with returned_units, refund_amount, and share_pct of returned units. Optional region, category, brand and channel filters narrow every number to that slice.",
    z.object({
      by: z.enum(["reason", "category", "month"]).default("reason"),
      ...rangeParams,
      ...sliceParams,
    }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      by: "reason",
      refund_amount: 948_112.4,
      returned_units: 10_980,
      return_rate_pct: 20.3,
      restocked_pct: 71.4,
      rows: [
        { name: "size_too_large", returned_units: 2_410, refund_amount: 208_110.5, share_pct: 22.0 },
        { name: "changed_mind", returned_units: 1_980, refund_amount: 171_420.2, share_pct: 18.0 },
      ],
    },
    async (args, signal) => {
      const by = oneOf(args.by, ["reason", "category", "month"], "reason");
      const { from, to } = await dateRange(args, 6, { wholeMonths: by === "month" });
      const slice = readSlice(args);
      return run("returns", { from, to, by, ...slice }, async () => {
        const dim = {
          reason: "coalesce(r.return_reason, 'unknown')",
          category: "p.category",
          month: "to_char(date_trunc('month', r.processed_at), 'YYYY-MM')",
        }[by];
        const filter = sliceWhere(slice, 3);
        const sliceJoins = filter.products ? PRODUCTS_JOIN : "";
        const joins = by === "category" || filter.products ? PRODUCTS_JOIN : "";
        const params = [from, to, ...filter.params];
        const [rows, totals, sold] = await Promise.all([
          query(
            `SELECT ${dim} AS name, coalesce(sum(r.returned_qty), 0)::int AS returned_units,
                    ${money("r.product_refund_amount")} AS refund_amount
             FROM ${RETURNS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND r.processed_at >= $1::date AND r.processed_at < $2::date + 1${filter.sql}
             GROUP BY 1 ORDER BY ${by === "month" ? "1" : "2 DESC"}`,
            params,
            signal,
          ),
          query(
            `SELECT coalesce(sum(r.returned_qty), 0)::int AS returned_units,
                    ${money("r.product_refund_amount")} AS refund_amount,
                    coalesce(sum(r.returned_qty) FILTER (WHERE r.restocked_flag), 0)::int AS restocked
             FROM ${RETURNS_JOIN}${sliceJoins}
             WHERE ${SALES_WHERE} AND r.processed_at >= $1::date AND r.processed_at < $2::date + 1${filter.sql}`,
            params,
            signal,
          ),
          query(
            `SELECT coalesce(sum(oi.ordered_qty), 0)::int AS units
             FROM ${ORDERS_JOIN}${sliceJoins}
             WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}`,
            params,
            signal,
          ),
        ]);
        const total = totals[0] as Record<string, number>;
        return {
          from,
          to,
          by,
          refund_amount: total.refund_amount,
          returned_units: total.returned_units,
          return_rate_pct: pct(total.returned_units, (sold[0]?.units as number) ?? 0),
          restocked_pct: pct(total.restocked, total.returned_units),
          rows: rows.map((row) => ({
            name: row.name,
            returned_units: row.returned_units,
            refund_amount: row.refund_amount,
            share_pct: pct(row.returned_units as number, total.returned_units),
          })),
        };
      });
    },
  ),

  get_targets_vs_actuals: dataTool(
    "Monthly net sales against the approved sales targets, for the whole business or per region or category: one row per month and scope with target (USD), actual (net sales minus refunds processed that month), and attainment_pct. Months run up to the last whole month of data. Targets exist only for the whole business, each region and each category, never per brand or channel, so it filters by region or category only: a region filter gives that region's rows (scope region), a category filter that category's (scope category).",
    z.object({
      scope: z
        .enum(["business", "region", "category"])
        .default("business")
        .describe("business: one row per month; region/category: one row per month and scope"),
      months: z.number().int().min(1).max(24).default(6).describe("How many months back, 1 to 24"),
      region: sliceParams.region,
      category: sliceParams.category,
    }),
    {
      scope: "region",
      rows: [
        { month: "2026-10", scope: "West", target: 320_000, actual: 301_410.8, attainment_pct: 94.2 },
        { month: "2026-10", scope: "South", target: 240_000, actual: 262_200.1, attainment_pct: 109.3 },
      ],
    },
    async (args, signal) => {
      let scope = oneOf(args.scope, ["business", "region", "category"], "business");
      const region = sliceValue(args.region);
      const category = sliceValue(args.category);
      // A filter needs rows at its level: a whole-business query with a region (or category)
      // filter reads that region's targets. Targets have no region × category level, so the
      // filter matching the scope wins.
      if (scope === "business") scope = region ? "region" : category ? "category" : "business";
      const only = scope === "region" ? region : scope === "category" ? category : "";
      const months = int(args.months, 6, 1, 24);
      const { monthEnd } = await dataDays();
      return run("targets", { scope, months, monthEnd, only }, async () => {
        const dim = { business: "'ALL'", region: "o.shipping_region", category: "p.category" }[
          scope
        ];
        const joins = scope === "category" ? PRODUCTS_JOIN : "";
        // The first day of the earliest month: `months` whole months up to the last whole month.
        const since = "date_trunc('month', $1::date) - make_interval(months => $2 - 1)";
        const [targets, sales, refunds] = await Promise.all([
          query(
            `SELECT to_char(month_start, 'YYYY-MM') AS month, scope_id AS scope,
                    round(net_sales_target::numeric, 2)::float8 AS target
             FROM retail.sales_targets
             WHERE scope_type = $3 AND month_start >= ${since} AND month_start <= $1::date
             ORDER BY 1, 2`,
            [monthEnd, months, scope],
            signal,
          ),
          query(
            `SELECT to_char(date_trunc('month', o.placed_at), 'YYYY-MM') AS month, ${dim} AS scope,
                    ${money("oi.line_booked_amount")} AS booked
             FROM ${ORDERS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND o.placed_at >= ${since} AND o.placed_at < $1::date + 1
             GROUP BY 1, 2`,
            [monthEnd, months],
            signal,
          ),
          query(
            `SELECT to_char(date_trunc('month', r.processed_at), 'YYYY-MM') AS month, ${dim} AS scope,
                    ${money("r.product_refund_amount")} AS refunds
             FROM ${RETURNS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND r.processed_at >= ${since} AND r.processed_at < $1::date + 1
             GROUP BY 1, 2`,
            [monthEnd, months],
            signal,
          ),
        ]);
        const booked = new Map(sales.map((row) => [`${row.month}|${row.scope}`, row.booked as number]));
        const refunded = new Map(
          refunds.map((row) => [`${row.month}|${row.scope}`, row.refunds as number]),
        );
        return {
          scope,
          rows: targets
            .filter((row) => !only || String(row.scope).toLowerCase() === only)
            .map((row) => {
            const key = `${row.month}|${row.scope}`;
            const actual = round2((booked.get(key) ?? 0) - (refunded.get(key) ?? 0));
            return {
              month: row.month,
              scope: row.scope,
              target: row.target,
              actual,
              attainment_pct: pct(actual, row.target as number),
            };
          }),
        };
      });
    },
  ),

  get_customer_insights: dataTool(
    "Customers per month for a date range: new_customers (first-ever order that month), returning_customers (ordered that month, first order earlier), orders and net_sales (USD) — plus new customers in the whole range by acquisition channel. Good for new-vs-returning and acquisition dashboards. Optional region, category, brand and channel filters count only customers' orders in that slice (new customers: those whose first order was in it).",
    z.object({ ...rangeParams, ...sliceParams }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      months: [
        {
          month: "2026-10",
          new_customers: 1_840,
          returning_customers: 2_410,
          orders: 4_874,
          net_sales: 967_053.2,
        },
      ],
      new_by_channel: [
        { channel: "paid_search", customers: 2_310 },
        { channel: "organic_search", customers: 1_980 },
      ],
    },
    async (args, signal) => {
      const { from, to } = await dateRange(args, 12, { wholeMonths: true });
      const slice = readSlice(args);
      return run("customers", { from, to, ...slice }, async () => {
        const filter = sliceWhere(slice, 3);
        const joins = filter.products ? PRODUCTS_JOIN : "";
        const params = [from, to, ...filter.params];
        const [months, channels] = await Promise.all([
          query(
            `SELECT to_char(date_trunc('month', o.placed_at), 'YYYY-MM') AS month,
                    count(DISTINCT o.customer_id) FILTER (
                      WHERE date_trunc('month', c.first_ever_order_at) = date_trunc('month', o.placed_at)
                    )::int AS new_customers,
                    count(DISTINCT o.customer_id) FILTER (
                      WHERE c.first_ever_order_at < date_trunc('month', o.placed_at)
                    )::int AS returning_customers,
                    count(DISTINCT o.order_id)::int AS orders,
                    ${money("oi.line_booked_amount")} AS net_sales
             FROM ${ORDERS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}
             GROUP BY 1 ORDER BY 1`,
            params,
            signal,
          ),
          filter.params.length
            ? // New customers whose first order (the same day as their first-ever order) is in the slice.
              query(
                `SELECT coalesce(c.acquisition_channel, 'unknown') AS channel,
                        count(DISTINCT c.customer_id)::int AS customers
                 FROM ${ORDERS_JOIN}${joins}
                 WHERE ${SALES_WHERE}
                   AND c.first_ever_order_at >= $1::date AND c.first_ever_order_at < $2::date + 1
                   AND o.placed_at::date = c.first_ever_order_at::date${filter.sql}
                 GROUP BY 1 ORDER BY 2 DESC`,
                params,
                signal,
              )
            : query(
                `SELECT coalesce(c.acquisition_channel, 'unknown') AS channel,
                        count(*)::int AS customers
                 FROM retail.customers c
                 WHERE NOT c.is_internal
                   AND c.first_ever_order_at >= $1::date AND c.first_ever_order_at < $2::date + 1
                 GROUP BY 1 ORDER BY 2 DESC`,
                [from, to],
                signal,
              ),
        ]);
        return { from, to, months, new_by_channel: channels };
      });
    },
  ),

  get_promotions_performance: dataTool(
    "Promotion performance for a date range, by promo code: orders that used it, discount_amount given (USD), net_sales of those orders, and discount_share_pct (discount as a share of those orders' pre-discount revenue). Sorted by discount amount. Optional region, category, brand and channel filters narrow every number to that slice (category and brand: the discounts and sales of those products' lines).",
    z.object({ ...rangeParams, ...sliceParams }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      rows: [
        {
          code: "FALL20",
          orders: 1_240,
          discount_amount: 86_410.2,
          net_sales: 402_110.9,
          discount_share_pct: 17.7,
        },
      ],
    },
    async (args, signal) => {
      const { from, to } = await dateRange(args);
      const slice = readSlice(args);
      return run("promotions", { from, to, ...slice }, async () => {
        const filter = sliceWhere(slice, 3);
        const joins = filter.products ? PRODUCTS_JOIN : "";
        const params = [from, to, ...filter.params];
        const [discounts, sales] = await Promise.all([
          query(
            `SELECT pr.code, count(DISTINCT op.order_id)::int AS orders,
                    ${money("op.allocated_discount")} AS discount_amount
             FROM retail.order_promotions op
             JOIN retail.promotions pr ON pr.promotion_id = op.promotion_id
             JOIN retail.orders o ON o.order_id = op.order_id
             JOIN retail.customers c ON c.customer_id = o.customer_id${
               // Discounts are allocated to order items: a product filter keeps those items' share.
               filter.products ? `\n             JOIN retail.order_items oi ON oi.order_item_id = op.order_item_id${joins}` : ""
             }
             WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}
             GROUP BY 1 ORDER BY 3 DESC`,
            params,
            signal,
          ),
          query(
            `SELECT pr.code, ${money("oi.line_booked_amount")} AS net_sales
             FROM (SELECT DISTINCT op.order_id, op.promotion_id FROM retail.order_promotions op) x
             JOIN retail.promotions pr ON pr.promotion_id = x.promotion_id
             JOIN retail.orders o ON o.order_id = x.order_id
             JOIN retail.customers c ON c.customer_id = o.customer_id
             JOIN retail.order_items oi ON oi.order_id = o.order_id${joins}
             WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}
             GROUP BY 1`,
            params,
            signal,
          ),
        ]);
        const salesByCode = new Map(sales.map((row) => [row.code as string, row.net_sales as number]));
        return {
          from,
          to,
          rows: discounts.map((row) => {
            const net = salesByCode.get(row.code as string) ?? 0;
            return {
              code: row.code,
              orders: row.orders,
              discount_amount: row.discount_amount,
              net_sales: net,
              discount_share_pct: pct(row.discount_amount as number, net + (row.discount_amount as number)),
            };
          }),
        };
      });
    },
  ),
};
