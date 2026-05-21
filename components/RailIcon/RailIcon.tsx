"use client";

import { useId } from "react";
import styles from "./RailIcon.module.css";

/**
 * CommandCenter rail icons — premium duotone/gradient set.
 *
 * Each icon is a rounded-square tile (gradient fill + top-light gloss + soft
 * drop shadow) with layered duotone artwork on top, in the 2026 "soft 3D /
 * multi-material" style. Inline SVG only — no images, no icon library.
 *
 * Why "use client": the SVG gradients/filters need IDs, and two icons on one
 * page would collide on a shared ID. `useId()` namespaces every def per
 * instance, so any number of icons coexist safely. It ships a trivially small
 * amount of client JS (just the render); there is no interactivity logic.
 * Motion (idle loop, hover, click) is pure CSS in RailIcon.module.css.
 *
 * Tokens: the tile gradients use the CommandCenter lavender/coral hexes baked
 * in (a tile is a filled object, not a `currentColor` stroke). To restyle,
 * edit the GRADIENTS below.
 */

export const RAIL_ICON_NAMES = [
  "insights",
  "workforce",
  "inventory",
  "bookkeeping",
  "alerts",
  "ask",
  "settings",
  "chat",
] as const;

export type RailIconName = (typeof RAIL_ICON_NAMES)[number];

export interface RailIconProps {
  name: RailIconName;
  /** px size. Rail ~42, floating bubble ~46, header button ~18. Default 42. */
  size?: number;
  /** Accessible label. Omit for decorative icons (aria-hidden). */
  label?: string;
  /** Disable the idle loop (keeps hover/click). */
  still?: boolean;
  className?: string;
}

// fill palettes — alerts gets the coral tile, everything else lavender
const TILE_GRAD: Record<RailIconName, "lav" | "coral"> = {
  insights: "lav",
  workforce: "lav",
  inventory: "lav",
  bookkeeping: "lav",
  alerts: "coral",
  ask: "lav",
  settings: "lav",
  chat: "lav",
};

// duotone artwork fills
const W = "#ffffff";

export function RailIcon({
  name,
  size = 42,
  label,
  still = false,
  className,
}: RailIconProps) {
  // unique, stable IDs per instance so gradient/filter defs never collide
  const uid = useId().replace(/:/g, "");
  const id = (k: string) => `${k}-${uid}`;
  const url = (k: string) => `url(#${id(k)})`;

  const WSOFT = url("glyphHi");
  const DEEP = "rgba(58,46,110,.42)";
  const tileFill = TILE_GRAD[name] === "coral" ? url("tileCoral") : url("tileLav");

  const cls = [styles.icon, styles[name], still ? styles.still : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      viewBox="0 0 60 60"
      width={size}
      height={size}
      className={cls}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={id("tileLav")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b6a9ee" />
          <stop offset="100%" stopColor="#7d6cc9" />
        </linearGradient>
        <linearGradient id={id("tileCoral")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d08a5a" />
          <stop offset="100%" stopColor="#b3602f" />
        </linearGradient>
        <linearGradient id={id("glyphHi")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#ece6fb" />
        </linearGradient>
        <linearGradient id={id("goldGrad")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0e3c4" />
          <stop offset="100%" stopColor="#d9bd86" />
        </linearGradient>
        <radialGradient id={id("topLight")} cx="50%" cy="22%" r="75%">
          <stop offset="0%" stopColor="rgba(255,255,255,.55)" />
          <stop offset="55%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        <filter id={id("softShadow")} x="-40%" y="-30%" width="180%" height="190%">
          <feDropShadow dx="0" dy="3" stdDeviation="3.2" floodColor="#7d6cc9" floodOpacity="0.34" />
        </filter>
      </defs>

      {/* tile container */}
      <g className={styles.tilebox} filter={url("softShadow")}>
        <rect x="6" y="6" width="48" height="48" rx="15" fill={tileFill} />
        <rect x="6" y="6" width="48" height="48" rx="15" fill={url("topLight")} />
        <rect x="6.6" y="6.6" width="46.8" height="46.8" rx="14.4" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
      </g>

      {glyph(name, { W, WSOFT, DEEP, gold: url("goldGrad"), tileLav: url("tileLav") })}
    </svg>
  );
}

interface Fills {
  W: string;
  WSOFT: string;
  DEEP: string;
  gold: string;
  tileLav: string;
}

function glyph(name: RailIconName, f: Fills) {
  const s = styles;
  switch (name) {
    case "insights":
      return (
        <g className={s.insights}>
          <polyline className={s.ln} points="18,40 26,31 33,35 43,22" fill="none" stroke={f.W} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="18" cy="40" r="2.4" fill={f.W} />
          <circle cx="26" cy="31" r="2.4" fill={f.W} />
          <circle cx="33" cy="35" r="2.4" fill={f.W} />
          <path className={`${s.spark} ${s.gA}`} d="M43 16 C44 21 44.5 21.5 49.5 22.5 C44.5 23.5 44 24 43 29 C42 24 41.5 23.5 36.5 22.5 C41.5 21.5 42 21 43 16 Z" fill={f.WSOFT} />
        </g>
      );
    case "workforce":
      return (
        <g className={s.workforce}>
          <circle className={s.p2} cx="38" cy="25" r="6.2" fill={f.WSOFT} opacity=".85" />
          <path className={s.p2} d="M27 44 a11 11 0 0 1 22 0 Z" fill={f.WSOFT} opacity=".85" />
          <circle cx="24" cy="23" r="7.4" fill={f.W} />
          <path d="M11 46 a13 13 0 0 1 26 0 Z" fill={f.W} />
        </g>
      );
    case "inventory":
      return (
        <g className={s.inventory}>
          <path d="M16 26 L30 33 L44 26 L30 19 Z" fill={f.DEEP} />
          <path d="M16 26 L16 40 L30 47 L30 33 Z" fill={f.W} />
          <path d="M44 26 L44 40 L30 47 L30 33 Z" fill={f.WSOFT} />
          <path className={s.lid} d="M16 26 L30 33 L44 26 L30 19 Z" fill={f.W} />
          <path className={`${s.glow} ${s.gA}`} d="M30 21 C30.7 24 31 24.3 34 25 C31 25.7 30.7 26 30 29 C29.3 26 29 25.7 26 25 C29 24.3 29.3 24 30 21 Z" fill={f.DEEP} />
        </g>
      );
    case "bookkeeping":
      return (
        <g className={s.bookkeeping}>
          <g className={`${s.coin} ${s.gA}`}>
            <circle cx="30" cy="30" r="13" fill={f.WSOFT} />
            <circle cx="30" cy="30" r="13" fill="none" stroke={f.DEEP} strokeWidth="1.6" />
            <path d="M30 22 C31 27 31.5 27.5 37 28.5 C31.5 29.5 31 30 30 35 C29 30 28.5 29.5 23 28.5 C28.5 27.5 29 27 30 22 Z" fill={f.gold} />
          </g>
        </g>
      );
    case "alerts":
      return (
        <g className={s.alerts}>
          <circle className={s.ping} cx="30" cy="30" r="13" fill="rgba(255,255,255,.4)" />
          <g className={s.body}>
            <path d="M30 17 C31.4 25 32 25.6 40 27 C32 28.4 31.4 29 30 37 C28.6 29 28 28.4 20 27 C28 25.6 28.6 25 30 17 Z" fill={f.W} />
            <circle cx="30" cy="40.5" r="2.2" fill={f.W} />
          </g>
        </g>
      );
    case "ask":
      return (
        <g className={s.ask}>
          <path className={s.big} d="M30 15 C31.6 26 32.4 26.8 43 28 C32.4 29.2 31.6 30 30 41 C28.4 30 27.6 29.2 17 28 C27.6 26.8 28.4 26 30 15 Z" fill={f.W} />
          <path className={`${s.o1} ${s.gA}`} d="M42 36 C42.5 39 42.7 39.2 46 39.7 C42.7 40.2 42.5 40.4 42 43.5 C41.5 40.4 41.3 40.2 38 39.7 C41.3 39.2 41.5 39 42 36 Z" fill={f.WSOFT} />
          <path className={`${s.o2} ${s.gA}`} d="M19 17 C19.4 19.4 19.5 19.5 22 20 C19.5 20.5 19.4 20.6 19 23 C18.6 20.6 18.5 20.5 16 20 C18.5 19.5 18.6 19.4 19 17 Z" fill={f.WSOFT} />
        </g>
      );
    case "settings":
      return (
        <g className={s.settings}>
          <g className={`${s.gear} ${s.gA}`}>
            <path d="M25.59 18.52 L27.04 14.78 L32.96 14.78 L34.41 18.52 L35.0 18.76 L38.67 17.15 L42.85 21.33 L41.24 25.0 L41.48 25.59 L45.22 27.04 L45.22 32.96 L41.48 34.41 L41.24 35.0 L42.85 38.67 L38.67 42.85 L35.0 41.24 L34.41 41.48 L32.96 45.22 L27.04 45.22 L25.59 41.48 L25.0 41.24 L21.33 42.85 L17.15 38.67 L18.76 35.0 L18.52 34.41 L14.78 32.96 L14.78 27.04 L18.52 25.59 L18.76 25.0 L17.15 21.33 L21.33 17.15 L25.0 18.76 Z" fill={f.W} />
            <circle cx="30" cy="30" r="5.6" fill={f.DEEP} />
            <circle cx="30" cy="30" r="3.4" fill={f.W} />
          </g>
        </g>
      );
    case "chat":
      return (
        <g className={s.chat}>
          <path className={s.body} d="M15 22 a6 6 0 0 1 6 -6 H39 a6 6 0 0 1 6 6 V34 a6 6 0 0 1 -6 6 H26 L18 47 V40 a6 6 0 0 1 -3 -5 Z" fill={f.W} />
          <circle className={s.d1} cx="23" cy="29" r="2.4" fill={f.tileLav} />
          <circle className={s.d2} cx="30" cy="29" r="2.4" fill={f.tileLav} />
          <circle className={s.d3} cx="37" cy="29" r="2.4" fill={f.tileLav} />
        </g>
      );
  }
}

export default RailIcon;
