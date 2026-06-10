# CommandCenter — Embedded Finance / Lending: Strategy Memo

*Captured 2026-06-10. A validated future revenue line, not a near-term build. Keep for later; usable in investor materials.*

---

## 1. The opportunity in one paragraph

Restaurant operators constantly need capital — new venues, equipment, refits, bridging cash-flow gaps. CommandCenter already holds the exact data a lender needs to underwrite them fast and safely: Fortnox-verified revenue, P&L, cost structure, cash position, and forecasted demand. That makes embedded lending a natural future revenue line: CommandCenter offers branded financing ("CommandCenter Capital") to its operators, a licensed partner provides the money and carries the risk and the licence, and CommandCenter earns a share of the interest **without lending its own money or taking credit risk.** This is the same model Nory uses (Nory Capital is powered by YouLend). The Nordic equivalent partner already exists, is licensed, and is live in CommandCenter's exact markets.

## 2. How the model works (the Nory blueprint)

- Nory doesn't lend — **Nory Capital is powered by YouLend**, an embedded-finance platform. Nory is the distribution + data layer; YouLend is the capital + licence + underwriting.
- Approval is fast (Nory advertises ~24h, ~85% acceptance) **because the platform feeds the lender verified financials** — no months of paperwork. The underwriting is fast because the data is already there.
- Repayment is typically a **percentage of daily card sales** (flexes with cash flow; nothing repaid on zero-sales days), or fixed monthly — the revenue-based-financing structure restaurants prefer.
- Key insight: the lending isn't a bolted-on feature — it's a **monetisation of the financial data the platform already holds.** Which is exactly the data CommandCenter is built around.

## 3. The Nordic partner: Froda (the YouLend-equivalent for our markets)

Froda (Stockholm, founded 2015) is an almost purpose-built fit:

- **Licensed where it matters:** Froda is a *licensed credit market company supervised by Finansinspektionen* (Swedish FSA). This is the load-bearing fact — see §5.
- **Already in our markets:** Froda Embedded is live in Sweden, Denmark, Norway, Finland, Germany, UK, Ireland, and its licence covers the full EEA. **Sweden (home) and Norway (next expansion) are both already live** — no new-market dependency.
- **Built for partners exactly like us:** "suitable for banks, neobanks, payment providers, e-com platforms and other businesses with SME offerings that want to add financing." A restaurant-group vertical SaaS is squarely "a business with an SME offering that wants to add financing."
- **White-label / own-brand:** partners incorporate their own brand — so it's "CommandCenter Capital," not "Froda."
- **No partner risk:** Froda's stated model lets partners offer SME lending "with no risk to the partner" — Froda handles origination, servicing, AND non-performing-loan (NPL) processes.
- **Proven with a software-platform partner:** Froda partners with **Ageras** (banking/accounting/admin software) — structurally close to what CommandCenter would do (a SaaS holding financial data adding financing). The model isn't theoretical for platform partners; it's running.
- **Light integration:** Froda quotes ~2 weeks for 2 developers to integrate their APIs (relevant later, not now).

Froda's three products: **Loans** (white-label SME loan — the relevant one), **Installments**, and **Funding** (use Froda's balance sheet to power your own lending product — a later, more involved option).

## 4. How CommandCenter makes money from this (the core question)

Froda states it directly: *"Nothing [to integrate]. You have the distribution channel and we have the product. Froda generates interest income on the loans originated via embedded partnerships. This revenue is then shared with our partners."*

So CommandCenter's revenue mechanics:

- **Revenue share on interest income.** Froda earns interest on each loan; CommandCenter takes an agreed share of it. Froda's platform has **automatic split settlement** that splits interest income and pays partner commission — the plumbing is built in.
- **Market-standard ranges** (the band you'd negotiate within, not Froda-specific quotes):
  - **Origination/referral fee:** ~1–3% of the loan amount, paid immediately, no credit risk.
  - **Interest-spread revenue share:** ~10–30% of the interest spread over the life of the loan.
  - Many platforms combine: a small origination fee + an ongoing interest share.
- **Zero capital outlay, zero credit risk, zero integration cost** to start — CommandCenter provides distribution (its customer base) and data (the underwriting fuel); Froda provides everything regulated and capital-bearing.

**Illustrative scale (rough, to size it — NOT a forecast):** if CommandCenter had, say, 50 restaurant customers and 15 took an average SEK 300k loan in a year = SEK 4.5m originated. At a blended ~3-5% effective partner take across origination + interest share, that's ~SEK 135k–225k/year — on top of subscription revenue, at no capital risk. The number scales directly with customer count and loan uptake. The point isn't the exact figure; it's that **it's a high-margin, capital-light revenue line that grows with the customer base CommandCenter is building anyway.**

Secondary benefit beyond the revenue: financing materially **increases stickiness and customer success** (industry data cited 70%+ revenue uplift and higher satisfaction when financing is embedded) — an operator who funded their new venue through CommandCenter is far less likely to churn.

## 5. Regulatory reality (better than expected, not zero)

- **CommandCenter does NOT need to become a licensed lender.** Because Froda holds the Finansinspektionen credit-market licence, the regulated activity (lending, credit decisions, servicing) sits with Froda. This removes the single biggest barrier in embedded finance.
- **CommandCenter's role is credit intermediary / introducer / distribution partner** — presenting a branded credit product. This still carries a compliance surface: how the product is marketed, required disclosures, and the partnership agreement defining the exact role (typically a tied-agent or referral arrangement under the licensed entity's umbrella).
- **First-line KYC/AML may still touch the platform** — even under a partner-licence model, the platform is often responsible for first-line Know-Your-Customer / Anti-Money-Laundering, and reputational risk of fraud lands on the brand first. To confirm in the partner agreement: who carries KYC/AML, who handles collections/disputes, and how a borrower's negative experience is insulated from the CommandCenter brand.
- **It's a solved, templated arrangement** — Froda has many partners doing exactly this, so onboarding is into an existing legal structure, not a bespoke build. Real paperwork and a partnership agreement, not a regulatory moonshot.
- **Corporate fit:** this would sit under CommandCenter AB. Worth a note to the revisor when the entity structure is finalised, but not a blocker now.

## 6. Why this is a LATER move (honest sequencing)

- Embedded lending monetises **the data you hold about a base of operators.** It only works — and only pays materially — at scale, because partner revenue is a percentage of loan volume.
- Right now: a handful of beta customers (own restaurants). Not enough loan volume to interest a partner or generate meaningful revenue.
- Nory added Capital *after* ~$62m raised and a real customer base. This is a **scale-stage monetisation**, consistent with CommandCenter's own staging.
- **The partner (Froda) is ready whenever CommandCenter is** — licensed, in-market, partner-model proven. The gating factor is entirely on CommandCenter's side: customer base + data readiness.

## 7. What to do now (almost nothing — and that's the point)

- **Build nothing.** This is a documented strategic option, not a near-term feature.
- **Keep doing the data work already underway.** Clean, complete, Fortnox-verified financial data per customer *is* the asset embedded lending underwrites against. Every bit of cost-foundation work doubles as preparation for this. The one thing worth keeping in mind: structure the data so "this customer's verified monthly revenue + cash position" is a clean export — which it largely is already.
- **Use it in the investor story now.** It's a strong line: *"The verified financial data we aggregate per operator opens a capital-light embedded-finance revenue path — via licensed partners like Froda, already live in our Sweden and Norway markets — that grows with our customer base at no credit risk to us."* It strengthens the "data is the moat" narrative and shows a second revenue line beyond subscriptions.

## 8. The trigger to actually pursue it

When CommandCenter has a real base of paying Swedish customers — roughly the same **15–30 customer** threshold set for Norway expansion — that's when:
1. There's enough loan-volume potential to be an attractive Froda partner, and
2. There's enough per-customer verified data to make their underwriting fast and their default rates low.

At that point: open a conversation with Froda Embedded (frodaembedded.com), confirm the commercial terms (revenue split, origination vs interest-share, KYC/AML responsibilities, collections, brand insulation), and scope the ~2-week integration.

## 9. Open questions for the eventual Froda conversation

- Exact revenue split: origination fee %, interest-spread share %, and how it's calculated/settled.
- Who owns first-line KYC/AML, and what's required of CommandCenter operationally.
- Collections/NPL handling and how borrower disputes are insulated from the CommandCenter brand.
- Minimum volume / partner requirements — is there a customer-base or origination floor to onboard.
- Whether repayment-via-card-sales requires CommandCenter customers to use a specific payment/POS rail (Froda's card-based product needs Visa business card issuance — likely not our path; the standard Loans product is).
- Data-sharing arrangement: what CommandCenter passes to Froda for underwriting, and the consent/privacy structure (GDPR).

---

### One-line summary
Embedded lending is a validated, capital-light, no-credit-risk future revenue line for CommandCenter: a licensed Nordic partner (Froda) is already live in Sweden and Norway, CommandCenter would earn a share of interest income (≈1–3% origination + ≈10–30% interest-spread, to be negotiated) by providing distribution and the verified financial data that makes underwriting fast — triggered by reaching a ~15–30 paying-customer base, requiring no near-term build beyond the data work already underway.
