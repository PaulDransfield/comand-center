import styles from "./RailIcon.module.css";

/**
 * CommandCenter sidebar rail icons + floating Ask CC bubble.
 *
 * Pure inline SVG + CSS. Server-renderable, no client JS, no icon library.
 * Strokes use `currentColor` so each icon adopts its rail item's text color
 * (set the active item to `color: var(--lav-deep)` and the glyph follows).
 * Filled accents read brand tokens with CommandCenter hex fallbacks baked in.
 *
 * Motion: a gentle always-on idle loop, a fuller "action" on hover (driven by
 * the nearest button / a / [data-icon-trigger], so the whole rail row reacts),
 * and a scale pop on click. Respects prefers-reduced-motion.
 */

export const RAIL_ICON_NAMES = [
  "darkmode", // crescent — theme toggle (top of rail)
  "insights", // dashboard / overview
  "workforce", // staff + scheduling
  "inventory", // inventory setup
  "bookkeeping", // ledger / receipt
  "alerts", // warning triangle
  "ask", // ✦ Ask CC (rail)
  "settings", // gear
  "chat", // floating Ask CC bubble (bottom-right)
] as const;

export type RailIconName = (typeof RAIL_ICON_NAMES)[number];

export interface RailIconProps extends React.SVGProps<SVGSVGElement> {
  name: RailIconName;
  /** px size for width & height. Default 22 (rail) — bump for the bubble. */
  size?: number;
  /** Disable the idle loop (keeps hover/click). Default false. */
  still?: boolean;
}

const v = {
  lav: "var(--lav, #a99ce6)",
  lavDeep: "var(--lav-deep, #7d6cc9)",
  lavFill: "var(--lav-fill, #ece8f8)",
  coral: "var(--coral, #c0703a)",
  amber: "var(--amber, #b0883c)",
  white: "var(--card, #fff)",
} as const;

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function RailIcon({
  name,
  size = 22,
  still = false,
  className,
  ...rest
}: RailIconProps) {
  const cls = [styles.icon, styles[name], still ? styles.still : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cls}
      aria-hidden={rest["aria-label"] ? undefined : true}
      role={rest["aria-label"] ? "img" : undefined}
      {...stroke}
      {...rest}
    >
      {glyph(name)}
    </svg>
  );
}

function glyph(name: RailIconName) {
  switch (name) {
    // crescent moon — theme toggle. Idle: faint breathing star; hover: moon dips.
    case "darkmode":
      return (
        <>
          <path
            className={styles.moon}
            d="M20 14.5 A8.5 8.5 0 1 1 10.2 4.2 A6.6 6.6 0 0 0 20 14.5 Z"
            fill={v.lavFill}
            stroke={v.lavDeep}
          />
          <circle className={`${styles.mstar} ${styles.ms1}`} cx="17.5" cy="6" r="0.9" fill={v.lavDeep} stroke="none" />
          <circle className={`${styles.mstar} ${styles.ms2}`} cx="20" cy="9.5" r="0.7" fill={v.lavDeep} stroke="none" />
        </>
      );

    // insights — dashboard grid; tiles settle in on hover, faint breathe on idle
    case "insights":
      return (
        <>
          <rect className={styles.t1} x="3.5" y="3.5" width="7.2" height="7.2" rx="1.8" fill={v.lavFill} stroke={v.lavDeep} />
          <rect className={styles.t2} x="13.3" y="3.5" width="7.2" height="4.4" rx="1.6" fill={v.white} />
          <rect className={styles.t3} x="13.3" y="10.3" width="7.2" height="10.2" rx="1.8" fill={v.lavFill} stroke={v.lavDeep} />
          <rect className={styles.t4} x="3.5" y="13.1" width="7.2" height="7.4" rx="1.8" fill={v.white} />
        </>
      );

    // workforce + scheduling — two people; second springs in, slight bob on idle
    case "workforce":
      return (
        <>
          <g className={styles.p2} stroke={v.lavDeep}>
            <circle cx="16.7" cy="8.4" r="2.5" fill={v.lavFill} />
            <path d="M21 19 v-1 a3.7 3.7 0 0 0 -3.9 -3.6" />
          </g>
          <g className={styles.p1}>
            <circle cx="9" cy="8" r="3.1" fill={v.white} />
            <path d="M3.6 19 v-1.1 A4.5 4.5 0 0 1 8 13.4 h2 A4.5 4.5 0 0 1 14.4 17.9 V19" />
          </g>
        </>
      );

    // inventory setup — box; lid lifts and an item pops on hover
    case "inventory":
      return (
        <>
          <path className={styles.pop} d="M12 9 V4 M9.5 6 L12 3.5 L14.5 6" stroke={v.lavDeep} />
          <path d="M4 9 L12 12 L20 9 L12 6 Z" fill={v.white} />
          <path d="M4 9 V17 L12 20 V12" />
          <path d="M20 9 V17 L12 20" />
          <path className={styles.lid} d="M4 9 L12 12 L20 9 L12 6 Z" fill={v.lavFill} stroke={v.lavDeep} />
        </>
      );

    // bookkeeping — ledger / receipt with lines; a row highlights on hover
    case "bookkeeping":
      return (
        <>
          <path d="M6 3 H16 a2 2 0 0 1 2 2 V21 l-2 -1.4 -2 1.4 -2 -1.4 -2 1.4 -2 -1.4 -2 1.4 V5 a2 2 0 0 1 2 -2 Z" fill={v.white} />
          <line x1="8.5" y1="8" x2="15.5" y2="8" />
          <line className={styles.r2} x1="8.5" y1="11.4" x2="15.5" y2="11.4" stroke={v.lavDeep} />
          <line x1="8.5" y1="14.8" x2="13" y2="14.8" />
          <rect className={styles.hl} x="7.4" y="9.9" width="9.2" height="3" rx="1" fill={v.lavFill} stroke="none" />
        </>
      );

    // alerts — warning triangle; idle nudge, hard shake + bang dot on hover
    case "alerts":
      return (
        <>
          <g className={styles.tri}>
            <path d="M12 4 L21 19 H3 Z" fill={v.white} />
            <line x1="12" y1="10" x2="12" y2="14" stroke={v.coral} />
          </g>
          <circle className={styles.bang} cx="12" cy="16.6" r="1.15" fill={v.coral} stroke="none" />
        </>
      );

    // Ask CC — ✦ sparkle (matches the rail glyph in the app)
    case "ask":
      return (
        <g strokeWidth={1.6}>
          <path className={styles.big} d="M12 3 C12.6 8.4 13.6 9.4 19 10 C13.6 10.6 12.6 11.6 12 17 C11.4 11.6 10.4 10.6 5 10 C10.4 9.4 11.4 8.4 12 3 Z" fill={v.lavDeep} stroke="none" />
          <path className={styles.sm1} d="M18.5 14 c.25 2 .5 2.25 2.5 2.5 c-2 .25 -2.25 .5 -2.5 2.5 c-.25 -2 -.5 -2.25 -2.5 -2.5 c2 -.25 2.25 -.5 2.5 -2.5 Z" fill={v.lav} stroke="none" />
          <path className={styles.sm2} d="M5.5 4 c.18 1.4 .35 1.6 1.7 1.8 c-1.35 .2 -1.52 .4 -1.7 1.8 c-.18 -1.4 -.35 -1.6 -1.7 -1.8 c1.35 -.2 1.52 -.4 1.7 -1.8 Z" fill={v.lav} stroke="none" />
        </g>
      );

    // settings — gear; slow idle rotation, quarter-turn snap on hover
    case "settings":
      return (
        <g className={styles.gear}>
          <path
            d="M12 2.6 l1.5 .9 1.7 -.3 .9 1.5 1.5 .9 -.3 1.7 .9 1.5 -.9 1.5 .3 1.7 -1.5 .9 -.9 1.5 -1.7 -.3 -1.5 .9 -1.5 -.9 -1.7 .3 -.9 -1.5 -1.5 -.9 .3 -1.7 -.9 -1.5 .9 -1.5 -.3 -1.7 1.5 -.9 .9 -1.5 1.7 .3 Z"
            fill={v.lavFill}
            stroke={v.lavDeep}
          />
          <circle cx="12" cy="12" r="3" fill={v.white} stroke="currentColor" />
        </g>
      );

    // floating Ask CC bubble — distinct from the rail sparkle
    case "chat":
      return (
        <>
          <path
            className={styles.bubble}
            d="M4 6.5 a3 3 0 0 1 3 -3 H17 a3 3 0 0 1 3 3 V14 a3 3 0 0 1 -3 3 H9.5 L5.5 20.5 V17 H7 a3 3 0 0 1 -3 -3 Z"
            fill={v.lavFill}
            stroke={v.lavDeep}
          />
          <circle className={`${styles.typ} ${styles.d1}`} cx="9" cy="10.2" r="1.15" fill={v.lavDeep} stroke="none" />
          <circle className={`${styles.typ} ${styles.d2}`} cx="12" cy="10.2" r="1.15" fill={v.lavDeep} stroke="none" />
          <circle className={`${styles.typ} ${styles.d3}`} cx="15" cy="10.2" r="1.15" fill={v.lavDeep} stroke="none" />
        </>
      );
  }
}

export default RailIcon;
