import { createOpenAI } from "@ai-sdk/openai";
import { AISDKToolkit } from "@assistant-ui/ai-sdk";
import { convertToModelMessages, stepCountIs, streamText, type ToolSet, type UIMessage } from "ai";
import type { NextRequest } from "next/server";
import { baseUrl } from "../../../lib/openui";
import { chatPrompt } from "../../../lib/prompt";
import toolkit from "../../../lib/toolkit";
import { asVisitor, noVisitor, readVisitorId } from "../../../lib/visitor";

export const runtime = "nodejs";

// The toolkit's server build: create_dashboard and edit_dashboard, with their `execute`.
const dashboardTools = new AISDKToolkit({ toolkit });

export async function POST(request: NextRequest) {
  const visitor = readVisitorId(request);
  if (!visitor) return noVisitor();
  // assistant-ui sends the whole thread; the browser keeps it.
  const { messages } = (await request.json()) as { messages: UIMessage[] };
  const apiKey = process.env.THESYS_API_KEY;
  if (!apiKey) throw new Error("Set THESYS_API_KEY in .env.local, then restart.");

  // The chat runs on OpenUI Gateway's Chat Completions API, with the same key as the dashboards.
  const gateway = createOpenAI({ apiKey, baseURL: `${baseUrl}/v1/embed` });
  const tools = forVisitor(await dashboardTools.tools(), visitor);

  const result = streamText({
    model: gateway.chat(process.env.OPENUI_MODEL || "anthropic/claude-sonnet-5.5"),
    system: chatPrompt,
    messages: await convertToModelMessages(messages, { tools }),
    tools,
    // Calls the dashboard tools the model asks for, then lets it reply.
    stopWhen: stepCountIs(4),
    abortSignal: request.signal,
  });
  return result.toUIMessageStreamResponse();
}

/** The tools, each running for `visitor`: the model calls them while the reply streams. */
function forVisitor(tools: ToolSet, visitor: string): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (!execute) return [name, tool];
      const wrapped: typeof execute = (input, options) => asVisitor(visitor, () => execute(input, options));
      return [name, { ...tool, execute: wrapped }];
    }),
  );
}
