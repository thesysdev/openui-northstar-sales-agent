"use client";

import {
  useAui,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import { useCallback, useMemo } from "react";

// The chat is yours to keep: this example keeps it in the browser's localStorage. Swap these
// helpers for your own database to keep threads on your server. OpenUI Cloud only builds and
// stores the dashboards.
const PREFIX = "northstar";

type StoredThread = {
  remoteId: string;
  title?: string;
  status: "regular" | "archived";
  updatedAt: number;
};
/** One message as assistant-ui's format adapter encodes it. */
type StoredMessage = { id: string; parent_id: string | null; format: string; content: unknown };

function read<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(`${PREFIX}:${key}`);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(`${PREFIX}:${key}`, JSON.stringify(value));
  } catch {
    // Storage is full or blocked: the chat still works, it just isn't kept.
  }
}

const threads = () => read<Record<string, StoredThread>>("threads", {});

/** Remembers `remoteId` as the chat of the dashboard `artifactId`. */
export function rememberChatOf(artifactId: string, remoteId: string) {
  write(`chat-of:${artifactId}`, remoteId);
}

/** Remembers the chat a create_dashboard result came from, by the dashboard it names. */
export function rememberChat(response: string, remoteId: string) {
  const artifactId = response.match(/artifact_id=(art_[A-Za-z0-9_-]+)/)?.[1];
  if (artifactId) rememberChatOf(artifactId, remoteId);
}

/**
 * The chat a dashboard was made in. A dashboard from before its chat was remembered is found in
 * the stored chats, by the create_dashboard result that names it, and remembered then.
 */
function chatOf(artifactId: string): string | undefined {
  const known = read<string | null>(`chat-of:${artifactId}`, null);
  if (known && threads()[known]) return known;
  const found = Object.values(threads())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .find(({ remoteId }) =>
      JSON.stringify(read(`messages:${remoteId}`, [])).includes(`artifact_id=${artifactId}`),
    )?.remoteId;
  if (found) write(`chat-of:${artifactId}`, found);
  return found;
}

/**
 * Opens the chat a dashboard was made in. A dashboard with no chat gets an empty one; the chat
 * becomes its chat once you send a message there (OpenDashboardProvider).
 */
export function useOpenChatOf() {
  const aui = useAui();
  return useCallback(
    (artifactId: string) => {
      const remoteId = chatOf(artifactId);
      const current = aui.threadListItem.getState().remoteId;
      if (remoteId) {
        if (remoteId !== current) aui.threads.switchToThread(remoteId);
      } else if (current !== undefined) {
        // A chat that hasn't sent anything yet has no id, and is empty already.
        aui.threads.switchToNewThread();
      }
    },
    [aui],
  );
}

function updateThread(remoteId: string, change: Partial<StoredThread>) {
  const all = threads();
  const current = all[remoteId] ?? { remoteId, status: "regular" as const, updatedAt: 0 };
  write("threads", { ...all, [remoteId]: { ...current, ...change, updatedAt: Date.now() } });
}

/** Loads and saves each thread's messages. */
function useHistory() {
  const aui = useAui();
  const history = useMemo<ThreadHistoryAdapter>(
    () => ({
      async load() {
        return { messages: [] };
      },
      async append() {},
      withFormat: (format) => ({
        async load() {
          const { remoteId } = aui.threadListItem.getState();
          if (!remoteId) return { messages: [] };
          return {
            messages: read<StoredMessage[]>(`messages:${remoteId}`, []).map((row) =>
              format.decode(row as never),
            ),
          };
        },
        async append(item) {
          const { remoteId } = await aui.threadListItem.initialize();
          const row: StoredMessage = {
            id: format.getId(item.message),
            parent_id: item.parentId,
            format: format.format,
            content: format.encode(item),
          };
          // A message is saved again as it updates, such as when a tool's result arrives.
          const rows = read<StoredMessage[]>(`messages:${remoteId}`, []).filter(
            (stored) => stored.id !== row.id,
          );
          write(`messages:${remoteId}`, [...rows, row]);
          updateThread(remoteId, {});
        },
      }),
    }),
    [aui],
  );
  return useMemo(() => ({ history }), [history]);
}

/** The first user message, as a title. */
function titleOf(
  messages: readonly { role: string; content: readonly { type: string; text?: string }[] }[],
) {
  const first = messages.find((message) => message.role === "user");
  const text = first?.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .trim();
  return (text || "New chat").slice(0, 60);
}

/** assistant-ui's thread list, kept in localStorage. */
export const localThreadList: RemoteThreadListAdapter = {
  async list() {
    return {
      threads: Object.values(threads())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ remoteId, title, status }) => ({ remoteId, title, status })),
    };
  },
  async initialize(threadId) {
    updateThread(threadId, {});
    return { remoteId: threadId };
  },
  async rename(remoteId, title) {
    updateThread(remoteId, { title });
  },
  async archive(remoteId) {
    updateThread(remoteId, { status: "archived" });
  },
  async unarchive(remoteId) {
    updateThread(remoteId, { status: "regular" });
  },
  // A deleted chat's dashboards keep their entries; opening one then just shows the dashboard.
  async delete(remoteId) {
    const { [remoteId]: _, ...rest } = threads();
    write("threads", rest);
    try {
      localStorage.removeItem(`${PREFIX}:messages:${remoteId}`);
    } catch {
      // Nothing to remove.
    }
  },
  async fetch(remoteId) {
    const thread = threads()[remoteId];
    return { remoteId, status: thread?.status ?? "regular", title: thread?.title };
  },
  async generateTitle(remoteId, messages) {
    const title = titleOf(messages);
    updateThread(remoteId, { title });
    return createAssistantStream((controller) => controller.appendText(title));
  },
  unstable_useAdapters: useHistory,
};
