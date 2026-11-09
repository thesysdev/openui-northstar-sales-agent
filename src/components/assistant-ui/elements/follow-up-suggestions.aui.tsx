"use client";

import { AuiIf, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import {
  ArrowCounterClockwise,
  ArrowRight,
  ChartBar,
  MapPin,
  Megaphone,
  Package,
  Storefront,
  Tag,
  Target,
  TrendUp,
  Trophy,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import { useRef, useState, type CSSProperties, type FC } from "react";

// Each follow-up gets the icon of what it's about, matching the home page's chips where they
// overlap. First match wins, so the more specific words come first.
const TOPIC_ICONS: [RegExp, Icon][] = [
  [/\b(return|refund)/i, ArrowCounterClockwise],
  [/\b(target|goal|attainment|quota)/i, Target],
  [/\b(trend|over time|month|week|daily|growth|forecast)/i, TrendUp],
  [/\b(region|state|city|location|west|south|midwest|northeast)/i, MapPin],
  [/\b(channel|online|store vs|marketing|campaign)/i, Megaphone],
  [/\bbrand/i, Storefront],
  [/\b(customer|shopper|buyer|segment|cohort)/i, UsersThree],
  [/\b(discount|promo|price|margin)/i, Tag],
  [/\b(top|best|rank|leader)/i, Trophy],
  [/\b(category|categories|product|sku|item)/i, Package],
];

function topicIcon(text: string): Icon {
  return TOPIC_ICONS.find(([pattern]) => pattern.test(text))?.[1] ?? ChartBar;
}

// Follow-up suggestions as a card stack above the composer: at rest the next question sits
// on top with the others peeking out behind it; hovering fans them out upward. A white fade
// sits underneath so chat text scrolling behind never shows through.

const ROW = 36;
const GAP = 6;
const PEEK = 7;

const FollowupStack: FC = () => {
  const suggestions = useAuiState((state) => state.thread.suggestions);
  const [open, setOpen] = useState(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const items = suggestions.slice(0, 3);
  const count = items.length;
  const restHeight = ROW + (count - 1) * PEEK;
  const openHeight = count * (ROW + GAP) - GAP;

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        if (closeTimer.current) window.clearTimeout(closeTimer.current);
        if (openTimer.current) window.clearTimeout(openTimer.current);
        openTimer.current = window.setTimeout(() => setOpen(true), 120);
      }}
      onMouseLeave={() => {
        if (openTimer.current) window.clearTimeout(openTimer.current);
        if (closeTimer.current) window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => setOpen(false), 150);
      }}
    >
      {/* White fade behind and above the stack, so text behind stays out of the way. */}
      <div className="pointer-events-none absolute inset-x-0 -top-8 bottom-0 bg-gradient-to-t from-background via-background/90 to-transparent" />
      <div
        className="relative transition-[height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
        style={{ height: count ? (open ? openHeight : restHeight) : 0 }}
      >
        {items.map((suggestion, index) => {
          // index 0 is the front card; the rest sit behind, peeking upward.
          const lift = open ? index * (ROW + GAP) : index * PEEK;
          const scale = open ? 1 : 1 - index * 0.04;
          const text = suggestion.title ?? suggestion.prompt;
          const TopicIcon = topicIcon(text);
          return (
            <ThreadPrimitive.Suggestion
              key={suggestion.prompt}
              prompt={suggestion.prompt}
              send
              className="group absolute inset-x-0 bottom-0 flex h-9 items-center gap-2 overflow-hidden rounded-lg border bg-background px-3 text-sm whitespace-nowrap transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-foreground/25"
              style={
                {
                  transform: `translateY(-${lift}px) scale(${scale})`,
                  transformOrigin: "bottom center",
                  zIndex: count - index,
                  transitionDelay: `${index * 25}ms`,
                } as CSSProperties
              }
            >
              <TopicIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">{text}</span>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0.5 group-hover:opacity-100" />
            </ThreadPrimitive.Suggestion>
          );
        })}
      </div>
    </div>
  );
};

export const ThreadFollowupSuggestions: FC = () => (
  <AuiIf
    condition={(s) => !s.thread.isEmpty && !s.thread.isRunning && s.thread.suggestions.length > 0}
  >
    <FollowupStack />
  </AuiIf>
);
