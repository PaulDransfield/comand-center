# CommandCenter UI Overhaul — Prompt 1 of N: Foundation

> Paste the block below into Claude Code. This is the FOUNDATION phase — it builds nothing customer-visible on its own; it creates the shared system every later phase reuses, fixes the two global bugs at the source, and removes dead code so later phases touch fewer files.
> Do NOT run the page-rebuild prompts until this one is merged and a Vercel preview is verified.

---

## The prompt to paste

> We are starting a phased UI overhaul of CommandCenter to a "pastel lavender" design system (a Nory-style app aesthetic). This first phase is **foundation only** — no page should change its data or its routes. Work in a branch `ux/overhaul-1-foundation` and push a Vercel preview when done. **Do not attempt the whole app — only the tasks below.**
>
> **Context you must respect (from a codebase audit):**
> - Stack: Next.js 14 App Router, TypeScript, **inline styles only** (no Tailwind/CSS-modules/styled-components — do not add any), Supabase, Vercel.
> - The canonical formatter ALREADY EXISTS at `lib/format.ts` (`fmtKr`, `fmtNum`, `fmtPct`, `fmtHrs`). Do **not** create a new one.
> - The design tokens ALREADY EXIST at `lib/constants/tokens.ts` (the `UX` object) and are marked "ADDITIVE ONLY — do not replace colors.ts". Respect that header.
> - `components/ui/SyncIndicator.tsx` ALREADY contains hard-won defensive code (`fontFamily: 'inherit'`, `minWidth: 0`, ellipsis) that fixes a font-substitution + truncation bug. **Do not reimplement, reskin, or inline it.** Only update its colour values to the new tokens if needed, preserving all three defences.
> - The public landing page `app/page.tsx` has its OWN intentional palette (DM Sans + Fraunces, cream). **Do not touch it in this phase.**
>
> **Task 1 — Add pastel-lavender tokens (additive).**
> In `lib/constants/tokens.ts`, ADD a new export `UXP` (do not modify the existing `UX` object, do not touch `colors.ts`). Values:
> ```ts
> export const UXP = {
>   pageBg: '#f1eff9', cardBg: '#ffffff', subtleBg: '#faf9fd',
>   border: 'rgba(58,53,80,0.08)', borderSoft: 'rgba(58,53,80,0.05)',
>   ink1: '#3a3550', ink2: 'rgba(58,53,80,0.62)', ink3: 'rgba(58,53,80,0.45)', ink4: 'rgba(58,53,80,0.38)',
>   lav: '#a99ce6', lavDeep: '#7d6cc9', lavText: '#564a8a', lavFill: '#ece8f8', lavMid: '#c4b8ec', lavPale: '#d8d2f0',
>   green: '#5f9e7e', greenDeep: '#477f60', greenFill: '#eef4f0', greenBar: '#4f9b76',
>   coral: '#c0703a', coralLine: '#e7a37e', costAmber: '#b0883c',
>   rose: '#c06a72', roseFill: '#f7dee0', roseText: '#b0454e',
>   slate: '#7a7782', slateFill: '#efeef2',
>   r_sm: 6, r_md: 8, r_lg: 12, railW: 46,
> } as const
> ```
>
> **Task 2 — Consolidate the currency formatter (fixes the `kr kr` bug at the source).**
> There are 15+ files declaring their own inline `fmtKr`/`formatKr`/`fmtKrCompact` or appending `' kr'` in template literals, which is the root cause of `kr kr` double-suffix bugs. For every file that has its own currency formatter, **delete the local implementation and import `{ fmtKr }` from `@/lib/format`** instead, then fix any call site that was appending ` kr` to a value already formatted. Known offenders to start with (grep for others — `fmtKr`, `formatKr`, `' kr'`, `\` kr\``):
> `components/dashboard/RecentInvoicesFeed.tsx`, `components/dashboard/CashPositionTile.tsx`, `components/dashboard/CashFlowProjectionTile.tsx`, `components/dashboard/WeatherDemandWidget.tsx`, `app/revisor/page.tsx`, `app/revisor/[bizId]/[year]/[month]/page.tsx`, `lib/email/digest.ts`, `lib/ai/weekly-manager.ts`, `lib/admin/disagreements.ts`, `lib/agents/cost-intelligence.ts`, `lib/alerts/detector.ts`, `lib/alerts/line-item-anomalies.ts`, `lib/fortnox/validators.ts`, and the two API routes `app/api/scheduling/ai-suggestion/route.ts`, `app/api/tracker/narrative/route.ts`.
> ⚠️ `CashPositionTile`'s local `fmtKr` takes a currency param — if any business is non-SEK, preserve that behaviour (extend `lib/format.ts` with an optional currency arg rather than dropping the feature). Otherwise use the canonical one.
> After this task, grep the repo for `kr kr` and confirm zero matches in rendered output paths.
>
> **Task 3 — Load the real fonts via `next/font` (this is the single biggest fidelity fix).**
> The mockups look more polished than past rebuilds primarily because they use tuned web fonts; the app currently falls back to the system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI"` in `app/layout.tsx` body style), which renders heavier and cheaper. Fix this so the redesigned surfaces match the mockups:
> - In `app/layout.tsx`, import `Spline_Sans` (body/UI) and `Fraunces` (display/numbers) via `next/font/google`, with `display: 'swap'`, exposing them as CSS variables (e.g. `--font-sans`, `--font-display`).
> - Set the **app body font to Spline Sans** via the variable. Do NOT change `app/page.tsx` (the public landing page keeps its own DM Sans + Fraunces stack).
> - Add `--font-sans` / `--font-display` to `globals.css` `:root`. KPI numbers and page titles use the display font; everything else uses Spline Sans.
> - If `next/font/google` is unavailable in the build environment, self-host the two woff2 files under `app/fonts/` and load via `next/font/local` — do not fall back to the system stack on redesigned surfaces.
> Acceptance: redesigned surfaces render in Spline Sans / Fraunces, confirmed in the Vercel preview; the landing page is visually unchanged.
>
> **Task 4 — Build the four reusable components, FROM EXACT VALUES (not descriptions).** New files under `components/ux/`. Inline styles, colours from `UXP`. Each is presentational (props in, no data fetching). **Critical for fidelity: use these literal style values — do not approximate, round, or substitute "close enough" numbers.** The past quality gap came from interpreting descriptions; this time the numbers are exact.
>
> Shared exact tokens to use verbatim across all four:
> ```
> card:         { background:'#fff', borderRadius:12, padding:'14px 16px' }
> cardBorder:   '0.5px solid rgba(58,53,80,0.08)'   // 0.5px hairline — do NOT round to 1px
> bigNumber:    { fontFamily:'var(--font-display)', fontSize:22, fontWeight:500, letterSpacing:'-0.02em', fontVariantNumeric:'tabular-nums' }
> label:        { fontSize:11, color:'rgba(58,53,80,0.6)' }
> microLabel:   { fontSize:9, letterSpacing:'0.04em', color:'rgba(58,53,80,0.5)' }
> deltaPos:     { fontSize:10, color:'#5f9e7e' }   deltaNeg:{ fontSize:10, color:'#c06a72' }
> tableCell:    { fontSize:11, fontVariantNumeric:'tabular-nums' }
> footerRow:    { background:'#f7f6fb', color:'rgba(58,53,80,0.6)' }
> sectionGap:12   rowPad:'10px 16px'   headerFontSize:9
> ```
> Every numeric figure carries `fontVariantNumeric:'tabular-nums'`. Every hairline is `0.5px`, never `1px`. Big numbers always `letterSpacing:'-0.02em'`, never `0`.
>
> - `components/ux/AppShellUX.tsx` — page chrome: a **46px** icon-only left rail (`background:'#fff'`, right border `0.5px solid rgba(58,53,80,0.06)`; active item = `28×28` chip `background:'#ece8f8'`, icon `#7d6cc9`; inactive icon `rgba(58,53,80,0.38)`) + a top toolbar (each control = white pill, `0.5px` border `rgba(58,53,80,0.1)`, `borderRadius:7`, `padding:'5px 9px'`, `fontSize:11`) rendering `Insights ▾` / `[section] ▾` dropdowns, a date stepper pill (◄ label ►), optional `Compare: … ▾`, and a far-right **Ask CC** pill (`background:'#a99ce6'`, white, sparkle icon). Props: `section, dateLabel, onPrev, onNext, compareLabel?, navItems, activeKey, children`. Does NOT replace the existing `components/AppShell.tsx` yet.
> - `components/ux/KpiCard.tsx` — uses `card` + `cardBorder` exactly. Title (`label`), big number (`bigNumber`), delta (`deltaPos`/`deltaNeg` with ↗/↘). Optional `variant`: `'channels'` (legend + % + one stacked horizontal bar), `'stacked'` (two labelled bars), `'targetBand'` (marker bar with 30–35% band), `'plain'`. Currency via `fmtKr`, % via `fmtPct`.
> - `components/ux/PairedBarChart.tsx` — inline SVG, **viewBox width matched 1:1 to render width** so strokes stay crisp; bars `rx=3`. N day-groups, 1–3 clustered bars (`#a99ce6` / `#c4b8ec` / `#d8d2f0`), optional 1–2 line overlays on a right axis (`#c0703a` solid + `#e7a37e` dashed, `stroke-width:2`), axis ticks both sides `fontSize:7 rgba(58,53,80,0.45)`, legend below `fontSize:9`. Props: series, labels, left/right axis max, legend items.
> - `components/ux/BreakdownTable.tsx` — CSS grid, `rowPad` per row, header row `microLabel` with bottom border `0.5px solid rgba(58,53,80,0.08)`, body rows separated by `0.5px solid rgba(58,53,80,0.04)`, numerics right-aligned `tableCell`+`tabular-nums`, delta chips (green `#eef4f0`/`#477f60`, rose `#f7dee0`/`#b0454e`, `fontSize:9 borderRadius:6 padding:'2px 6px'`), muted footer `footerRow`. Props: column defs, section defs, rows, footer.
>
> **Task 4b — Robustness: test components against UGLY real-shaped data, not tidy mock data.** Render each at least once with a long name that must ellipsis/wrap, a 9-figure number (`1 284 593 kr`), a `null`→`—` value, and a negative delta. Layouts must not break, columns must stay aligned, hairlines must stay `0.5px`.
>
> **Task 5 — Delete confirmed-dead components** (audit-confirmed unused). Remove and fix any stray imports:
> - `components/ui/AppShellV2.tsx` (never imported)
> - `components/Sidebar.tsx` (old, kept "for rollback" — superseded by `SidebarV2`)
> - whichever of `components/MobileNav.tsx` / `components/shared/MobileBottomNav.tsx` is unused (keep the one `AppShell.tsx` imports — `MobileNav`)
> - `components/admin/AdminNav.tsx` (V1 admin nav, superseded by `admin/v2/AdminNavV2`)
> Do NOT delete the V1 admin *routes* in this phase (separate cleanup). Only the confirmed-dead nav component.
>
> **Constraints (apply to every task):**
> - **REPLACE, don't append.** When you change a file, remove the old code you're superseding — do not leave dead duplicate implementations behind. (This is a known failure mode; be strict about it.)
> - Do not touch routes, data fetching, API behaviour, or `app/page.tsx` (landing).
> - Do not add any dependency. Charts stay inline SVG.
> - Keep `SyncIndicator.tsx`'s three defensive properties intact.
> - TypeScript must compile (`tsc --noEmit` clean) and the existing pages must still render unchanged — this phase adds the new system alongside the old; it does not yet wire pages to it.
>
> **When done:** push `ux/overhaul-1-foundation`, give me the Vercel preview URL, and report: (a) the `UXP` token export, (b) the `next/font` setup and confirmation redesigned surfaces render in Spline Sans / Fraunces while the landing page is unchanged, (c) the list of files where you replaced the inline formatter, (d) the four new component files with their prop signatures, (e) confirmation each was rendered against the ugly-data cases without breaking, (f) the deleted dead files, (g) confirmation `tsc --noEmit` passes and `grep -r "kr kr"` is clean.

---

## What comes after (the phased sequence — don't paste these yet)

- **Prompt 2 — Pilot page (Dashboard/Overview).** Wire `app/dashboard/page.tsx` to the new `AppShellUX` + `KpiCard` + `PairedBarChart` + `BreakdownTable`, real data unchanged. This is the proof the system works on one real, complex page before rolling out. Includes the **sidebar decision**: full Nory 46px icon rail (default) vs re-skin the existing labelled `SidebarV2` to pastel.
- **Prompt 3 — Financials batch.** `/financials/performance` (Flash P&L → per-location columns), `/tracker`, `/budget`, `/forecast`.
- **Prompt 4 — Operations batch.** `/revenue`, `/staff`, `/departments`, `/scheduling`, `/reviews`, `/alerts`.
- **Prompt 5 — Cash + Suppliers.** Promote cash tiles to a dedicated page; build the Suppliers/COGS-from-Fortnox page (real data).
- **Prompt 6 — Placeholder vision pages.** New routes for Inventory item master, Recipes, Waste, full Schedule grid — populated with **clearly-marked mock data behind a `<DemoDataBanner>`** (a small dismissible "Demo data — feature in development" strip). These render the agreed mockups so the app looks complete, with mock data isolated in `lib/mock/*` for trivial later swap.
- **Prompt 7 — Cleanup.** Switch every page to `AppShellUX`, delete the old `AppShell`/`SidebarV2` once nothing imports them, remove V1 admin routes, retire the legacy `colors.ts` style-object exports that the migration made unused.

Each prompt: its own branch, its own Vercel preview, verified before the next. Paste the foundation prompt first; when its preview is clean, come back and I'll tailor Prompt 2 to whatever the foundation report reveals.
