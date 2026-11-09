"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The status notch: a thin sky band across the top of its container with a pill hanging from
// it, joined by concave fillets so band and pill read as one shape. It slides down when shown
// and slides back up when hidden, then unmounts. Positioned absolutely; never shifts layout.

const TINT = "color-mix(in srgb, #38bdf8 16%, var(--background))";
const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";
const EXIT_MS = 300;

export function Notch({
  show,
  icon,
  label,
}: {
  show: boolean;
  icon: ReactNode;
  label: string;
}) {
  const [mounted, setMounted] = useState(show);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (show) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [show, mounted]);

  if (!mounted) return null;
  const motion = leaving
    ? "animate-out fade-out fill-mode-forwards"
    : "animate-in fade-in";

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center"
      role="status"
      style={{ "--notch": TINT } as CSSProperties}
    >
      <div className={cn("h-[3px] w-full bg-[var(--notch)] duration-300", motion)} />
      <div
        className={cn(
          "relative flex duration-300",
          EASE,
          motion,
          leaving ? "slide-out-to-top-full" : "slide-in-from-top-full",
        )}
      >
        <span
          aria-hidden
          className="absolute top-0 right-full size-2.5"
          style={{ background: "radial-gradient(circle at 0 100%, transparent 10px, var(--notch) 10.5px)" }}
        />
        <span className="inline-flex items-center gap-1.5 rounded-b-lg bg-[var(--notch)] px-3 pt-0.5 pb-1 text-xs font-medium text-[#0284c7]">
          {icon}
          <span key={label} className="animate-in fade-in duration-300">
            {label}
          </span>
        </span>
        <span
          aria-hidden
          className="absolute top-0 left-full size-2.5"
          style={{ background: "radial-gradient(circle at 100% 100%, transparent 10px, var(--notch) 10.5px)" }}
        />
      </div>
    </div>
  );
}
