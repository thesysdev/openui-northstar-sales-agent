import { createOpenAI } from "@ai-sdk/openai";
import { AISDKToolkit } from "@assistant-ui/ai-sdk";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { NextRequest } from "next/server";
import { baseUrl } from "../../../lib/openui";
import { chatPrompt } from "../../../lib/prompt";
import toolkit from "../../../lib/toolkit";
import { asVisitor, noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

// The toolkit's server build: create_dashboard and edit_dashboard, with their `execute`.
const dashboardTools = new AISDKToolkit({ toolkit });

// The browser keeps the thread and sends it whole, so it decides what the model reads. These keep
// that within what a real chat sends: a long chat with many dashboards is well under the body cap.
const MAX_BODY = 200_000;
const MAX_QUESTION = 2000;
const MAX_MESSAGES = 30;
const ARTIFACT_ID = /^art_[A-Za-z0-9_-]{1,64}$/;

/** The thread to answer: its latest messages, users' and the assistant's only, ending in a question. */
function parseThread(
  raw: string,
): { thread: UIMessage[]; dashboard?: string } | { error: string; shape?: unknown } {
  if (raw.length > MAX_BODY) return { error: "This chat is too long to send. Start a new dashboard." };
  let messages: unknown;
  let dashboard: unknown;
  try {
    ({ messages, dashboard } = JSON.parse(raw) as { messages?: unknown; dashboard?: unknown });
  } catch {
    // Not what this app's page sends; most likely a page open from an older version.
  }
  if (!Array.isArray(messages)) return { error: "Reload the page, then send your message again." };
  const thread = (messages as UIMessage[])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .slice(-MAX_MESSAGES);
  const question = thread.at(-1);
  const length = Array.isArray(question?.parts)
    ? question.parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0)
    : 0;
  // What a rejected thread looked like, for the server log: its size and its last messages' roles and parts.
  const shape = {
    bytes: raw.length,
    messages: messages.length,
    tail: (messages as UIMessage[]).slice(-3).map((message) => ({
      role: message?.role,
      parts: Array.isArray(message?.parts) ? message.parts.map((part) => part?.type) : typeof message?.parts,
    })),
  };
  if (question?.role !== "user") return { error: "The thread has to end with your message.", shape };
  if (!length || length > MAX_QUESTION) {
    return { error: `Messages can be up to ${MAX_QUESTION} characters.`, shape };
  }
  // The dashboard open beside the chat. Only its id reaches the prompt, and OpenUI Cloud lets the
  // visitor edit only their own dashboards.
  const open = typeof dashboard === "string" && ARTIFACT_ID.test(dashboard) ? dashboard : undefined;
  return { thread, dashboard: open };
}

export async function POST(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  const apiKey = process.env.THESYS_API_KEY;
  if (!apiKey) throw new Error("Set THESYS_API_KEY in .env.local, then restart.");
  // assistant-ui sends the whole thread; the browser keeps it.
  const parsed = parseThread(await request.text());
  if ("error" in parsed) {
    console.warn(`Rejected a chat request: ${parsed.error}`, JSON.stringify(parsed.shape ?? {}));
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const messages = parsed.thread;
  const system = parsed.dashboard
    ? `${chatPrompt}\n\nOpen beside the chat now: the dashboard with artifact_id ${parsed.dashboard}.`
    : chatPrompt;

  // The chat runs on OpenUI Gateway's Chat Completions API, with the same key as the dashboards.
  const gateway = createOpenAI({ apiKey, baseURL: `${baseUrl}/v1/embed` });
  const tools = forVisitor(await dashboardTools.tools(), visitor);

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(messages, { tools });
  } catch {
    return Response.json({ error: "This thread couldn't be read." }, { status: 400 });
  }
  const result = streamText({
    model: gateway.chat(process.env.OPENUI_MODEL || "google/gemini-3.6-flash-free"),
    system,
    messages: modelMessages,
    tools,
    // Calls the dashboard tools the model asks for, then lets it reply.
    stopWhen: stepCountIs(4),
    maxOutputTokens: 6000,
    abortSignal: request.signal,
  });
  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream, tools }),
  });
}

/**
 * The tools, each running for `visitor`: the model calls them while the reply streams. Each
 * dashboard is a full generation on the API key and anyone can send messages, so one message
 * makes or changes one dashboard; a further call fails.
 */
function forVisitor(tools: ToolSet, visitor: string): ToolSet {
  let calls = 0;
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (!execute) return [name, tool];
      const wrapped: typeof execute = (input, options) => {
        if (++calls > 1) {
          throw new Error("One dashboard per message: ask the user to send the next request on its own.");
        }
        return asVisitor(visitor, () => execute(input, options));
      };
      return [name, { ...tool, execute: wrapped }];
    }),
  );
}
