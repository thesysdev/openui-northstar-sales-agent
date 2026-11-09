import { AsyncLocalStorage } from "node:async_hooks";
import { currentVisitor } from "../visitor";

// A small in-memory log of what the data layer did: one event per tool call (with cache
// hit/miss) and one per SQL statement that actually ran. The dashboard panel polls it so the
// user can watch which data each dashboard touched. Kept on globalThis because Next.js dev
// compiles each API route with its own module instance; the buffer must be shared between the
// interpreter route (which writes) and /api/activity (which reads). Each event belongs to the
// visitor it ran for, and each visitor reads only their own.

export type ActivityEvent = {
  id: number;
  at: number;
  visitor?: string;
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

type Store = { events: ActivityEvent[]; nextId: number; toolContext: AsyncLocalStorage<string> };

const store: Store = ((globalThis as Record<string, unknown>).__dataActivity ??= {
  events: [],
  nextId: 1,
  toolContext: new AsyncLocalStorage<string>(),
} satisfies Store) as Store;

/** Names the data tool whose `execute` is running, so its SQL events carry the tool name. */
export const toolContext = store.toolContext;

export function record(event: Omit<ActivityEvent, "id" | "at" | "visitor">): void {
  store.events.push({ ...event, visitor: currentVisitor(), id: store.nextId++, at: Date.now() });
  if (store.events.length > 1000) store.events.splice(0, store.events.length - 1000);
}

export function since(id: number, visitor: string): ActivityEvent[] {
  return store.events.filter((event) => event.id > id && event.visitor === visitor);
}
