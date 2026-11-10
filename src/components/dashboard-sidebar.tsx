"use client";

import { cn } from "@/lib/utils";
import { ThreadListPrimitive } from "@assistant-ui/react";
import { useArtifactList } from "@openuidev/react-ui/cloud";
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  ChartLine,
  Database,
  MapPin,
  Package,
  Plus,
  SquaresFour,
  Tag,
  Target,
  Trophy,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
} from "react";
import { useOpenDashboard } from "./dashboard";
import { useOpenChatOf } from "./threads";

// The Agent view's left rail: new dashboard on top, the user's dashboards, then the data
// button. Collapsed it is a column of identical 36px squares centred in the 56px rail;
// hovering opens it as an overlay on top of the page.
//
// Geometry: the rail's content box is 40px (56 - 2×8 padding). A collapsed item is 36px wide,
// centred (2px either side), with its 24px icon slot centred inside (6px) — so the slot sits
// 16px from the rail's edge. Expanded items are full width with 8px left padding, which puts
// the slot at the same 16px, so icons never move when the rail opens.

const KINDS: { match: RegExp; icon: Icon }[] = [
  { match: /target/i, icon: Target },
  { match: /top\s.*product|best.?seller/i, icon: Trophy },
  { match: /product/i, icon: Package },
  { match: /return|refund/i, icon: ArrowCounterClockwise },
  { match: /customer/i, icon: UsersThree },
  { match: /promo/i, icon: Tag },
  { match: /region|state/i, icon: MapPin },
  { match: /sales|revenue|trend|aov|margin/i, icon: ChartLine },
];

const iconFor = (title: string): Icon =>
  KINDS.find(({ match }) => match.test(title))?.icon ?? SquaresFour;

// One gradient runs down the whole list, sky blue to bluish purple; each row samples its
// position rather than carrying a color of its own.
function railTint(index: number, count: number): string {
  const percent = count > 1 ? Math.round((index / (count - 1)) * 100) : 0;
  return `color-mix(in oklab, #38bdf8, #8b5cf6 ${percent}%)`;
}

const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

type RailItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: Icon;
  label: string;
  expanded: boolean;
  /** Action items (new dashboard, data) carry a hairline border; list items don't. */
  bordered?: boolean;
  active?: boolean;
  /** Style for the 24px icon slot: a tinted tile for dashboards, bare for actions. */
  slotStyle?: CSSProperties;
  slotClassName?: string;
};

/** Every rail item is this one shape, so sizes, radii and icon positions always match. */
const RailItem = forwardRef<HTMLButtonElement, RailItemProps>(function RailItem(
  {
    icon: ItemIcon,
    label,
    expanded,
    bordered,
    active,
    slotStyle,
    slotClassName,
    className,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-current={active || undefined}
      className={cn(
        "flex h-9 shrink-0 items-center overflow-hidden rounded-lg border text-left text-sm transition-colors duration-150 hover:bg-foreground/[0.03]",
        expanded ? "w-full gap-2.5 px-[7px]" : "mx-auto w-9 justify-center gap-0 px-0",
        bordered || active ? "border-border" : "border-transparent",
        className,
      )}
      {...props}
    >
      <span
        className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", slotClassName)}
        style={slotStyle}
      >
        <ItemIcon className="size-3.5" />
      </span>
      <span
        className={cn(
          "truncate whitespace-nowrap transition-opacity duration-200",
          expanded ? "min-w-0 flex-1 opacity-100" : "w-0 flex-none opacity-0",
        )}
      >
        {label}
      </span>
    </button>
  );
});

/**
 * A list's dashboards as of its last finished load. The lists refresh whenever a dashboard
 * finishes streaming, which includes opening one, and while one reloads it shows every cached
 * dashboard in the cache's order, so the rail would shuffle and settle back.
 */
function useSettled<T>({ artifacts, isLoading }: { artifacts: T[]; isLoading: boolean }): T[] {
  const settled = useRef<T[]>([]);
  if (!isLoading) settled.current = artifacts;
  return settled.current;
}

export function DashboardSidebar({
  onShowData,
  collapsed,
}: {
  onShowData: () => void;
  collapsed: boolean;
}) {
  // Hover opens the collapsed rail as an overlay on top of the page.
  const [hovered, setHovered] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const inFlow = !collapsed;
  const expanded = inFlow || hovered;

  const pinnedList = useArtifactList({ filter: { type: "dashboard", pinned: true } });
  const recent = useArtifactList({ filter: { type: "dashboard", pinned: false, limit: 20 } });
  const { open, setOpen, openId, saved } = useOpenDashboard();
  const openChatOf = useOpenChatOf();

  // A dashboard joins the list once it's generated and saved.
  const refreshPinned = pinnedList.refresh;
  const refreshRecent = recent.refresh;
  useEffect(() => {
    if (saved === 0) return;
    refreshPinned();
    refreshRecent();
  }, [saved, refreshPinned, refreshRecent]);

  const allRows = [...useSettled(pinnedList), ...useSettled(recent)];
  const rows = showAll ? allRows : allRows.slice(0, 5);
  const olderCount = allRows.length - 5;

  return (
    <div
      className={cn(
        "relative h-full shrink-0 transition-[width] duration-300",
        EASE,
        inFlow ? "w-60" : "w-14",
      )}
      onMouseEnter={() => {
        if (inFlow) return;
        if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
        hoverTimer.current = window.setTimeout(() => setHovered(true), 150);
      }}
      onMouseLeave={() => {
        if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
        setHovered(false);
      }}
    >
      <nav
        className={cn(
          "absolute inset-y-0 left-0 z-40 flex flex-col gap-2 overflow-x-hidden overflow-y-auto border-r bg-background p-2 transition-[width,box-shadow] duration-300",
          EASE,
          expanded ? "w-60" : "w-14",
          !inFlow && hovered && "shadow-lg",
        )}
      >
        <ThreadListPrimitive.New asChild>
          <RailItem
            icon={Plus}
            label="New dashboard"
            expanded={expanded}
            bordered
            slotClassName="text-muted-foreground"
            onClick={() => setOpen(null)}
          />
        </ThreadListPrimitive.New>

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {rows.map((artifact, index) => {
            const color = railTint(index, rows.length);
            const active = open !== null && openId === artifact.id;
            return (
              <RailItem
                key={artifact.id}
                icon={iconFor(artifact.title ?? "")}
                label={artifact.title || "Untitled dashboard"}
                expanded={expanded}
                active={active}
                slotStyle={{
                  background: `color-mix(in srgb, ${color} 14%, var(--background))`,
                  color,
                }}
                onClick={() => {
                  if (active) return;
                  setOpen({ key: `side:${artifact.id}`, id: artifact.id });
                  openChatOf(artifact.id);
                }}
              />
            );
          })}
          {olderCount > 0 && (
            <RailItem
              icon={showAll ? CaretUp : CaretDown}
              label={showAll ? "Hide older" : `Show older (${olderCount})`}
              expanded={expanded}
              className="text-muted-foreground hover:text-foreground"
              slotClassName="text-muted-foreground"
              onClick={() => setShowAll((value) => !value)}
            />
          )}
          {rows.length === 0 && expanded && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center animate-in fade-in duration-200">
              <span className="flex size-8 items-center justify-center rounded-lg border bg-background shadow-xs">
                <SquaresFour className="size-4 text-muted-foreground" />
              </span>
              <p className="text-xs text-muted-foreground">
                {recent.isLoading ? "Loading…" : "Dashboards you create show up here."}
              </p>
            </div>
          )}
        </div>

        <RailItem
          icon={Database}
          label="View connected data"
          expanded={expanded}
          bordered
          className="text-muted-foreground hover:text-foreground"
          onClick={onShowData}
        />
      </nav>
    </div>
  );
}
