"use client";

import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ActivityEvent = {
  id: number;
  at: number;
  kind: "tool" | "sql";
  tool?: string;
  args?: Record<string, unknown>;
  cache?: "hit" | "miss";
  sql?: string;
  params?: unknown[];
  rows?: number;
  ms?: number;
  error?: string;
};

const time = (at: number) =>
  new Date(at).toLocaleTimeString("en-US", { hour12: false });

/** "from=2026-05-10 · to=2026-11-09 · dimension=region" from a tool's arguments. */
function summarize(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}

/**
 * A live strip under the open dashboard: every data-tool call and every SQL statement the
 * dashboard's queries ran, polled from /api/activity while the dashboard is on screen. A SQL
 * row expands to the statement itself.
 */
export function DataActivity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const lastId = useRef(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/activity?since=${lastId.current}`);
        if (!response.ok || stopped) return;
        const { events: fresh } = (await response.json()) as { events: ActivityEvent[] };
        if (fresh.length === 0) return;
        lastId.current = fresh[fresh.length - 1]!.id;
        setEvents((previous) => [...previous, ...fresh].slice(-100));
      } catch {
        // The strip is informational; a failed poll just tries again.
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  // Follow the newest events unless the user scrolled up to read.
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (nearBottom) element.scrollTop = element.scrollHeight;
  }, [events]);

  return (
    <section className="shrink-0 border-t bg-background">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        className="flex h-9 w-full items-center gap-2 px-3 text-left transition-colors duration-150 hover:bg-foreground/[0.02]"
      >
        {collapsed ? (
          <ChevronUp className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        )}
        <span className="text-xs text-muted-foreground">Data activity</span>
        {events.length > 0 && (
          <span className="inline-flex items-center rounded-md border px-1.5 py-px text-xs text-muted-foreground tabular-nums">
            {events.length}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          every database query, live
        </span>
      </button>
      {!collapsed && (
        <div ref={list} className="max-h-44 overflow-y-auto border-t border-foreground/[0.05]">
          {events.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Nothing yet — open or reload a dashboard and its queries show up here.
            </p>
          ) : (
            events.map((event) => (
              <div
                key={event.id}
                className="border-b border-foreground/[0.04] last:border-b-0 animate-in fade-in duration-200"
              >
                <button
                  type="button"
                  onClick={() =>
                    event.sql && setExpanded(expanded === event.id ? null : event.id)
                  }
                  className={cn(
                    "flex h-8 w-full items-center gap-2 px-3 text-left",
                    event.sql &&
                      "transition-colors duration-150 hover:bg-foreground/[0.02]",
                  )}
                >
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {time(event.at)}
                  </span>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      event.error ? "bg-destructive" : "bg-emerald-500",
                    )}
                  />
                  <span className="shrink-0 rounded-md border px-1.5 py-px font-mono text-xs text-muted-foreground">
                    {event.tool ?? "sql"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {event.kind === "tool" ? summarize(event.args) : event.sql}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {event.kind === "tool"
                      ? event.cache === "hit"
                        ? "cache"
                        : "live"
                      : event.error
                        ? "failed"
                        : `${event.rows} rows · ${event.ms}ms`}
                  </span>
                </button>
                {expanded === event.id && event.sql && (
                  <pre className="mx-3 mb-2 overflow-x-auto rounded-md border bg-muted/50 p-2 text-xs whitespace-pre-wrap text-muted-foreground animate-in fade-in duration-150">
                    {event.sql}
                    {event.params && event.params.length > 0 && (
                      <>{"\n"}params: {JSON.stringify(event.params)}</>
                    )}
                    {event.error && (
                      <>{"\n"}error: {event.error}</>
                    )}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
