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
import { FILTERS, FILTER_NAMES, optionLabel, type FilterName } from "./filters";
import { dataTool } from "./tool";

// Data tools over the Neon sales database (schema `retail`): 100k orders from Nov 2024 to
// its latest order, in USD. "Net sales" is revenue after discounts (before refunds): completed, captured
// orders only, with test orders and internal customers excluded. Refunds come from returns,
// by the date they were processed. Results are cached for 3 minutes.
//
// Every tool takes the same frame: `range`, a dashboard's date filter value as is, and the
// region, category, brand and channel filters. A dashboard passes its filters into each Query
// unchanged, so every card follows them, and never has to work a date out itself.

const TTL = 3 * 60_000;
const run = <T>(name: string, args: Record<string, unknown>, load: () => Promise<T>) => {
  const key = `sales:${name}:${JSON.stringify(args)}`;
  // One activity event per tool call; a cache hit runs no SQL, and the panel says so.
  record({
    kind: "tool",
    tool: name,
    args,
    cache: cacheHas(key) ? "hit" : "miss",
  });
  return toolContext.run(name, () => cached(key, TTL, load));
};

const INTERVALS = ["day", "week", "month"] as const;
type Interval = (typeof INTERVALS)[number];
const TREND_DIMS = ["none", "region", "category", "brand", "channel", "device"] as const;
const BREAKDOWN_DIMS = Object.keys(DIMENSIONS) as Dimension[];
/** What customers, promotions and returns can be split by: the filter dimensions. */
const GROUPS = ["none", ...FILTER_NAMES] as const;

const range = z
  .string()
  .optional()
  .describe(
    'The dashboard\'s date filter value, as is: "1m", "3m", "6m" or "12m" (months back from the last day of data), "30d", "ytd", "lifetime", or a custom "YYYY-MM-DD..YYYY-MM-DD". Default "6m".',
  );

/** A filter's argument: one of the values in the data, or "" for all. */
const filterParam = (name: FilterName) =>
  z
    .enum(["", ...FILTERS[name].values])
    .optional()
    .describe(`${FILTERS[name].label} filter. "" for all.`);

/** The arguments every tool takes: the date range and the four filters. */
const frame = {
  range,
  region: filterParam("region"),
  category: filterParam("category"),
  brand: filterParam("brand"),
  channel: filterParam("channel"),
};

/**
 * The arguments with `range` read into months or from/to: "3m" is 3 months back, "30d" 30 days,
 * "ytd" this year, "lifetime" all the data, and "2026-09-08..2026-10-15" those dates. Dashboards
 * made before `range` pass months or from/to themselves, which read as before.
 */
async function withRange(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const value = text(args.range).toLowerCase().replace(/\s+/g, "");
  if (!value) return args;
  const custom = value.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (custom) return { ...args, from: custom[1], to: custom[2] };
  const { first, last } = await dataDays();
  // No `to`: the last day of data, or for monthly series the last whole month.
  if (/^(lifetime|all|alltime|max)$/.test(value)) return { ...args, from: first, to: undefined };
  if (value === "ytd") return { ...args, from: `${last.slice(0, 4)}-01-01`, to: undefined };
  // "3m", "30d", "1y", "last_quarter", "last-month", "6months"…
  const preset = value.match(
    /^(?:last[_-]?)?(\d+)?[_-]?(days?|weeks?|months?|quarters?|years?|d|w|m|q|y)$/,
  );
  if (!preset) return args;
  const count = Number(preset[1] ?? 1);
  const unit = preset[2]![0];
  if (unit === "d" || unit === "w") {
    const start = new Date(`${last}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - (unit === "d" ? count : count * 7) + 1);
    return { ...args, from: start.toISOString().slice(0, 10), to: last };
  }
  const months = unit === "m" ? count : unit === "q" ? count * 3 : count * 12;
  return {
    ...args,
    months: Math.min(24, Math.max(1, months)),
    from: undefined,
    to: undefined,
  };
}

type Slice = Record<FilterName, string>;

/** One filter value, lower-cased; "", "all", "All regions" and the like mean no filter. */
function sliceValue(value: unknown): string {
  const picked = text(value).toLowerCase().slice(0, 60);
  return /^(all|any)\b/.test(picked) ? "" : picked;
}

function readSlice(args: Record<string, unknown>): Slice {
  const slice = Object.fromEntries(
    FILTER_NAMES.map((key) => [key, sliceValue(args[key])]),
  ) as Slice;
  // A channel may arrive as rows show it: "Paid search" for paid_search.
  slice.channel = slice.channel.replace(/ /g, "_");
  return slice;
}

/**
 * SQL for a slice, numbering its parameters from `first`: ` AND lower(o.shipping_region) = $3…`,
 * and whether it needs the products join (category and brand live on products).
 */
function sliceWhere(
  slice: Slice,
  first: number,
): { sql: string; params: string[]; products: boolean } {
  const params: string[] = [];
  let sql = "";
  for (const key of FILTER_NAMES) {
    if (!slice[key]) continue;
    params.push(slice[key]);
    sql += ` AND lower(${DIMENSIONS[key].sql}) = $${first + params.length - 1}`;
  }
  return { sql, params, products: Boolean(slice.category || slice.brand) };
}

/** Period expression and label format for a trend interval. */
const periodExpr = (interval: Interval, column: string) =>
  interval === "month"
    ? `to_char(date_trunc('month', ${column}), 'YYYY-MM')`
    : `to_char(date_trunc('${interval}', ${column}), 'YYYY-MM-DD')`;

const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Whether a call passes `range`. Dashboards made before it get the results they were written for. */
const modern = (args: Record<string, unknown>) => Boolean(text(args.range));

/**
 * How a range reads over time: per day up to 2 months, per week up to 6, per month beyond, and
 * the dates its periods cover. Months are whole ones, up to the last whole month, so a series
 * never starts or ends on part of a month.
 */
async function overTime(ranged: Record<string, unknown>, from: string, to: string) {
  const span = days(from, to);
  const interval: Interval = span <= 62 ? "day" : span <= 200 ? "week" : "month";
  if (interval !== "month") return { interval, from, to };
  return { interval, ...(await dateRange(ranged, 6, { wholeMonths: true })) };
}

const tools = {
  get_sales_overview: dataTool(
    "Headline KPIs for the range: net_sales (USD, after discounts, before refunds), orders, units, aov (average order value), discount_amount and discount_rate_pct, gross_margin_pct, refund_amount, returned_units and refund_rate_pct (refunds processed in the range as a share of net sales). previous {net_sales, orders, units, aov, gross_margin_pct, refund_rate_pct} is the same for the range of the same length just before, and change {net_sales_pct, orders_pct, aov_pct} the move from it; both are null when that earlier range starts before the data does (a long range, or lifetime). Follows the range, region, category, brand and channel filters.",
    z.object(frame),
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
      previous: {
        net_sales: 4_890_200.1,
        orders: 25_100,
        units: 51_300,
        aov: 194.83,
        gross_margin_pct: 57.6,
        refund_rate_pct: 17.4,
      },
      change: { net_sales_pct: 6.4, orders_pct: 5.2, aov_pct: 1.1 },
    },
    async (args, signal) => {
      const { from, to } = await dateRange(await withRange(args));
      const prev = previousRange(from, to);
      // A previous range reaching before the data would compare with a few weeks of orders.
      const comparable = prev.from >= (await dataDays()).first;
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
        const refund = (current: boolean) =>
          (refunds.find((row) => row.current === current) ?? {
            refund_amount: 0,
            returned_units: 0,
          }) as Record<string, number>;
        const ref = refund(true);
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
          previous: comparable
            ? {
                net_sales: was.net_sales,
                orders: was.orders,
                units: was.units,
                aov: prevAov,
                gross_margin_pct: pct(was.net_sales - was.cogs, was.net_sales),
                refund_rate_pct: pct(refund(false).refund_amount, was.net_sales),
              }
            : {
                net_sales: null,
                orders: null,
                units: null,
                aov: null,
                gross_margin_pct: null,
                refund_rate_pct: null,
              },
          change: comparable
            ? {
                net_sales_pct: changePct(cur.net_sales, was.net_sales),
                orders_pct: changePct(cur.orders, was.orders),
                aov_pct: changePct(aov, prevAov),
              }
            : { net_sales_pct: null, orders_pct: null, aov_pct: null },
        };
      });
    },
  ),

  get_sales_trend: dataTool(
    "Net sales (USD) and orders over time as aligned series: periods (the labels; weeks are labelled by their Monday) and one series per group with net_sales and orders per period, total, and change_pct (last period vs the one before). group_by none gives a single 'All' series; region, category, brand, channel or device gives one series each. interval auto fits the range: days up to 2 months, weeks up to 6 months, months beyond. Monthly series end at the last whole month. Follows the range, region, category, brand and channel filters.",
    z.object({
      group_by: z.enum(TREND_DIMS).default("none"),
      interval: z.enum(["auto", ...INTERVALS]).default("auto"),
      ...frame,
    }),
    {
      from: "2026-08-01",
      to: "2026-10-31",
      interval: "month",
      group_by: "category",
      periods: ["2026-08", "2026-09", "2026-10"],
      series: [
        {
          name: "Apparel",
          net_sales: [402_110.4, 438_900.2, 451_220.8],
          orders: [2_210, 2_390, 2_460],
          total: 1_292_231.4,
          change_pct: 2.8,
        },
        {
          name: "Footwear",
          net_sales: [281_400.1, 305_220.6, 298_100.3],
          orders: [1_480, 1_610, 1_570],
          total: 884_721.0,
          change_pct: -2.3,
        },
      ],
    },
    async (args, signal) => {
      const groupBy = oneOf(args.group_by, TREND_DIMS, "none");
      const ranged = await withRange(args);
      let { from, to } = await dateRange(ranged);
      // Dashboards made before `range` and "auto" expect months when they name no interval.
      const asked = oneOf(
        args.interval,
        ["auto", ...INTERVALS] as const,
        text(args.range) ? "auto" : "month",
      );
      const span = days(from, to);
      const interval: Interval =
        asked !== "auto" ? asked : span <= 62 ? "day" : span <= 200 ? "week" : "month";
      if (interval === "month") ({ from, to } = await dateRange(ranged, 6, { wholeMonths: true }));
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
    "Net sales (USD) split by one dimension (region, state, category, subcategory, brand, channel (traffic source) or device), sorted by net sales: each row's name, net_sales, share_pct, orders, units, aov, gross_margin_pct, refund_amount and returned_units (returns processed in the range), and return_rate_pct (returned units as a share of units sold). Follows the range, region, category, brand and channel filters.",
    z.object({
      dimension: z.enum(BREAKDOWN_DIMS as [Dimension, ...Dimension[]]).default("category"),
      limit: z.number().int().min(3).max(25).default(10).describe("How many rows, 3 to 25"),
      ...frame,
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
          aov: 199.81,
          gross_margin_pct: 58.4,
          refund_amount: 310_200.7,
          returned_units: 3_580,
          return_rate_pct: 20.1,
        },
      ],
    },
    async (args, signal) => {
      const { from, to } = await dateRange(await withRange(args));
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
            const orders = row.orders as number;
            const returned = (refund?.returned_units as number) ?? 0;
            return {
              name: row.name,
              net_sales: row.net_sales,
              share_pct: pct(row.net_sales as number, total),
              orders,
              units,
              aov: orders ? round2((row.net_sales as number) / orders) : 0,
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
    "Top products (styles) ranked by net_sales, units, margin (gross margin %) or return_rate: each row's name, brand, category, subcategory, net_sales (USD), units, orders, gross_margin_pct, refund_amount, and return_rate_pct (returned units / units sold, returns processed in the range). group_by region, category, brand or channel ranks within each instead: every row then also has group, and there are up to 5 rows per group, the biggest group first (one Table, grouped by that column). Follows the range, region, category, brand and channel filters.",
    z.object({
      metric: z.enum(["net_sales", "units", "margin", "return_rate"]).default("net_sales"),
      group_by: z.enum(GROUPS).default("none"),
      limit: z
        .number()
        .int()
        .min(3)
        .max(25)
        .optional()
        .describe("How many products, 3 to 25. Default 10. At most 5 per group."),
      ...frame,
    }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      metric: "net_sales",
      group_by: "none",
      rows: [
        {
          name: "Alpine Fleece Jacket",
          brand: "Northstar",
          category: "Apparel",
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
      const { from, to } = await dateRange(await withRange(args));
      const metric = oneOf(
        args.metric,
        ["net_sales", "units", "margin", "return_rate"],
        "net_sales",
      );
      const groupBy = oneOf(args.group_by, GROUPS, "none");
      const slice = readSlice(args);
      // A grouped table lists every group, so each gets 5 at most; one group alone gets the full list.
      const grouped = groupBy !== "none" && !slice[groupBy];
      const limit = grouped ? Math.min(5, int(args.limit, 5, 3, 25)) : int(args.limit, 10, 3, 25);
      return run("top-products", { from, to, metric, groupBy, limit, ...slice }, async () => {
        const { sql: filters, params: values } = sliceWhere(slice, 3);
        const params = [from, to, ...values];
        const grp = groupBy === "none" ? "'All'" : DIMENSIONS[groupBy].sql;
        const [sales, refunds] = await Promise.all([
          query(
            `SELECT ${grp} AS grp, p.style_id, p.name, p.brand, p.category, p.subcategory,
                    ${money("oi.line_booked_amount")} AS net_sales,
                    coalesce(sum(oi.ordered_qty), 0)::int AS units,
                    count(DISTINCT o.order_id)::int AS orders,
                    ${money("oi.unit_cogs_at_sale * oi.ordered_qty")} AS cogs
             FROM ${ORDERS_JOIN}${PRODUCTS_JOIN}
             WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filters}
             GROUP BY 1, 2, 3, 4, 5, 6`,
            params,
            signal,
          ),
          query(
            `SELECT ${grp} AS grp, p.style_id, ${money("r.product_refund_amount")} AS refund_amount,
                    coalesce(sum(r.returned_qty), 0)::int AS returned_units
             FROM ${RETURNS_JOIN}${PRODUCTS_JOIN}
             WHERE ${SALES_WHERE} AND r.processed_at >= $1::date AND r.processed_at < $2::date + 1${filters}
             GROUP BY 1, 2`,
            params,
            signal,
          ),
        ]);
        const refundsByStyle = new Map(refunds.map((row) => [`${row.grp}|${row.style_id}`, row]));
        const rows = sales.map((row) => {
          const refund = refundsByStyle.get(`${row.grp}|${row.style_id}`);
          const units = row.units as number;
          const returned = (refund?.returned_units as number) ?? 0;
          return {
            ...(groupBy !== "none" && { group: row.grp as string }),
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
        const ranked = (
          metric === "margin" || metric === "return_rate"
            ? rows.filter((row) => row.units >= 20)
            : rows
        ).sort((a, b) => key(b) - key(a));
        if (groupBy === "none")
          return {
            from,
            to,
            metric,
            group_by: groupBy,
            rows: ranked.slice(0, limit),
          };
        // The top `limit` of each group, the group with the most net sales first.
        const groups = new Map<string, { net: number; rows: typeof rows }>();
        for (const row of rows) {
          const group = groups.get(row.group!) ?? { net: 0, rows: [] };
          group.net += row.net_sales;
          groups.set(row.group!, group);
        }
        for (const row of ranked) {
          const group = groups.get(row.group!)!;
          if (group.rows.length < limit) group.rows.push(row);
        }
        return {
          from,
          to,
          metric,
          group_by: groupBy,
          rows: [...groups.values()].sort((a, b) => b.net - a.net).flatMap((group) => group.rows),
        };
      });
    },
  ),

  get_returns_overview: dataTool(
    "Returns and refunds (by the date the return was processed): refund_amount (USD), returned_units, return_rate_pct (returned units / units sold in the range) and restocked_pct for the whole range, previous {refund_amount, returned_units, return_rate_pct} for the range just before (null when it starts before the data), over_time (returned_units, refund_amount and return_rate_pct per period: days, weeks or months, whichever fits the range), and rows split by reason, month, region, category, brand or channel: each row's name, returned_units, refund_amount, share_pct of returned units, and (for every split but reason) return_rate_pct, the returned units as a share of that row's units sold. Follows the range, region, category, brand and channel filters.",
    z.object({
      by: z.enum(["reason", "month", ...FILTER_NAMES]).default("reason"),
      ...frame,
    }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      by: "category",
      refund_amount: 948_112.4,
      returned_units: 10_980,
      return_rate_pct: 20.3,
      restocked_pct: 71.4,
      previous: {
        refund_amount: 902_480.1,
        returned_units: 10_410,
        return_rate_pct: 19.8,
      },
      over_time: [
        {
          period: "2026-09",
          returned_units: 1_810,
          refund_amount: 158_210.4,
          return_rate_pct: 19.9,
        },
        {
          period: "2026-10",
          returned_units: 1_920,
          refund_amount: 166_480.2,
          return_rate_pct: 20.6,
        },
      ],
      rows: [
        {
          name: "Footwear",
          returned_units: 4_410,
          refund_amount: 402_110.5,
          share_pct: 40.2,
          return_rate_pct: 24.1,
        },
        {
          name: "Apparel",
          returned_units: 5_080,
          refund_amount: 441_420.2,
          share_pct: 46.3,
          return_rate_pct: 19.2,
        },
      ],
    },
    async (args, signal) => {
      const by = oneOf(args.by, ["reason", "month", ...FILTER_NAMES], "reason");
      const ranged = await withRange(args);
      const { from, to } = await dateRange(ranged, 6, {
        wholeMonths: by === "month",
      });
      const series = modern(args) ? await overTime(ranged, from, to) : null;
      const prev = previousRange(from, to);
      const comparable = prev.from >= (await dataDays()).first;
      const slice = readSlice(args);
      return run("returns", { from, to, by, series, ...slice }, async () => {
        const month = (column: string) => `to_char(date_trunc('month', ${column}), 'YYYY-MM')`;
        // The split, on returns (by when they were processed) and on sales (by when they were placed).
        const dim =
          by === "reason"
            ? "coalesce(r.return_reason, 'unknown')"
            : by === "month"
              ? month("r.processed_at")
              : DIMENSIONS[by].sql;
        const soldDim =
          by === "month" ? month("o.placed_at") : by === "reason" ? null : DIMENSIONS[by].sql;
        const filter = sliceWhere(slice, 3);
        const sliceJoins = filter.products ? PRODUCTS_JOIN : "";
        const joins =
          filter.products || (by !== "reason" && by !== "month" && DIMENSIONS[by].products)
            ? PRODUCTS_JOIN
            : "";
        const params = [from, to, ...filter.params];
        // Returned units and refunds, and the units sold, over a range.
        const whole = (range: string[]) =>
          Promise.all([
            query(
              `SELECT coalesce(sum(r.returned_qty), 0)::int AS returned_units,
                      ${money("r.product_refund_amount")} AS refund_amount,
                      coalesce(sum(r.returned_qty) FILTER (WHERE r.restocked_flag), 0)::int AS restocked
               FROM ${RETURNS_JOIN}${sliceJoins}
               WHERE ${SALES_WHERE} AND r.processed_at >= $1::date AND r.processed_at < $2::date + 1${filter.sql}`,
              [...range, ...filter.params],
              signal,
            ),
            query(
              `SELECT coalesce(sum(oi.ordered_qty), 0)::int AS units
               FROM ${ORDERS_JOIN}${sliceJoins}
               WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}`,
              [...range, ...filter.params],
              signal,
            ),
          ]);
        // Returns by when they were processed and units sold by when they were placed, per period.
        const periods = series
          ? Promise.all([
              query(
                `SELECT ${periodExpr(series.interval, "r.processed_at")} AS period,
                        coalesce(sum(r.returned_qty), 0)::int AS returned_units,
                        ${money("r.product_refund_amount")} AS refund_amount
                 FROM ${RETURNS_JOIN}${sliceJoins}
                 WHERE ${SALES_WHERE} AND r.processed_at >= $1::date AND r.processed_at < $2::date + 1${filter.sql}
                 GROUP BY 1 ORDER BY 1`,
                [series.from, series.to, ...filter.params],
                signal,
              ),
              query(
                `SELECT ${periodExpr(series.interval, "o.placed_at")} AS period,
                        coalesce(sum(oi.ordered_qty), 0)::int AS units
                 FROM ${ORDERS_JOIN}${sliceJoins}
                 WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}
                 GROUP BY 1`,
                [series.from, series.to, ...filter.params],
                signal,
              ),
            ])
          : null;
        const [rows, [totals, sold], before, soldBy, overTimeRows] = await Promise.all([
          query(
            `SELECT ${dim} AS name, coalesce(sum(r.returned_qty), 0)::int AS returned_units,
                    ${money("r.product_refund_amount")} AS refund_amount
             FROM ${RETURNS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND r.processed_at >= $1::date AND r.processed_at < $2::date + 1${filter.sql}
             GROUP BY 1 ORDER BY ${by === "month" ? "1" : "2 DESC"}`,
            params,
            signal,
          ),
          whole([from, to]),
          comparable ? whole([prev.from, prev.to]) : null,
          soldDim
            ? query(
                `SELECT ${soldDim} AS name, coalesce(sum(oi.ordered_qty), 0)::int AS units
                 FROM ${ORDERS_JOIN}${joins}
                 WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}
                 GROUP BY 1`,
                params,
                signal,
              )
            : [],
          periods,
        ]);
        const total = totals[0] as Record<string, number>;
        const was = before?.[0][0] as Record<string, number> | undefined;
        const soldIn = new Map(
          (overTimeRows?.[1] ?? []).map((row) => [row.period as string, row.units as number]),
        );
        const unitsSold = new Map(soldBy.map((row) => [row.name as string, row.units as number]));
        return {
          from,
          to,
          by,
          refund_amount: total.refund_amount,
          returned_units: total.returned_units,
          return_rate_pct: pct(total.returned_units, (sold[0]?.units as number) ?? 0),
          restocked_pct: pct(total.restocked, total.returned_units),
          previous: was
            ? {
                refund_amount: was.refund_amount,
                returned_units: was.returned_units,
                return_rate_pct: pct(was.returned_units, (before?.[1][0]?.units as number) ?? 0),
              }
            : {
                refund_amount: null,
                returned_units: null,
                return_rate_pct: null,
              },
          ...(overTimeRows && {
            over_time: overTimeRows[0].map((row) => ({
              period: row.period,
              returned_units: row.returned_units,
              refund_amount: row.refund_amount,
              return_rate_pct: pct(
                row.returned_units as number,
                soldIn.get(row.period as string) ?? 0,
              ),
            })),
          }),
          rows: rows.map((row) => ({
            name: row.name,
            returned_units: row.returned_units,
            refund_amount: row.refund_amount,
            share_pct: pct(row.returned_units as number, total.returned_units),
            ...(soldDim && {
              return_rate_pct: pct(
                row.returned_units as number,
                unitsSold.get(row.name as string) ?? 0,
              ),
            }),
          })),
        };
      });
    },
  ),

  get_targets_vs_actuals: dataTool(
    "Net sales against the approved monthly sales targets, for the whole business (scope business), each region, or each category. total: target, actual (net sales minus refunds processed) and attainment_pct over the whole range, for headline numbers. previous: the same for the months just before (null when they start before the data). totals: the same per scope over the whole range, for a bar or table per region or category. over_time: one row per month (period, target, actual, attainment_pct) summed over the scopes, for target against actual over time. rows: one per month and scope, for a month-by-scope grid. Targets are monthly, so the range counts whole months up to the last whole month, and they aren't set per brand or channel. Follows the range filter and the region or category filter: with one set, every scope, business included, gives that region's or category's numbers, so pass it into every call.",
    z.object({
      scope: z.enum(["business", "region", "category"]).default("business"),
      range,
      region: frame.region,
      category: frame.category,
    }),
    {
      scope: "region",
      total: { target: 1_680_000, actual: 1_673_180.6, attainment_pct: 99.6 },
      previous: {
        target: 1_590_000,
        actual: 1_548_220.3,
        attainment_pct: 97.4,
      },
      totals: [
        {
          scope: "West",
          target: 960_000,
          actual: 921_300.4,
          attainment_pct: 96.0,
        },
        {
          scope: "South",
          target: 720_000,
          actual: 751_880.2,
          attainment_pct: 104.4,
        },
      ],
      over_time: [
        {
          period: "2026-09",
          target: 540_000,
          actual: 529_310.4,
          attainment_pct: 98.0,
        },
        {
          period: "2026-10",
          target: 560_000,
          actual: 563_610.9,
          attainment_pct: 100.6,
        },
      ],
      rows: [
        {
          month: "2026-10",
          scope: "West",
          target: 320_000,
          actual: 301_410.8,
          attainment_pct: 94.2,
        },
        {
          month: "2026-10",
          scope: "South",
          target: 240_000,
          actual: 262_200.1,
          attainment_pct: 109.3,
        },
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
      const { monthEnd } = await dataDays();
      // Targets are monthly up to the last whole month: a date filter's range counts as the whole
      // months from its start to there (a range ending earlier still ends at the last whole month).
      const ranged = await withRange(args);
      const start = /^\d{4}-\d{2}-\d{2}$/.test(text(ranged.from)) ? text(ranged.from) : "";
      const months = start
        ? Math.min(
            24,
            Math.max(
              1,
              (Number(monthEnd.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
                Number(monthEnd.slice(5, 7)) -
                Number(start.slice(5, 7)) +
                1,
            ),
          )
        : int(ranged.months, 6, 1, 24);
      // The same number of months just before, when the data reaches that far back.
      const firstMonth = new Date(
        Date.UTC(Number(monthEnd.slice(0, 4)), Number(monthEnd.slice(5, 7)) - months, 1),
      );
      const before = new Date(firstMonth.getTime() - 86_400_000).toISOString().slice(0, 10);
      const beforeStart = new Date(
        Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() - months, 1),
      )
        .toISOString()
        .slice(0, 10);
      const comparable = beforeStart >= `${(await dataDays()).first.slice(0, 7)}-01`;
      return run("targets", { scope, months, monthEnd, only }, async () => {
        const dim = {
          business: "'ALL'",
          region: "o.shipping_region",
          category: "p.category",
        }[scope];
        const joins = scope === "category" ? PRODUCTS_JOIN : "";
        // The first day of the earliest month: `months` whole months up to the month of `end`.
        const since = "date_trunc('month', $1::date) - make_interval(months => $2 - 1)";
        /** One row per month and scope, for the `months` months ending with `end`'s. */
        const load = async (end: string) => {
          const [targets, sales, refunds] = await Promise.all([
            query(
              `SELECT to_char(month_start, 'YYYY-MM') AS month, scope_id AS scope,
                    round(net_sales_target::numeric, 2)::float8 AS target
             FROM retail.sales_targets
             WHERE scope_type = $3 AND month_start >= ${since} AND month_start <= $1::date
             ORDER BY 1, 2`,
              [end, months, scope],
              signal,
            ),
            query(
              `SELECT to_char(date_trunc('month', o.placed_at), 'YYYY-MM') AS month, ${dim} AS scope,
                    ${money("oi.line_booked_amount")} AS booked
             FROM ${ORDERS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND o.placed_at >= ${since} AND o.placed_at < $1::date + 1
             GROUP BY 1, 2`,
              [end, months],
              signal,
            ),
            query(
              `SELECT to_char(date_trunc('month', r.processed_at), 'YYYY-MM') AS month, ${dim} AS scope,
                    ${money("r.product_refund_amount")} AS refunds
             FROM ${RETURNS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND r.processed_at >= ${since} AND r.processed_at < $1::date + 1
             GROUP BY 1, 2`,
              [end, months],
              signal,
            ),
          ]);
          const booked = new Map(
            sales.map((row) => [`${row.month}|${row.scope}`, row.booked as number]),
          );
          const refunded = new Map(
            refunds.map((row) => [`${row.month}|${row.scope}`, row.refunds as number]),
          );
          return targets
            .filter((row) => !only || String(row.scope).toLowerCase() === only)
            .map((row) => {
              const key = `${row.month}|${row.scope}`;
              const actual = round2((booked.get(key) ?? 0) - (refunded.get(key) ?? 0));
              return {
                month: row.month as string,
                scope: row.scope as string,
                target: row.target as number,
                actual,
                attainment_pct: pct(actual, row.target as number),
              };
            });
        };
        const [rows, earlier] = await Promise.all([
          load(monthEnd),
          comparable ? load(before) : null,
        ]);
        const was = earlier && {
          target: round2(earlier.reduce((sum, row) => sum + row.target, 0)),
          actual: round2(earlier.reduce((sum, row) => sum + row.actual, 0)),
        };
        // Each scope over the whole range, in the order the rows first name them.
        const sums = new Map<string, { target: number; actual: number }>();
        for (const row of rows) {
          const sum = sums.get(row.scope) ?? { target: 0, actual: 0 };
          sum.target += row.target;
          sum.actual += row.actual;
          sums.set(row.scope, sum);
        }
        const totals = [...sums].map(([name, sum]) => ({
          scope: name,
          target: round2(sum.target),
          actual: round2(sum.actual),
          attainment_pct: pct(sum.actual, sum.target),
        }));
        const target = round2(totals.reduce((total, row) => total + row.target, 0));
        const actual = round2(totals.reduce((total, row) => total + row.actual, 0));
        // Each month over every scope.
        const byMonth = new Map<string, { target: number; actual: number }>();
        for (const row of rows) {
          const sum = byMonth.get(row.month) ?? { target: 0, actual: 0 };
          sum.target += row.target;
          sum.actual += row.actual;
          byMonth.set(row.month, sum);
        }
        return {
          scope,
          total: { target, actual, attainment_pct: pct(actual, target) },
          previous: was
            ? { ...was, attainment_pct: pct(was.actual, was.target) }
            : { target: null, actual: null, attainment_pct: null },
          totals,
          over_time: [...byMonth].map(([period, sum]) => ({
            period,
            target: round2(sum.target),
            actual: round2(sum.actual),
            attainment_pct: pct(sum.actual, sum.target),
          })),
          rows,
        };
      });
    },
  ),

  get_customer_insights: dataTool(
    "Customers who ordered in the range: customers, new_customers (first-ever order in the range), returning_customers (first ordered before it), new_share_pct, repeat_rate_pct (the share who ordered more than once in the range), orders, net_sales (USD), aov and orders_per_customer; previous {customers, new_customers, orders, net_sales} for the range just before (null when it starts before the data); over_time, new_customers, returning_customers, orders and net_sales per period (days, weeks or months, whichever fits the range); new_by_channel, new customers by acquisition channel; and rows, the same counts split by group_by (region, category, brand or channel: customers who ordered in each). Follows the range, region, category, brand and channel filters.",
    z.object({
      group_by: z
        .enum(GROUPS)
        .default("none")
        .describe("What rows are split by. none leaves rows empty."),
      ...frame,
    }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      customers: 18_420,
      new_customers: 9_840,
      returning_customers: 8_580,
      new_share_pct: 53.4,
      repeat_rate_pct: 28.6,
      orders: 26_410,
      net_sales: 5_204_310.5,
      aov: 197.06,
      orders_per_customer: 1.43,
      previous: {
        customers: 17_210,
        new_customers: 9_020,
        orders: 24_870,
        net_sales: 4_890_200.1,
      },
      over_time: [
        {
          period: "2026-10",
          new_customers: 1_840,
          returning_customers: 2_410,
          orders: 4_874,
          net_sales: 967_053.2,
        },
      ],
      new_by_channel: [
        { channel: "Paid search", customers: 2_310 },
        { channel: "Organic search", customers: 1_980 },
      ],
      group_by: "region",
      rows: [
        {
          name: "West",
          customers: 6_110,
          new_customers: 3_240,
          returning_customers: 2_870,
          new_share_pct: 53.0,
          repeat_rate_pct: 27.9,
          orders: 8_610,
          net_sales: 1_720_410.2,
          aov: 199.81,
          orders_per_customer: 1.41,
        },
      ],
    },
    async (args, signal) => {
      const ranged = await withRange(args);
      // With `range`, the same dates as the other tools' headline numbers; whole months before it.
      const { from, to } = await dateRange(ranged, 12, {
        wholeMonths: !modern(args),
      });
      const series = modern(args)
        ? await overTime(ranged, from, to)
        : { interval: "month" as Interval, from, to };
      const groupBy = oneOf(args.group_by, GROUPS, "none");
      const prev = previousRange(from, to);
      const comparable = prev.from >= (await dataDays()).first;
      const slice = readSlice(args);
      return run("customers", { from, to, groupBy, series, ...slice }, async () => {
        const filter = sliceWhere(slice, 3);
        const params = [from, to, ...filter.params];
        // Per `dim`: its customers, those whose first-ever order is in the range, and those who
        // ordered more than once in it. One row per customer first, then counted.
        const counts = (dim: string, products: boolean, range = [from, to]) =>
          query(
            `SELECT name, count(*)::int AS customers,
                    count(*) FILTER (WHERE fresh)::int AS new_customers,
                    count(*) FILTER (WHERE orders > 1)::int AS repeat_customers,
                    coalesce(sum(orders), 0)::int AS orders,
                    coalesce(round(sum(net)::numeric, 2), 0)::float8 AS net_sales
             FROM (
               SELECT ${dim} AS name, o.customer_id,
                      bool_or(c.first_ever_order_at >= $1::date AND c.first_ever_order_at < $2::date + 1) AS fresh,
                      count(DISTINCT o.order_id) AS orders,
                      sum(oi.line_booked_amount) AS net
               FROM ${ORDERS_JOIN}${products || filter.products ? PRODUCTS_JOIN : ""}
               WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}
               GROUP BY 1, 2
             ) per_customer
             GROUP BY 1 ORDER BY 2 DESC`,
            [...range, ...filter.params],
            signal,
          );
        const joins = filter.products ? PRODUCTS_JOIN : "";
        const [all, before, groups, months, channels] = await Promise.all([
          counts("'All'", false),
          comparable ? counts("'All'", false, [prev.from, prev.to]) : null,
          groupBy === "none" ? [] : counts(DIMENSIONS[groupBy].sql, DIMENSIONS[groupBy].products),
          // Per period: customers whose first-ever order falls in it, and those who had one before it.
          query(
            `SELECT ${periodExpr(series.interval, "o.placed_at")} AS period,
                    count(DISTINCT o.customer_id) FILTER (
                      WHERE date_trunc('${series.interval}', c.first_ever_order_at) = date_trunc('${series.interval}', o.placed_at)
                    )::int AS new_customers,
                    count(DISTINCT o.customer_id) FILTER (
                      WHERE c.first_ever_order_at < date_trunc('${series.interval}', o.placed_at)
                    )::int AS returning_customers,
                    count(DISTINCT o.order_id)::int AS orders,
                    ${money("oi.line_booked_amount")} AS net_sales
             FROM ${ORDERS_JOIN}${joins}
             WHERE ${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}
             GROUP BY 1 ORDER BY 1`,
            [series.from, series.to, ...filter.params],
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
        const shape = (row: Record<string, unknown> | undefined) => {
          const customers = (row?.customers as number) ?? 0;
          const fresh = (row?.new_customers as number) ?? 0;
          const repeat = (row?.repeat_customers as number) ?? 0;
          const orders = (row?.orders as number) ?? 0;
          const netSales = (row?.net_sales as number) ?? 0;
          return {
            customers,
            new_customers: fresh,
            returning_customers: customers - fresh,
            new_share_pct: pct(fresh, customers),
            repeat_rate_pct: pct(repeat, customers),
            orders,
            net_sales: netSales,
            aov: orders ? round2(netSales / orders) : 0,
            orders_per_customer: customers ? round2(orders / customers) : 0,
          };
        };
        const total = shape(all[0]);
        const was = before ? shape(before[0]) : null;
        return {
          from,
          to,
          customers: total.customers,
          new_customers: total.new_customers,
          returning_customers: total.returning_customers,
          new_share_pct: total.new_share_pct,
          repeat_rate_pct: total.repeat_rate_pct,
          orders: total.orders,
          net_sales: total.net_sales,
          aov: total.aov,
          orders_per_customer: total.orders_per_customer,
          previous: {
            customers: was?.customers ?? null,
            new_customers: was?.new_customers ?? null,
            orders: was?.orders ?? null,
            net_sales: was?.net_sales ?? null,
          },
          // Dashboards made before `range` read these as `months`, each with its `month`.
          ...(modern(args)
            ? { over_time: months }
            : {
                months: months.map(({ period, ...row }) => ({
                  month: period,
                  ...row,
                })),
              }),
          new_by_channel: channels,
          group_by: groupBy,
          rows: groups.map((row) => ({ name: row.name, ...shape(row) })),
        };
      });
    },
  ),

  get_promotions_performance: dataTool(
    "Promotion performance: promo_orders (orders that used a promo code), promo_order_share_pct (their share of all orders), discount_amount given (USD), promo_net_sales (net sales of those orders) and discount_share_pct (discount as a share of those orders' pre-discount revenue) for the whole range, previous {promo_orders, discount_amount, promo_net_sales} for the range just before (null when it starts before the data), over_time (promo_orders and discount_amount per period: days, weeks or months, whichever fits the range), and rows split by group_by: code (each promo code, the default), region, category, brand or channel, each with name, orders, discount_amount, net_sales and discount_share_pct, sorted by discount amount. Follows the range, region, category, brand and channel filters.",
    z.object({
      group_by: z.enum(["code", ...FILTER_NAMES]).default("code"),
      ...frame,
    }),
    {
      from: "2026-05-10",
      to: "2026-11-09",
      promo_orders: 6_210,
      promo_order_share_pct: 23.5,
      discount_amount: 312_480.2,
      promo_net_sales: 1_402_110.9,
      discount_share_pct: 18.2,
      previous: {
        promo_orders: 5_870,
        discount_amount: 298_110.4,
        promo_net_sales: 1_340_220.3,
      },
      over_time: [
        { period: "2026-09", promo_orders: 980, discount_amount: 49_210.4 },
        { period: "2026-10", promo_orders: 1_120, discount_amount: 56_480.2 },
      ],
      group_by: "code",
      rows: [
        {
          name: "FALL20",
          orders: 1_240,
          discount_amount: 86_410.2,
          net_sales: 402_110.9,
          discount_share_pct: 17.7,
        },
      ],
    },
    async (args, signal) => {
      const ranged = await withRange(args);
      const { from, to } = await dateRange(ranged);
      const series = modern(args) ? await overTime(ranged, from, to) : null;
      const groupBy = oneOf(args.group_by, ["code", ...FILTER_NAMES], "code");
      const prev = previousRange(from, to);
      const comparable = prev.from >= (await dataDays()).first;
      const slice = readSlice(args);
      return run("promotions", { from, to, groupBy, series, ...slice }, async () => {
        const filter = sliceWhere(slice, 3);
        const params = [from, to, ...filter.params];
        const placed = `${SALES_WHERE} AND o.placed_at >= $1::date AND o.placed_at < $2::date + 1${filter.sql}`;
        // Promo orders, the discount they were given and their net sales, per `dim`. Discounts are
        // allocated to order items, so a product split or filter keeps those items' share.
        const promos = async (
          dim: string,
          products: boolean,
          byCode: boolean,
          range = [from, to],
        ) => {
          const items = products || filter.products;
          const params = [...range, ...filter.params];
          const [discounts, sales] = await Promise.all([
            query(
              `SELECT ${dim} AS name, count(DISTINCT op.order_id)::int AS orders,
                      ${money("op.allocated_discount")} AS discount_amount
               FROM retail.order_promotions op
               JOIN retail.promotions pr ON pr.promotion_id = op.promotion_id
               JOIN retail.orders o ON o.order_id = op.order_id
               JOIN retail.customers c ON c.customer_id = o.customer_id${
                 items
                   ? `\n               JOIN retail.order_items oi ON oi.order_item_id = op.order_item_id${PRODUCTS_JOIN}`
                   : ""
               }
               WHERE ${placed}
               GROUP BY 1 ORDER BY 3 DESC`,
              params,
              signal,
            ),
            query(
              `SELECT ${dim} AS name, ${money("oi.line_booked_amount")} AS net_sales
               FROM (SELECT DISTINCT op.order_id${byCode ? ", op.promotion_id" : ""}
                     FROM retail.order_promotions op) x${
                       byCode
                         ? "\n               JOIN retail.promotions pr ON pr.promotion_id = x.promotion_id"
                         : ""
                     }
               JOIN retail.orders o ON o.order_id = x.order_id
               JOIN retail.customers c ON c.customer_id = o.customer_id
               JOIN retail.order_items oi ON oi.order_id = o.order_id${items ? PRODUCTS_JOIN : ""}
               WHERE ${placed}
               GROUP BY 1`,
              params,
              signal,
            ),
          ]);
          const salesByName = new Map(
            sales.map((row) => [row.name as string, row.net_sales as number]),
          );
          return discounts.map((row) => {
            const net = salesByName.get(row.name as string) ?? 0;
            const discount = row.discount_amount as number;
            return {
              name: row.name as string,
              orders: row.orders as number,
              discount_amount: discount,
              net_sales: net,
              discount_share_pct: pct(discount, net + discount),
            };
          });
        };
        const [rows, all, before, orders, periods] = await Promise.all([
          groupBy === "code"
            ? promos("pr.code", false, true)
            : promos(DIMENSIONS[groupBy].sql, DIMENSIONS[groupBy].products, false),
          promos("'All'", false, false),
          comparable ? promos("'All'", false, false, [prev.from, prev.to]) : null,
          query(
            `SELECT count(DISTINCT o.order_id)::int AS orders
             FROM ${ORDERS_JOIN}${filter.products ? PRODUCTS_JOIN : ""}
             WHERE ${placed}`,
            params,
            signal,
          ),
          series
            ? query(
                `SELECT ${periodExpr(series.interval, "o.placed_at")} AS period,
                        count(DISTINCT op.order_id)::int AS promo_orders,
                        ${money("op.allocated_discount")} AS discount_amount
                 FROM retail.order_promotions op
                 JOIN retail.orders o ON o.order_id = op.order_id
                 JOIN retail.customers c ON c.customer_id = o.customer_id${
                   filter.products
                     ? `\n                 JOIN retail.order_items oi ON oi.order_item_id = op.order_item_id${PRODUCTS_JOIN}`
                     : ""
                 }
                 WHERE ${placed}
                 GROUP BY 1 ORDER BY 1`,
                [series.from, series.to, ...filter.params],
                signal,
              )
            : null,
        ]);
        const total = all[0] ?? {
          orders: 0,
          discount_amount: 0,
          net_sales: 0,
          discount_share_pct: 0,
        };
        return {
          from,
          to,
          promo_orders: total.orders,
          promo_order_share_pct: pct(total.orders, (orders[0]?.orders as number) ?? 0),
          discount_amount: total.discount_amount,
          promo_net_sales: total.net_sales,
          discount_share_pct: total.discount_share_pct,
          previous: {
            promo_orders: before ? (before[0]?.orders ?? 0) : null,
            discount_amount: before ? (before[0]?.discount_amount ?? 0) : null,
            promo_net_sales: before ? (before[0]?.net_sales ?? 0) : null,
          },
          ...(periods && { over_time: periods }),
          group_by: groupBy,
          // `code` too: dashboards made before group_by read rows.code.
          rows: groupBy === "code" ? rows.map((row) => ({ ...row, code: row.name })) : rows,
        };
      });
    },
  ),
};

const NAMED = new Set(["name", "scope", "group", "category", "channel"]);

/**
 * A result with its rows' names as a reader sees them: "paid_search" → "Paid search",
 * "apparel" → "Apparel". Only inside lists: a result's own `scope` or `group_by` stays as asked.
 */
function display(value: unknown, listed = false): unknown {
  if (Array.isArray(value)) return value.map((item) => display(item, true));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      listed && NAMED.has(key) && typeof field === "string"
        ? optionLabel(field)
        : display(field, listed),
    ]),
  );
}

// Dashboards made before `range` look rows up by their raw names ("apparel"), so only a call
// that passes `range` gets display names.
export const salesTools = Object.fromEntries(
  Object.entries(tools).map(([name, tool]) => [
    name,
    {
      ...tool,
      execute: async (...call: Parameters<typeof tool.execute>) => {
        const result = await tool.execute(...call);
        return text((call[0] as Record<string, unknown> | undefined)?.range)
          ? display(result)
          : result;
      },
    },
  ]),
) as typeof tools;
