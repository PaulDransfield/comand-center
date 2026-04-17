# Integrations Knowledge Base

Central reference for every external system CommandCenter connects to — **built** today, **planned**, or **blocked**. One file per provider using the [_TEMPLATE.md](./_TEMPLATE.md) structure.

This folder is the source of truth for:
- API endpoints, auth, rate limits
- Business context (market share, pricing, typical customer)
- Implementation gotchas
- Customer demand tracking

When you (or Claude) are about to build an adapter, read the provider's file first. When you discover something new during integration work, update the file.

## How this stays in sync with code
- Every provider here corresponds to a `PROVIDERS` entry in `lib/integrations/providers.ts`
- Built adapters live under `lib/pos/`, `lib/accounting/`, `lib/reservations/`, `lib/hr/`, etc.
- The admin UI's "Add integration" modal reads from the registry — update both when you build a new adapter

## Index

### Built or in-progress (with adapter code)
| Provider | Category | Adapter |
|---|---|---|
| [Personalkollen](./personalkollen.md)   | HR & staffing | `lib/pos/personalkollen.ts` — **built & verified** |
| [Fortnox](./fortnox.md)                 | Accounting    | `lib/api-discovery/fortnox.ts` — **blocked on OAuth approval** |
| [Inzii](./inzii.md)                     | POS           | `lib/pos/inzii.ts` — endpoint still being probed |
| [Swess](./swess.md)                     | POS           | Same API as Inzii |
| [Ancon](./ancon.md)                     | POS           | `lib/pos/ancon.ts` — stub |
| [Caspeco](./caspeco.md)                 | POS           | `lib/pos/caspeco.ts` — stub |
| [Trivec](./trivec.md)                   | POS           | `lib/pos/trivec.ts` — stub |
| [Zettle](./zettle.md)                   | POS           | `lib/pos/zettle.ts` — stub |
| [TheFork](./thefork.md)                 | Reservations  | `lib/pos/thefork.ts` — stub |
| [Foodora](./foodora.md)                 | Delivery      | `lib/pos/foodora.ts` — stub |
| [Wolt](./wolt.md)                       | Delivery      | `lib/pos/wolt.ts` — stub |
| [Bokad](./bokad.md)                     | Reservations  | `lib/pos/bokad.ts` — stub |
| [Quinyx](./quinyx.md)                   | HR            | `lib/pos/quinyx.ts` — stub |

### Planned — Kassasystem (POS)
[Superb](./superb-pos.md) · [Gastrogate POS](./gastrogate-pos.md) · [PUBQ](./pubq.md) · [Zettle](./zettle.md) · [Smart Cash](./smartcash.md) · [Flow POS](./flow-pos.md) · [Yabie](./yabie.md) · [Trivec](./trivec.md) · [Loomis Pay](./loomis-pay.md) · [Winpos](./winpos.md) · [Heynow](./heynow.md) · [Vendolink](./vendolink.md) · [JobOffice](./joboffice.md) · [Ordine](./ordine.md) · [Happy Order](./happy-order.md) · [Weiq](./weiq.md) · [Karma OS](./karma-os.md) · [Nimpos](./nimpos.md) · [Microdeb](./microdeb.md) · [Rebnis](./rebnis.md) · [LogiCash](./logicash.md) · [Qopla](./qopla.md) · [Munu](./munu.md) · [Northmill](./northmill.md) · [OpenPOS](./openpos.md) · [Baemingo](./baemingo.md) · [Onslip](./onslip.md) · [TruePOS](./truepos.md) · [Tickster Blink](./tickster-blink.md) · [ES Kassasystem](./es-kassasystem.md)

### Planned — Bokföring (Accounting)
[Björn Lundén](./bjorn-lunden.md) · [Highnox ERP](./highnox-erp.md) · [Visma](./visma.md)

### Planned — Bordsbokning (Reservations)
[Gastrogate Reservations](./gastrogate-reservations.md) · [Flow Reservations](./flow-reservations.md) · [Superb Reservations](./superb-reservations.md) · [Waiteraid](./waiteraid.md) · [Bordsbokaren](./bordsbokaren.md) · [TrueBOOKING](./truebooking.md)

### Planned — HR & Rekrytering
[Time2Staff](./time2staff.md) · [Evity](./evity.md) · [Monotree](./monotree.md) · [Chainformation](./chainformation.md)

### Planned — Hotellsystem
[Nitesoft](./nitesoft.md)

### Planned — Övriga
[Skatteverket](./skatteverket.md) · [Cappy](./cappy.md) · [Seamlr](./seamlr.md) · [Sculpture / BevChek](./sculpture-bevchek.md)

## Research status (2026-04-17 pass)

| Section | Providers | Fully researched | Stubbed with "NEEDS RESEARCH" | Notes |
|---|---|---|---|---|
| Built / in-progress | 13 | 13 | 0 | PK, Fortnox, Inzii, Swess, Ancon, Caspeco, Trivec, Zettle, TheFork, Foodora, Wolt, Bokad, Quinyx |
| Batch B (high-priority) | 8 | 8 | 0 | Onslip, Qopla, Loomis Pay, Winpos, Yabie, Gastrogate-POS, Superb-POS, Björn Lundén, Visma, Skatteverket, Waiteraid |
| Long tail | 35 | 0 | 35 | POS (23), accounting (0 left), reservations (5), HR (4), hotel (1), other (3) |

**Total providers tracked:** 54 in registry + 5 extras (bokad, foodora, thefork, wolt, quinyx) = 59 covered.

Deep-research the long tail just-in-time when a customer requests that provider. Web search is available from the parent Claude Code session but denied to sub-agents — do research inline rather than delegating.

## How to add a new provider

1. Add an entry to `PROVIDERS` in `lib/integrations/providers.ts` (must include slug, name, category, supported flag)
2. Copy `_TEMPLATE.md` to `<slug>.md` here
3. Fill in what you know, mark unknowns as `NEEDS RESEARCH`
4. Update the index above
5. If you're building the adapter, set `supported: true` in the registry and write the adapter file under the category folder (`lib/pos/<slug>.ts` etc.)

## Notes on Swedish-specific context

- **VAT (moms)** in Sweden for restaurants: 12% food, 25% alcohol. Revenue data can be shown inkl or exkl moms — always confirm which with the provider to avoid 12–25% revenue errors.
- **Skatteverket kassaregister** — Swedish law (Kassaregisterlagen 2007:592) requires cash registers be certified. Certified POS systems expose Z-reports and control-unit data relevant to VAT returns.
- **Personalliggare** (staff presence log) — required by Skatteverket for restaurants. Personalkollen is the market leader for this.
- **Partnership culture** — many Swedish restaurant-tech companies require a formal partnership before opening API access. Scraping customer dashboards is sometimes possible but legally grey.
