import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { baseUrl } from "../../../lib/openui";

export const runtime = "nodejs";

const system = `You suggest the next questions for a sales analytics chat. Northstar is a multi-brand apparel, footwear and accessories retailer; the assistant builds live dashboards from its sales database: net sales, trends, breakdowns by region, state, category, subcategory, brand, channel and device, top products, returns, targets vs actuals, new vs returning customers, and promotions. Data runs from November 2024 to today, in USD.

Given the conversation, reply with ONLY a JSON array of 3 very short follow-up requests the user would plausibly send next. Build on the latest dashboard (drill down, compare, add a view, change the range) or pivot to a related question. Each 3 to 6 words, like a button label ("Split by region", "Add margin trend"), no numbers, no trailing punctuation.`;

/** 3 follow-up prompts for the conversation so far, from a small gateway call. */
export async function POST(request: Request) {
  const { transcript } = (await request.json()) as { transcript?: string };
  const apiKey = process.env.THESYS_API_KEY;
  if (!apiKey || !transcript?.trim()) return Response.json({ suggestions: [] });

  const gateway = createOpenAI({ apiKey, baseURL: `${baseUrl}/v1/embed` });
  try {
    const { text } = await generateText({
      model: gateway.chat(
        process.env.OPENUI_FOLLOWUPS_MODEL ||
          process.env.OPENUI_MODEL ||
          "anthropic/claude-sonnet-5.5",
      ),
      system,
      prompt: transcript.slice(-4000),
      abortSignal: request.signal,
    });
    const parsed: unknown = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    const suggestions = (Array.isArray(parsed) ? parsed : [])
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 3);
    return Response.json({ suggestions });
  } catch {
    // Follow-ups are a nicety; never surface their failures in the chat.
    return Response.json({ suggestions: [] });
  }
}
