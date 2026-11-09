import { query } from "../../../../lib/data/db";
import { cached } from "../../../../lib/data/fetch";
import { TABLES } from "../../../../lib/tables";

export const runtime = "nodejs";

// Exact per-table row counts (they must reconcile with the table pages), on-disk sizes, the
// server version, and the orders date range — one round trip, cached for 5 minutes.
const counts = TABLES.map(
  (table) => `SELECT '${table}' AS name, count(*)::bigint AS rows FROM retail.${table}`,
).join(" UNION ALL ");

const sql = `SELECT
  (SELECT jsonb_object_agg(name, rows) FROM (${counts}) c) AS counts,
  (SELECT jsonb_object_agg(pc.relname, pg_total_relation_size(pc.oid))
     FROM pg_class pc JOIN pg_namespace pn ON pn.oid = pc.relnamespace
     WHERE pn.nspname = 'retail' AND pc.relkind = 'r') AS sizes,
  current_database() AS database,
  current_setting('server_version') AS version,
  (SELECT min(placed_at) FROM retail.orders) AS first_order,
  (SELECT max(placed_at) FROM retail.orders) AS last_order`;

export async function GET(request: Request) {
  const summary = await cached("db:summary", 5 * 60_000, async () => {
    const [row] = await query(sql, [], request.signal);
    const host = process.env.DATABASE_URL?.match(/@([^/:?]+)/)?.[1] ?? "";
    return {
      ...row,
      host,
      provider: host.includes("neon.tech") ? "Neon" : "Postgres",
      region: host.match(/[a-z]{2}-[a-z]+-\d/)?.[0] ?? "",
    };
  });
  return Response.json(summary);
}
