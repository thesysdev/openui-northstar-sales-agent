import type { CSSProperties } from "react";
import styles from "./orb.module.css";

// A 3×3 lattice of dots that pulses outward from the centre on a round wavefront: the
// "assistant is working" glyph. Variant S1 of the Orb set, trimmed to that variant.

/** The stage the geometry is tuned on; --orb-k scales it to `size`. */
const STAGE = 28;

/** Default rendered size: a 20×20 indicator box. */
const SIZE = 20;

const N = 3; // lattice is N×N
const PITCH = 6; // centre-to-centre spacing in stage px; the dot size is CSS
const MID = (N - 1) / 2;

/**
 * Per-cell `animation-delay` in ms: distance from the centre, so the pulse radiates on a round
 * wavefront. The centre leads a beat early so the next swell doesn't sit behind the outer fade.
 */
function cellDelay(x: number, y: number): number {
  const dx = x - MID;
  const dy = y - MID;
  return Math.hypot(dx, dy) * 700 - (dx === 0 && dy === 0 ? 180 : 0);
}

const CELLS = Array.from({ length: N * N }, (_, i) => {
  const x = i % N;
  const y = Math.floor(i / N);
  return {
    key: `${x},${y}`,
    left: x * PITCH,
    top: y * PITCH,
    delay: cellDelay(x, y),
    mid: x === MID && y === MID,
  };
});

export interface OrbProps {
  /** Rendered edge length in px. The 28px geometry scales to fit. */
  size?: number;
  /** Accessible label, and the status text when `pill` is set. */
  label?: string;
  /** Wraps the orb and its label in a status pill. */
  pill?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Orb({ size = SIZE, label = "Thinking…", pill, className, style }: OrbProps) {
  return (
    <span
      className={styles.root + (className ? " " + className : "")}
      data-pill={pill ? "" : undefined}
      style={style}
    >
      <span
        className={styles.glyph}
        // In pill form the visible label carries the meaning, so the glyph steps out of the
        // accessibility tree.
        role={pill ? undefined : "img"}
        aria-label={pill ? undefined : label}
        aria-hidden={pill ? true : undefined}
        style={{ width: size, height: size, "--orb-k": size / STAGE } as CSSProperties}
      >
        <span className={styles.lattice}>
          {CELLS.map((cell) => (
            <span
              key={cell.key}
              className={styles.cell}
              data-mid={cell.mid ? "" : undefined}
              style={{ left: cell.left, top: cell.top, animationDelay: `${cell.delay}ms` }}
            />
          ))}
        </span>
      </span>
      {pill && <span className={styles.pillLabel}>{label}</span>}
    </span>
  );
}
