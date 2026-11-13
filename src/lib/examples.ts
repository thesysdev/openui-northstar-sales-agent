import { filterArgs, filterStatements } from "./filter-bar";

// Example dashboards for the builder, written with this app's own data tools in place of the
// dashboard library's generic ones (which query SQL by hand and write numbers in). They show
// what a Northstar dashboard is made of: the filter bar's values passed into every Query, a lead
// strip of headline numbers, the split the dashboard is about, a trend, then detail.

/** Sales split by region: headline numbers, the regions compared, their trend, top products. */
const SALES_BY_REGION = `root = Dashboard([filters, lead, regions, trend, products])
${filterStatements("3m", ["region"], { compare: true })}
overview = Query("get_sales_overview", {${filterArgs(["region"])}}, {net_sales: 0, orders: 0, aov: 0, gross_margin_pct: 0, refund_rate_pct: 0, previous: {net_sales: null, orders: null, aov: null}})
byRegion = Query("get_sales_breakdown", {dimension: "region", ${filterArgs(["region"])}}, {rows: []})
overTime = Query("get_sales_trend", {group_by: "region", ${filterArgs(["region"])}}, {periods: [], series: []})
top = Query("get_top_products", {limit: 10, ${filterArgs(["region"])}}, {rows: []})
lead = Section("", [Kpis([Kpi("Net sales", overview.net_sales, "currency-compact", overview.previous.net_sales), Kpi("Orders", overview.orders, "number", overview.previous.orders), Kpi("Average order value", overview.aov, "currency-precise", overview.previous.aov), Kpi("Gross margin", overview.gross_margin_pct, "percent"), Kpi("Refund rate", overview.refund_rate_pct, "percent", null, "down")])])
regions = Section("Regions", [Row([Card("Net sales by region", [Bars(byRegion.rows.name, [Series("Net sales", byRegion.rows.net_sales)], "currency-compact")], "half", "USD"), Card("Region detail", [Table([Column("Region", byRegion.rows.name, "primary"), Column("Share", byRegion.rows.share_pct, "number", "percent"), Column("Orders", byRegion.rows.orders, "number", "number"), Column("Average order", byRegion.rows.aov, "number", "currency-precise"), Column("Return rate", byRegion.rows.return_rate_pct, "number", "percent")])], "half")], 400)])
trend = Section("Over time", [Row([Card("Net sales by region", [TimeSeries(overTime.periods, @Each(overTime.series, "s", Series(s.name, s.net_sales)), "line", "currency-compact")], "full", "USD")])])
products = Section("Products", [Row([Card("Top products", [Table([Column("Product", top.rows.name, "primary"), Column("Brand", top.rows.brand, "chip"), Column("Category", top.rows.category, "chip"), Column("Net sales", top.rows.net_sales, "bar", "currency-compact"), Column("Units", top.rows.units, "number", "number"), Column("Gross margin", top.rows.gross_margin_pct, "number", "percent"), Column("Return rate", top.rows.return_rate_pct, "number", "percent")], 10)], "full", "Ranked by net sales")])])`;

/** Net sales against target by category: one Query gives the headline, each category, and each month. */
const TARGETS_BY_CATEGORY = `root = Dashboard([filters, lead, categories, months])
${filterStatements("12m", ["category"])}
targets = Query("get_targets_vs_actuals", {scope: "category", ${filterArgs(["category"])}}, {total: {target: 0, actual: 0, attainment_pct: 0}, totals: [], over_time: [], rows: []})
lead = Section("", [Kpis([Kpi("Net sales", targets.total.actual, "currency-compact", null, null, "After refunds"), Kpi("Target", targets.total.target, "currency-compact"), Kpi("Attainment", targets.total.attainment_pct, "percent", null, null, "Net sales as a share of target")])])
categories = Section("Categories", [Row([Card("Net sales vs target", [Bars(targets.totals.scope, [Series("Net sales", targets.totals.actual), Series("Target", targets.totals.target)], "currency-compact", "vertical")], "half", "USD"), Card("Attainment by category", [Bars(targets.totals.scope, [Series("Attainment", targets.totals.attainment_pct)], "percent", "horizontal", false, "up", [Reference("Target", 100)])], "half", "Net sales as a share of target")])])
months = Section("Month by month", [Row([Card("Net sales vs target", [TimeSeries(targets.over_time.period, [Series("Net sales", targets.over_time.actual), Series("Target", targets.over_time.target)], "bar", "currency-compact")], "full", "USD")]), Row([Card("Attainment by month", [Heatmap(targets.rows.scope, targets.rows.month, targets.rows.attainment_pct, "percent", true, 100)], "full", "Net sales as a share of target")])])`;

export const examples: string[] = [SALES_BY_REGION, TARGETS_BY_CATEGORY];
