"use client";

import { cn } from "@/lib/utils";
import {
  ArrowCounterClockwise,
  ArrowRight,
  ArrowUUpLeft,
  Calendar,
  Clock,
  Infinity as InfinityIcon,
  MapPin,
  Megaphone,
  Package,
  Storefront,
  Tag,
  Target,
  Trophy,
  UsersThree,
  Watch,
  type Icon,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

// The home page is one sentence. Each blank is a chip; hovering it fans the other options out
// above and below in the same style, and "Build dashboard" sends the finished sentence to the
// agent at /app.

type Option = { label: string; icon: Icon };
type SlotName = "metric" | "split" | "range";

const SLOTS: Record<SlotName, Option[]> = {
  metric: [
    { label: "net sales vs target", icon: Target },
    { label: "top products", icon: Trophy },
    { label: "returns", icon: ArrowCounterClockwise },
    { label: "customers", icon: UsersThree },
    { label: "promotions", icon: Tag },
  ],
  split: [
    { label: "category", icon: Package },
    { label: "region", icon: MapPin },
    { label: "brand", icon: Storefront },
    { label: "channel", icon: Megaphone },
  ],
  range: [
    { label: "last month", icon: Clock },
    { label: "last quarter", icon: Watch },
    { label: "last year", icon: Calendar },
    { label: "lifetime", icon: InfinityIcon },
  ],
};

// Region stays the default split even though it sits second in the fan.
const DEFAULTS: Record<SlotName, number> = { metric: 0, split: 1, range: 0 };

// Splits a metric's data doesn't have: targets are set for the whole business, each region and
// each category, never per brand or channel.
const UNAVAILABLE_SPLITS: Record<string, string[]> = {
  "net sales vs target": ["brand", "channel"],
};

/** Whether `index` can be picked in `slot` alongside the rest of `picked`. */
function available(slot: SlotName, index: number, picked: Record<SlotName, number>): boolean {
  if (slot !== "split") return true;
  const metric = SLOTS.metric[picked.metric]!.label;
  return !UNAVAILABLE_SPLITS[metric]?.includes(SLOTS.split[index]!.label);
}

// Each slot's fan is tinted along one gradient from its top row to its bottom row, so it
// always reads the same way whatever is selected; the selected chip carries the centre
// color. Chips mix the tint into the page background, so they stay opaque.
const GRADIENTS: Record<SlotName, [string, string]> = {
  metric: ["#38bdf8", "#a855f7"],
  split: ["#f59e0b", "#f43f5e"],
  range: ["#22c55e", "#3b82f6"],
};

function tintAt(slot: SlotName, row: number, rows: number): string {
  const [from, to] = GRADIENTS[slot];
  const percent = rows > 1 ? Math.round((row / (rows - 1)) * 100) : 0;
  return `color-mix(in oklab, ${from}, ${to} ${percent}%)`;
}

const CHIP_TINT =
  "bg-[color-mix(in_srgb,var(--tint)_14%,var(--background))] hover:bg-[color-mix(in_srgb,var(--tint)_24%,var(--background))]";

/**
 * Animates its width to fit new content, so a chip grows and shrinks smoothly when the
 * selection changes instead of snapping.
 */
function AnimatedSize({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    const target = content.offsetWidth;
    const current = box.offsetWidth;
    box.style.width = `${current}px`;
    if (Math.abs(target - current) < 1) {
      box.style.width = `${target}px`;
      return;
    }
    box.getBoundingClientRect(); // flush, so the transition starts from the old width
    box.style.transition = "width 300ms cubic-bezier(0.32, 0.72, 0, 1)";
    box.style.width = `${target}px`;
    const settle = () => {
      box.style.transition = "";
    };
    box.addEventListener("transitionend", settle, { once: true });
    return () => box.removeEventListener("transitionend", settle);
  });
  return (
    <span ref={outer} className="inline-block overflow-hidden whitespace-nowrap align-baseline">
      <span ref={inner} className="inline-block">
        {children}
      </span>
    </span>
  );
}

type FanItem = Option & { index: number; offset: number; ty: string; tint: string; delay: string };

export function HomeSentence({
  compact = false,
  onBuild,
  className,
}: {
  /** Stacked variant, for inside the app. */
  compact?: boolean;
  /** Where the finished sentence goes; the default navigates to /app. */
  onBuild?: (prompt: string) => void;
  /** Extra classes for the compact variant's root (e.g. a larger text size). */
  className?: string;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState(DEFAULTS);
  const [open, setOpen] = useState<SlotName | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const label = (slot: SlotName) => SLOTS[slot][picked[slot]]!.label;
  const prompt = `Show me ${label("metric")} by ${label("split")} for ${label("range")}`;

  // Hover opens after a beat (casual passes don't fire it) and closes with a short grace,
  // so moving the pointer between options never snaps the fan shut.
  const enter = (slot: SlotName) => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    if (openTimer.current) window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => setOpen(slot), open ? 0 : 150);
  };
  const leave = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(null), 120);
  };

  const chip = (slot: SlotName) => {
    const current = picked[slot];
    const { label: text, icon: ChipIcon } = SLOTS[slot][current]!;
    // The selected option stays in place; the others split evenly, half above, half below.
    const others = SLOTS[slot]
      .map((option, index) => ({ ...option, index }))
      .filter((option) => option.index !== current && available(slot, option.index, picked));
    const above = Math.ceil(others.length / 2);
    const items: FanItem[] = others.map((option, position) => {
      const offset = position < above ? position - above : position - above + 1;
      return {
        ...option,
        offset,
        ty: `${offset * 112}%`,
        tint: tintAt(slot, offset + above, SLOTS[slot].length),
        delay: `${Math.abs(offset) * 25}ms`,
      };
    });
    return (
      <span
        className="relative mx-[0.15em] inline-flex align-baseline max-sm:mx-0 max-sm:w-full"
        onMouseEnter={() => enter(slot)}
        onMouseLeave={leave}
      >
        <button
          type="button"
          onClick={() => setOpen(open === slot ? null : slot)}
          aria-expanded={open === slot}
          style={
            { "--tint": tintAt(slot, above, SLOTS[slot].length) } as CSSProperties
          }
          className={cn(
            "inline-flex items-center gap-[0.4em] rounded-[0.5em] border border-transparent px-[0.5em] py-[0.15em] whitespace-nowrap text-foreground transition-colors duration-150 max-sm:w-full",
            // While another slot's fan is open, this chip steps back to neutral.
            open !== null && open !== slot ? "bg-foreground/[0.03]" : CHIP_TINT,
            open === slot && "bg-[color-mix(in_srgb,var(--tint)_24%,var(--background))]",
          )}
        >
          <ChipIcon
            key={text}
            className={cn(
              "icon-anim size-[0.85em] shrink-0 transition-colors duration-150 animate-in fade-in duration-200",
              open !== null && open !== slot ? "text-muted-foreground" : "text-[var(--tint)]",
            )}
          />
          <AnimatedSize>
            <span key={text} className="inline-block animate-in fade-in duration-200">
              {slot === "range" ? `${text}.` : text}
            </span>
          </AnimatedSize>
        </button>
        {open === slot && (
          <>
            {/* Transparent bridge over the whole fan, so the gaps between options stay hoverable. */}
            <span
              aria-hidden
              className="absolute z-10 block"
              style={{
                top: `-${above * 112}%`,
                bottom: `-${(others.length - above) * 112}%`,
                left: "-0.5em",
                right: "-0.5em",
              }}
            />
            {items.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => {
                  setPicked((previous) => {
                    const next = { ...previous, [slot]: option.index };
                    // A metric without the picked split falls back to the default one.
                    if (!available("split", next.split, next)) next.split = DEFAULTS.split;
                    return next;
                  });
                  setOpen(null);
                }}
                style={
                  {
                    "--ty": option.ty,
                    "--tint": option.tint,
                    transitionDelay: option.delay,
                  } as CSSProperties
                }
                className={cn(
                  "picker-item absolute top-0 left-0 z-20 inline-flex h-full w-max min-w-full items-center gap-[0.4em] rounded-[0.5em] border border-transparent px-[0.5em] whitespace-nowrap text-foreground",
                  CHIP_TINT,
                )}
              >
                <option.icon className="icon-anim size-[0.85em] shrink-0 text-[var(--tint)]" />
                {option.label}
              </button>
            ))}
          </>
        )}
      </span>
    );
  };

  const build = () => {
    if (onBuild) onBuild(prompt);
    else router.push(`/app?ask=${encodeURIComponent(prompt)}`);
  };

  const buttons = (
    <>
      <button
        type="button"
        onClick={build}
        className="group inline-flex items-center gap-[0.3em] rounded-[0.5em] bg-primary px-[0.5em] py-[0.15em] whitespace-nowrap text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
      >
        Build dashboard
        <ArrowRight
          className="size-[0.75em] transition-transform duration-150 group-hover:translate-x-[0.12em] motion-reduce:transition-none"
          strokeWidth={2}
        />
      </button>
      <button
        type="button"
        onClick={() => {
          setPicked(DEFAULTS);
          setOpen(null);
        }}
        aria-label="Start over"
        title="Start over"
        className="group ml-[0.35em] inline-flex items-center rounded-[0.5em] px-[0.3em] py-[0.32em] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.03] hover:text-foreground"
      >
        <ArrowUUpLeft
          className="size-[0.75em] transition-transform duration-300 group-hover:-translate-x-[0.1em] motion-reduce:transition-none"
          strokeWidth={1.75}
        />
      </button>
    </>
  );

  // The compact variant lives in the chat's empty state: the same sentence, stacked.
  if (compact) {
    return (
      <div
        className={cn(
          "flex w-full flex-col items-start gap-3 text-xl leading-relaxed font-medium tracking-tight",
          className,
        )}
      >
        <span className="flex flex-wrap items-center gap-[0.35em]">Show me {chip("metric")}</span>
        <span className="flex flex-wrap items-center gap-[0.35em]">by {chip("split")}</span>
        <span className="flex flex-wrap items-center gap-[0.35em]">for {chip("range")}</span>
        <span className="mt-1 inline-flex items-center gap-[0.25em]">{buttons}</span>
      </div>
    );
  }

  return (
    <section className="relative flex min-h-0 flex-1 flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/4 left-1/2 size-80 -translate-x-1/2 rounded-full bg-foreground/[0.04] blur-3xl"
      />
      <div className="flex flex-1 items-center justify-center">
        <h1 className="text-[clamp(1.25rem,1.9vw,2rem)] leading-relaxed font-medium tracking-tight max-sm:flex max-sm:w-full max-sm:flex-col max-sm:items-stretch max-sm:gap-3 sm:whitespace-nowrap">
          {/* Each segment is a row on phones and dissolves into the one-line sentence on sm+. */}
          <span className="max-sm:flex max-sm:w-full max-sm:flex-col max-sm:items-stretch max-sm:gap-2 sm:contents">
            Show me {chip("metric")}
          </span>{" "}
          <span className="max-sm:flex max-sm:w-full max-sm:flex-col max-sm:items-stretch max-sm:gap-2 sm:contents">
            by {chip("split")}
          </span>{" "}
          <span className="max-sm:flex max-sm:w-full max-sm:flex-col max-sm:items-stretch max-sm:gap-2 sm:contents">
            for {chip("range")}
          </span>
          <span className="ml-[1em] inline-flex items-center gap-[0.25em] align-baseline max-sm:mt-2 max-sm:ml-0 max-sm:self-start">
            {buttons}
          </span>
        </h1>
      </div>
    </section>
  );
}
