import { query } from "../../../lib/data/db";
import { TABLES } from "../../../lib/tables";

export const runtime = "nodejs";

const ROWS = 100;

/** 100 rows of one retail table, newest first, from `offset`, with its total row count. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const table = params.get("table") ?? TABLES[0];
  if (!(TABLES as readonly string[]).includes(table)) {
    return Response.json({ error: `Unknown table: ${table}` }, { status: 400 });
  }
  const offset = Math.max(0, Math.min(100_000, Number(params.get("offset")) || 0));
  const [rows, counts] = await Promise.all([
    query(
      `SELECT * FROM retail.${table} ORDER BY 1 DESC LIMIT ${ROWS} OFFSET ${offset}`,
      [],
      request.signal,
    ),
    query<{ count: number }>(
      `SELECT count(*)::int AS count FROM retail.${table}`,
      [],
      request.signal,
    ),
  ]);
  return Response.json({ table, rows, total: counts[0]?.count ?? rows.length, limit: ROWS });
}
