"use client";

import { cn } from "@/lib/utils";
import { TABLE_DESCRIPTIONS, TABLE_GROUPS, type TableName } from "@/lib/tables";
import { DatabaseIcon, TableIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { withBase } from "../lib/base-path";

type Row = Record<string, unknown>;
type TableData = { rows: Row[]; total: number; limit: number };
type Summary = {
  counts: Record<TableName, number>;
  sizes: Record<TableName, number>;
  database: string;
  version: string;
  first_order: string;
  last_order: string;
  provider: string;
  region: string;
};
type Selection = "overview" | TableName;

/**
 * The Data view: a left rail with the overview and the grouped tables, and a content pane
 * showing either the database summary or one table, 100 rows at a time.
 */
export function DatabaseView({ hidden, onBack }: { hidden: boolean; onBack: () => void }) {
  const [selection, setSelection] = useState<Selection>("overview");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [data, setData] = useState<Partial<Record<TableName, TableData>>>({});
  const [failed, setFailed] = useState<Selection | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(withBase("/api/db/summary"), { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<Summary>) : null))
      .then((loaded) => loaded && setSummary(loaded))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selection === "overview" || data[selection]) return;
    const table = selection;
    const controller = new AbortController();
    setFailed(null);
    fetch(withBase(`/api/db?table=${table}`), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<TableData>;
      })
      .then((loaded) => setData((previous) => ({ ...previous, [table]: loaded })))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(table);
      });
    return () => controller.abort();
  }, [selection, data]);

  const loadMore = (table: TableName) => {
    const current = data[table];
    if (!current || loadingMore) return;
    setLoadingMore(true);
    fetch(withBase(`/api/db?table=${table}&offset=${current.rows.length}`))
      .then((response) => (response.ok ? (response.json() as Promise<TableData>) : null))
      .then((loaded) => {
        if (loaded) {
          setData((previous) => ({
            ...previous,
            [table]: { ...loaded, rows: [...(previous[table]?.rows ?? []), ...loaded.rows] },
          }));
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  return (
    <div
      className={cn("flex min-h-0 flex-1 font-mono animate-in fade-in duration-200", hidden && "hidden")}
    >
      <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
        <RailRow
          icon={DatabaseIcon}
          active={selection === "overview"}
          onClick={() => setSelection("overview")}
        >
          Overview
        </RailRow>
        {TABLE_GROUPS.map((group) => (
          <div
            key={group.label}
            className="mt-2 flex flex-col gap-0.5 border-t border-foreground/[0.06]"
          >
            <span className="px-2 pt-3 pb-1 text-xs text-muted-foreground/70">{group.label}</span>
            {group.tables.map((table) => (
              <RailRow
                key={table}
                icon={TableIcon}
                active={selection === table}
                onClick={() => setSelection(table)}
                count={summary?.counts[table]}
              >
                {table}
              </RailRow>
            ))}
          </div>
        ))}
      </nav>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background">
        {selection === "overview" ? (
          <Overview summary={summary} onOpen={setSelection} />
        ) : (
          <TablePage
            table={selection}
            data={data[selection]}
            failed={failed === selection}
            loadingMore={loadingMore}
            onLoadMore={() => loadMore(selection)}
          />
        )}
      </div>
    </div>
  );
}

function RailRow({
  icon: Icon,
  active,
  onClick,
  count,
  children,
}: {
  icon: typeof TableIcon;
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.03] hover:text-foreground",
        active && "bg-[#107C41]/10 text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0 text-[#107C41]" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {count.toLocaleString()}
        </span>
      )}
    </button>
  );
}

// In UTC, as stored: a late order on the last day isn't next month in the browser's time zone.
const MONTH = { month: "short", year: "numeric", timeZone: "UTC" } as const;
const months = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", MONTH);

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** The summary page: connection, the headline numbers, and every table with its share. */
function Overview({
  summary,
  onOpen,
}: {
  summary: Summary | null;
  onOpen: (table: TableName) => void;
}) {
  if (!summary) {
    return <p className="p-6 text-sm text-muted-foreground">Loading the database summary…</p>;
  }
  const totalBytes = Object.values(summary.sizes).reduce((sum, bytes) => sum + bytes, 0);
  const maxRows = Math.max(...Object.values(summary.counts));
  const stats: { label: string; value: string }[] = [
    { label: "Orders", value: summary.counts.orders.toLocaleString() },
    { label: "Order items", value: summary.counts.order_items.toLocaleString() },
    { label: "Customers", value: summary.counts.customers.toLocaleString() },
    { label: "Products", value: summary.counts.products.toLocaleString() },
    { label: "Returns", value: summary.counts.returns.toLocaleString() },
    {
      label: "Order history",
      value: `${months(summary.first_order)} – ${months(summary.last_order)}`,
    },
  ];
  return (
    <div className="flex w-full flex-col pb-10">
      {/* Each section runs edge to edge; its content stays on the shared column. */}
      <section className="px-6 py-5">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-medium tracking-tight">{summary.database}</h2>
            <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Connected to {summary.provider}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {summary.region && <>{summary.region} · </>}PostgreSQL{" "}
            {summary.version.split(".")[0]} · {formatBytes(totalBytes)}
          </p>
        </div>
      </section>

      <section className="border-t border-foreground/[0.06] px-6 py-4">
        <div className="mx-auto grid max-w-3xl grid-cols-2 sm:grid-cols-3">
          {stats.map((stat, index) => (
            <div
              key={stat.label}
              className={cn(
                "flex flex-col gap-0.5 py-3 pr-4",
                index >= 2 && "max-sm:border-t max-sm:border-foreground/[0.05]",
                index >= 3 && "sm:border-t sm:border-foreground/[0.05]",
                index % 2 === 1 && "max-sm:border-l max-sm:border-foreground/[0.05] max-sm:pl-4",
                index % 3 !== 0 && "sm:border-l sm:border-foreground/[0.05] sm:pl-4",
              )}
            >
              <span className="text-xl tabular-nums">{stat.value}</span>
              <span className="text-xs text-muted-foreground">{stat.label}</span>
            </div>
          ))}
        </div>
      </section>

      {TABLE_GROUPS.map((group) => (
        <section key={group.label} className="border-t border-foreground/[0.06] px-6 py-3">
          <div className="mx-auto max-w-3xl">
            <span className="block px-0 pt-1 pb-1 text-xs text-muted-foreground/70">
              {group.label}
            </span>
            {group.tables.map((table) => (
              <button
                key={table}
                type="button"
                onClick={() => onOpen(table)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors duration-150 hover:bg-foreground/[0.02]"
              >
                <TableIcon className="size-3.5 shrink-0 text-[#107C41]" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm">{table}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {TABLE_DESCRIPTIONS[table]}
                  </span>
                </span>
                <span className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-[3px] bg-foreground/[0.06] sm:block">
                  <span
                    className="block h-full rounded-[3px] bg-foreground/25"
                    style={{ width: `${Math.max(2, (summary.counts[table] / maxRows) * 100)}%` }}
                  />
                </span>
                <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {summary.counts[table].toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** One table: its first rows newest first, and load more below. */
function TablePage({
  table,
  data,
  failed,
  loadingMore,
  onLoadMore,
}: {
  table: TableName;
  data: TableData | undefined;
  failed: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  const updateFade = () => {
    const el = scroller.current;
    if (!el) return;
    setMoreRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  };
  useEffect(() => {
    updateFade();
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(updateFade);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const columns = data?.rows[0] ? Object.keys(data.rows[0]) : [];
  const numeric = new Set(
    columns.filter((column) => {
      const value = data?.rows.find((row) => row[column] != null)?.[column];
      return (
        typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value))
      );
    }),
  );
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-6 pb-10">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-sm font-medium">retail.{table}</h2>
        {data && (
          <span className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
            {data.total.toLocaleString()} rows
          </span>
        )}
        <span className="text-xs text-muted-foreground">{TABLE_DESCRIPTIONS[table]}</span>
      </div>

      {failed ? (
        <p className="px-1 text-sm text-muted-foreground">
          Couldn&apos;t load {table}. Switch tables and back to retry.
        </p>
      ) : !data ? (
        <p className="px-1 text-sm text-muted-foreground">Loading {table}…</p>
      ) : (
        <>
          <div className="relative">
            <div ref={scroller} onScroll={updateFade} className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th
                        key={column}
                        className={cn(
                          "border-b px-3 py-2 text-left text-xs font-normal whitespace-nowrap text-muted-foreground",
                          numeric.has(column) && "text-right",
                        )}
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, index) => (
                    <tr
                      key={index}
                      className="border-b border-foreground/[0.04] transition-colors duration-150 last:border-b-0 hover:bg-foreground/[0.02]"
                    >
                      {columns.map((column) => (
                        <Cell
                          key={column}
                          value={row[column]}
                          numeric={numeric.has(column)}
                          id={column.endsWith("_id")}
                        />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {moreRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-background to-transparent" />
            )}
          </div>
          <div className="flex items-center gap-3 px-1">
            <p className="text-xs text-muted-foreground tabular-nums">
              Showing {data.rows.length.toLocaleString()} of {data.total.toLocaleString()} rows,
              newest first.
            </p>
            {data.rows.length < data.total && (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.03] hover:text-foreground disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load 100 more"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function Cell({ value, numeric, id }: { value: unknown; numeric: boolean; id: boolean }) {
  let text: string;
  let muted = false;
  if (value == null) {
    text = "—";
    muted = true;
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false";
    muted = !value;
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else if (typeof value === "string" && TIMESTAMP.test(value)) {
    text = `${value.slice(0, 10)} ${value.slice(11, 16)}`;
  } else {
    text = String(value);
  }
  return (
    <td
      className={cn(
        "max-w-64 truncate px-3 py-1.5 whitespace-nowrap",
        numeric && "text-right tabular-nums",
        id && "font-mono text-xs text-muted-foreground",
        muted && "text-muted-foreground",
      )}
      title={text.length > 40 ? text : undefined}
    >
      {text}
    </td>
  );
}
