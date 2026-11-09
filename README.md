# Northstar Sales Agent

A sales agent for Northstar, a fictional multi-brand retailer. Describe what you want to see ("Show me net sales vs target by region for last month") and it builds a live dashboard from a Neon Postgres database: KPIs, charts and tables whose numbers load fresh from the database every time the dashboard opens. Ask for a change in the chat and the same dashboard updates in place.

Built on Next.js, [assistant-ui](https://www.assistant-ui.com) and [OpenUI](https://www.openui.com). Adapted from OpenUI's `assistant-ui-dashboards` example, with its npm/GitHub data tools replaced by SQL-backed sales tools.

## What's in it

- **Home:** a one-sentence builder, "Show me [metric] by [split] for [range]", with a chip per slot and a **Build dashboard** button.
- **Agent view:** three panes.
  - A collapsible icon rail on the left lists your recent dashboards and has **View connected data** at the bottom.
  - The open dashboard fills the centre.
  - The conversation sits on the right and can be collapsed to a **Chat** button.
- **Status notch:** a notch at the top of the dashboard shows "Fetching live data…", "Building your dashboard…", "Updating your dashboard…" and "Loading live data…". When a dashboard settles, it shows how many fewer tokens the dashboard's OpenUI Lang program took than the HTML it renders to.
- **Working state:** while the agent works and no dashboard is open yet, the centre shows a subtle WebGL backdrop of drifting "+" symbols.
- **Follow-ups:** suggested follow-up questions sit above the composer as a card stack that fans out on hover.
- **Connected data:** a full-page popup that browses the database's tables, with an overview page and paged rows.

## Requirements

- Node.js 22.13+ and npm.
- **A Thesys API key** (`THESYS_API_KEY`). It runs the chat model and the dashboard builder through OpenUI Gateway. Create one in the [Thesys Console](https://console.thesys.dev/keys), or run `npm run generate:apiKey`, which writes it to `.env.local`. The default models are paid ([credits](https://www.openui.com/docs/gateway/pricing-credits)). To avoid credits, use [BYOK](https://www.openui.com/docs/gateway/byok) or set the model variables below to a [free model](https://www.openui.com/cloud/gateway/models).
- **A Postgres database with the `retail` schema** (`DATABASE_URL`). The app reads these tables:
  - `orders`, `order_items` and `customers`
  - `products` and `product_variants`
  - `returns` and `promotions`
  - monthly sales targets

  The original runs on Neon with about 100k orders. Ask the person who shared this repo for a connection string, or point it at your own copy of the schema. Queries are parameterized and read-only, are cached for 3 minutes, and time out after 10 seconds.

## Run

```bash
npm install
cp .env.example .env.local   # then fill in THESYS_API_KEY and DATABASE_URL
npm run dev
```

Open http://localhost:3000.

Optional settings in `.env.local`:

| Variable | What it does | Default |
| --- | --- | --- |
| `OPENUI_MODEL` | Chat model, as a Gateway `provider/model` id | `anthropic/claude-sonnet-5.5` |
| `OPENUI_DASHBOARD_MODEL` | Model that builds dashboards | `anthropic/claude-sonnet-5.5` |
| `OPENUI_FOLLOWUPS_MODEL` | Model that writes follow-up suggestions | `OPENUI_MODEL` |
| `DEMO_USER_ID` | The single local user that owns dashboards | `assistant-ui-dashboards-demo` |
| `THESYS_BASE_URL` | Another OpenUI Cloud deployment | `https://api.thesys.dev` |

Try:

- "Show me net sales vs target by region for last month."
- "Top products by category for last quarter."
- "Returns by brand for last year."
- With a dashboard open: "Add a 6-month trend by region."

## How it works

```
browser (assistant-ui)               /api/chat (AI SDK)                       OpenUI Cloud
Thread ──messages──────────────────► streamText, tools from the toolkit
                                     model calls create_dashboard ─execute──► dashboards.create()
                                     ◄─ result: a sentence + the dashboard's reference ─┘
card (the tool's render) ◄─────────── streamed with the reply
  opens the panel ─► LiveArtifactRenderer streams the dashboard by its reference
                     Query() ─► /api/interpreter ─► SQL sales tools ─► Postgres (retail schema)
```

1. The chat sends the thread to `/api/chat`. That route streams a reply from OpenUI Gateway with two tools, `create_dashboard` and `edit_dashboard`.
2. `create_dashboard` runs on the server and starts generating the dashboard in OpenUI Cloud. It returns as soon as the dashboard has an id.
3. The tool's card appears in the chat and opens the dashboard in the centre pane. `LiveArtifactRenderer` then streams the dashboard as it's generated.
4. The dashboard loads its numbers with `Query()` calls. Each one goes to `/api/interpreter`, which runs the matching sales tool in `src/lib/data/sales.ts` against the database.
5. For a change, the model calls `edit_dashboard` with the dashboard's id, and the notch shows "Updating your dashboard…" until the new version is in.

OpenUI Cloud stores each dashboard's definition, not its data. Numbers reach the browser only through `/api/interpreter`, from your server. Chats are kept in the browser's `localStorage`.

## Files

| File | Purpose |
| --- | --- |
| `src/lib/data/sales.ts`, `db.ts` | SQL-backed sales tools: KPIs, trends, breakdowns, top products, returns, targets vs actuals, customers, promotions |
| `src/lib/openui.ts` | `OpenUIClient`, the dashboard definition, base URL and local user |
| `src/lib/toolkit.tsx` | `create_dashboard` and `edit_dashboard`: schema, `execute`, `render` |
| `src/lib/prompt.ts` | Chat instructions and the data dashboards can show |
| `src/app/page.tsx`, `src/components/home-sentence.tsx` | Home page and the sentence builder |
| `src/components/app.tsx` | Runtime, providers, and the three-pane layout |
| `src/components/dashboard.tsx` | Chat card, dashboard panel and status notch |
| `src/components/dashboard-sidebar.tsx` | Icon rail of recent dashboards |
| `src/components/notch.tsx`, `shader-backdrop.tsx` | Status notch and the working-state backdrop |
| `src/components/database-view.tsx` | Connected-data popup |
| `src/app/api/token-savings/route.ts` | Token count of OpenUI Lang vs rendered HTML |
| `src/app/api/followups/route.ts` | Follow-up suggestions |

`npm run generate` builds the component spec in `src/generated/` (ignored) before `dev` and `build`.

## Before deploying

The app binds to loopback, and every browser shares one local user. To put it on the internet:

- Add [authentication](https://www.openui.com/docs/gateway/authentication), and use the signed-in user's id for the frontend token and the dashboard tools.
- Add rate limits to the API routes.
- Use a read-only database role for `DATABASE_URL`.
