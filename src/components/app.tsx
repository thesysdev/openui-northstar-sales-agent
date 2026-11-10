"use client";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { cn } from "@/lib/utils";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  AuiProvider,
  Tools,
  useAui,
  useAuiState,
  useRemoteThreadListRuntime,
  type SuggestionAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import { OpenUICloudProvider, useArtifactList } from "@openuidev/react-ui/cloud";
import { ChatCircle, CircleNotch, SidebarSimple, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import toolkit from "../lib/toolkit";
import { DashboardPanel, OpenDashboardProvider, useOpenDashboard } from "./dashboard";
import { DashboardSidebar } from "./dashboard-sidebar";
import { Notch } from "./notch";
import { ShaderBackdrop } from "./shader-backdrop";
import { HomeSentence } from "./home-sentence";
import { DatabaseView } from "./database-view";
import { localThreadList } from "./threads";

const token = "/api/frontend-token";

/** A message's text, plus a note for each dashboard it created, for the follow-ups model. */
function describe(message: ThreadMessage): string {
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool-call") {
        const args = part.args as { title?: string } | undefined;
        return args?.title ? `[dashboard: ${args.title}]` : "";
      }
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
}

// After each settled run, asks /api/followups for the next three things worth asking.
const suggestionAdapter: SuggestionAdapter = {
  async generate({ messages, signal }) {
    if (messages.at(-1)?.role !== "assistant") return [];
    const transcript = messages
      .slice(-6)
      .map((message) => `${message.role}: ${describe(message)}`)
      .join("\n");
    const response = await fetch("/api/followups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript }),
      signal,
    });
    if (!response.ok) return [];
    const { suggestions } = (await response.json()) as { suggestions: string[] };
    return suggestions.map((prompt) => ({ prompt }));
  },
};

export default function App({ apiBaseUrl, ask }: { apiBaseUrl?: string; ask?: string }) {
  // Each thread posts to /api/chat, which runs the dashboard tools on the server. Threads are
  // kept in this browser (src/components/threads.tsx), not in OpenUI Cloud.
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => useChatRuntime({ adapters: { suggestion: suggestionAdapter } }),
    adapter: localThreadList,
  });
  return (
    // The dashboards' renderers and tabs read OpenUI Cloud through this provider: it fetches the
    // frontend token from /api/frontend-token and refreshes it before it expires.
    <OpenUICloudProvider token={token} apiBaseUrl={apiBaseUrl}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Scopes ask={ask} />
      </AssistantRuntimeProvider>
    </OpenUICloudProvider>
  );
}

function Scopes({ ask }: { ask?: string }) {
  const aui = useAui();
  const config = AuiConfig({
    // The toolkit's browser build: each dashboard tool's card.
    tools: Tools({ toolkit }),
  });
  return (
    <AuiProvider extends={aui} config={config}>
      <OpenDashboardProvider>
        {ask && <AutoAsk text={ask} />}
        <Shell />
      </OpenDashboardProvider>
    </AuiProvider>
  );
}

/** Sends the home page's sentence (?ask=…) as the first message, once. */
function AutoAsk({ text }: { text: string }) {
  const aui = useAui();
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    (aui.thread as unknown as { append: (message: string) => void }).append(text);
    // Drop ?ask so a reload doesn't ask again.
    window.history.replaceState(null, "", "/app");
  }, [text, aui]);
  return null;
}

function Shell() {
  const [dbOpen, setDbOpen] = useState(false);
  // The database view mounts on first open and stays, so reopening is instant.
  const [dbVisited, setDbVisited] = useState(false);

  // The popup closes on Escape.
  useEffect(() => {
    if (!dbOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDbOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dbOpen]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden border-t border-foreground/[0.06] bg-background">
      <AgentView
        hidden={false}
        onShowData={() => {
          setDbOpen(true);
          setDbVisited(true);
        }}
      />
      {(dbVisited || dbOpen) && (
        <div className={cn("fixed inset-0 z-50", !dbOpen && "hidden")}>
          <button
            type="button"
            aria-label="Close database"
            onClick={() => setDbOpen(false)}
            className="absolute inset-0 cursor-default bg-foreground/20 backdrop-blur-[2px] animate-in fade-in duration-200"
          />
          {/* The database, as a full-page popup with 48px of page showing on every side. */}
          <div className="absolute inset-12 flex overflow-hidden rounded-2xl border bg-background shadow-lg animate-in fade-in zoom-in-[0.98] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]">
            <DatabaseView hidden={false} onBack={() => setDbOpen(false)} />
          </div>
          {/* Close sits on the popup's top-right corner. */}
          <button
            type="button"
            onClick={() => setDbOpen(false)}
            aria-label="Close database"
            title="Close"
            className="absolute top-12 right-12 flex size-9 translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform duration-150 hover:scale-105 animate-in fade-in duration-200"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/** The agent: the open dashboard fills the main area; the chat is a column on the right. */
function AgentView({ hidden, onShowData }: { hidden: boolean; onShowData: () => void }) {
  const { open } = useOpenDashboard();
  // A fresh thread with nothing open is the "new dashboard" state: the builder carries it,
  // so the conversation panel stays out of the way until something happens.
  const emptyThread = useAuiState((state) => state.thread.isEmpty);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  // Once any dashboard exists, the rail stays (collapsed) even on a fresh "new dashboard", so
  // earlier dashboards are one click away. Shares the sidebar's cache.
  const hasDashboards =
    useArtifactList({ filter: { type: "dashboard", limit: 1 } }).artifacts.length > 0;
  const hideRail = emptyThread && !open && !hasDashboards;
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 animate-in fade-in duration-200",
        hidden && "hidden",
      )}
    >
      {/* Hidden until there's a dashboard or the agent is working; then it's an icon rail that
          expands on hover. */}
      <div
        className={cn(
          "h-full shrink-0 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          hideRail ? "w-0 overflow-hidden" : "w-14",
        )}
      >
        <DashboardSidebar onShowData={onShowData} collapsed />
      </div>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">
          {open ? (
            // Keyed by the tab or card that opened it, so each opens a fresh panel that
            // slides in with the app's one easing.
            <div
              key={`${open.key}:${open.rev ?? 0}`}
              className="h-full animate-in fade-in slide-in-from-right-4 duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
            >
              <DashboardPanel
                {...("id" in open ? { id: open.id } : { response: open.response })}
                edit={open.edit}
              />
            </div>
          ) : emptyThread ? (
            <MainWelcome wide />
          ) : (
            <PlaceholderGrid />
          )}
        </div>
      </main>
      {/* The conversation panel. Collapsing animates its width; the inner column keeps a fixed
          400px so nothing reflows while it slides. */}
      <aside
        className={cn(
          "relative shrink-0 overflow-hidden border-l transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          chatCollapsed ? "w-0 border-l-0" : "w-100",
          emptyThread && !open && "hidden",
        )}
      >
        <div className="flex h-full w-100 flex-col">
          <button
            type="button"
            onClick={() => setChatCollapsed(true)}
            aria-label="Collapse conversation"
            title="Collapse conversation"
            className="absolute top-2 left-3 z-10 flex size-7 items-center justify-center rounded-md border text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.03] hover:text-foreground"
          >
            <SidebarSimple className="size-4 -scale-x-100" />
          </button>
          <div className="min-h-0 flex-1 pt-10">
            <Thread components={{ Welcome }} />
          </div>
        </div>
      </aside>
      {chatCollapsed && !(emptyThread && !open) && (
        <button
          type="button"
          onClick={() => setChatCollapsed(false)}
          aria-label="Open conversation"
          title="Open conversation"
          className="absolute top-2 right-3 z-20 flex h-7 items-center gap-1.5 rounded-md border bg-background px-2.5 text-sm text-muted-foreground transition-colors duration-150 animate-in fade-in duration-200 hover:bg-foreground/[0.03] hover:text-foreground"
        >
          <ChatCircle className="size-3.5" />
          Edit with chat
        </button>
      )}
    </div>
  );
}

/** With no dashboard open, the main area is the home page experience: the sentence builder.
 * With the conversation panel hidden it takes the full width as one line; beside a visible
 * conversation it stacks. */
function MainWelcome({ wide }: { wide: boolean }) {
  const aui = useAui();
  const send = (prompt: string) =>
    (aui.thread as unknown as { append: (message: string) => void }).append(prompt);
  if (wide) {
    return (
      <div className="flex h-full flex-col bg-background px-8 animate-in fade-in duration-200">
        <HomeSentence onBuild={send} />
      </div>
    );
  }
  return (
    <div className="relative flex h-full items-center justify-center bg-background p-8 animate-in fade-in duration-200">
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/3 left-1/2 size-80 -translate-x-1/2 rounded-full bg-foreground/[0.04] blur-3xl"
      />
      <HomeSentence compact className="w-auto text-2xl" onBuild={send} />
    </div>
  );
}

/** While the agent works and nothing is open yet: a slow shader of the app's hues. */
function PlaceholderGrid() {
  const running = useAuiState((state) => state.thread.isRunning);
  return (
    <div className="relative h-full bg-background">
      <Notch
        show={running}
        icon={<CircleNotch className="size-3 animate-spin motion-reduce:animate-none" />}
        label="Fetching live data…"
      />
      <ShaderBackdrop />
    </div>
  );
}

/** The chat panel stays quiet when empty; the builder lives in the main area. */
function Welcome() {
  return null;
}
