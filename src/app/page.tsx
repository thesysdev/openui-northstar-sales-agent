import { HomeSentence } from "../components/home-sentence";
import { withBase } from "../lib/base-path";

// The demo's home page is one fill-in-the-blanks sentence, nothing else. The app lives at /app.

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <main className="mx-auto flex w-full flex-1 flex-col px-6">
        <HomeSentence />
      </main>
      <aside className="pointer-events-none fixed inset-x-0 bottom-5 flex justify-center px-6">
        <p className="pointer-events-auto flex items-center gap-4 rounded-lg border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-xs backdrop-blur">
          {/* Shiro, OpenUI's mascot, from the openui repo. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase("/shiro-logo.svg")} alt="Shiro, the OpenUI mascot" className="h-7 w-auto shrink-0" />
          <span className="flex flex-col gap-0.5 leading-snug">
            <span>Sales dashboards for Northstar, a fictional retailer.</span>
            <span className="flex flex-wrap items-center gap-1">
              Live on
              {/* Neon's logomark (simple-icons), in Neon green. */}
              <svg viewBox="0 0 24 24" className="size-3 shrink-0" fill="#00E599" aria-hidden>
                <path d="M24 0V24l-9.365-8.045V24H0V0ZM2.942 21.087h8.751V9.563l9.365 8.204V2.919L2.942 2.914Z" />
              </svg>
              Neon Postgres.
            </span>
          </span>
        </p>
      </aside>
    </div>
  );
}
