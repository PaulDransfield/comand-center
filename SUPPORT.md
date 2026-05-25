# SUPPORT.md — Customer support runbook

> Audience: Paul (today) + whoever takes incoming customer support tomorrow.
> Goal: a customer email never falls through the cracks, a severity-1 issue gets answered fast, and routine issues have repeatable scripts.

---

## Inbox structure

All public-facing emails are aliases on `comandcenter.se` forwarded into Gmail Workspace:

| Address | Purpose | Routing |
|---------|---------|---------|
| `support@comandcenter.se` | Day-to-day customer support — bugs, "how do I", account access, billing questions | → paul@ (single recipient until #2 support hire) |
| `hello@comandcenter.se` | Sales / general enquiries from prospects | → paul@ |
| `billing@comandcenter.se` | Payment / invoice / receipt issues | → paul@ |
| `security@comandcenter.se` | Vuln reports, GDPR / data requests | → paul@ |
| `privacy@comandcenter.se` | DPA requests, data deletion | → paul@ |
| `legal@comandcenter.se` | Contracts, terms, sub-processor agreements | → paul@ |
| `paul@comandcenter.se` | Direct line — used in product emails as "reply to" | → paul@ |

**Outbound transactional emails** (signup verify, password reset, billing receipts, AI digests) send `from: hello@comandcenter.se` with `reply_to: support@comandcenter.se` so customer replies land in the right inbox without spamming the founder.

**Gmail labels** (set up these filters in Gmail Settings → Filters):
- `to:support@` → label "Support" + skip inbox into "Support" view
- `to:billing@` → label "Billing"
- `to:security@` OR `to:privacy@` → label "Compliance" + STAR (high priority)
- `to:legal@` → label "Legal"
- Anything else to `paul@` → stays in main inbox

---

## SLA tiers (until #2 support hire)

| Severity | Definition | Response target | Resolution target |
|----------|------------|-----------------|-------------------|
| **S1 — outage** | Customer cannot log in / dashboard shows wrong numbers / data loss suspected | **1 hour** (business hours), **4 hours** out-of-hours | Same day |
| **S2 — broken feature** | Specific page fails, sync stopped, AI not responding, integration disconnected | 4 hours | 2 business days |
| **S3 — bug / UX issue** | Something works but is wrong, confusing, or could be better | 1 business day | 1 week or roadmap'd |
| **S4 — question / how-to** | "How do I", feature requests, "what does X mean" | 1 business day | Reply with answer or doc link |
| **S5 — sales / general** | Pricing questions, demo requests, partnership enquiries | 1 business day | Per case |

**Business hours:** Mon-Fri 09:00–18:00 Stockholm time. Out-of-hours S1 still gets answered same-day; S2-S5 wait until next business day.

**First response** = acknowledgement that the issue is seen and being looked at. Don't wait until resolution to reply.

---

## Triage flow

When a new support email lands:

```
1. Read the subject + first paragraph
2. Classify: S1 / S2 / S3 / S4 / S5 (see table above)
3. Reply within SLA window — even if just "Got it, looking now"
4. If S1 or S2:
   a. Check /admin → customer list → find the org
   b. Pull integration_health row + last sync timestamps
   c. Check Vercel function logs for the relevant route
   d. Reproduce in admin "Login as customer" mode (don't change anything)
5. If S3-S5: queue in a personal todo + reply within SLA
6. Track in a simple Notion / Google Sheet for now:
   - date, from, severity, summary, status, time-to-first-reply, time-to-resolution
7. After resolution, mark the email done in Gmail.
```

**Don't:**
- Reply outside SLA without sending an interim "Still looking" message
- Reply with code or technical jargon — translate to owner language
- Promise a fix on a date you can't keep — say "I'll be back to you by EOD Thursday with status"
- Discuss other customers, even anonymously

---

## Common issues — first-response scripts

### "I logged in but my dashboard is empty / loading forever"

**Cause:** Fresh signup that hasn't had a master-sync run yet, OR a Fortnox/PK integration is in `needs_reauth` state.

**Reply template:**
> Hi {name}, thanks for the note. Two things I'll check:
>
> 1. Whether your first sync has completed. New accounts sync overnight at 04:00 UTC (~05:00 Stockholm). If you signed up after that, the first full data load happens early tomorrow morning.
> 2. Whether your Fortnox / Personalkollen connections are healthy.
>
> Looking now and will reply within {SLA} with status.

**Admin check:**
- `/admin/customers/{org_id}` — look at integration_health
- Check `daily_metrics` for any rows in the last 24h
- If integration is `needs_reauth`, reply with reconnect link

### "My Fortnox connection says broken / I need to reconnect"

**Cause:** Token expired and refresh failed (revoked at Fortnox, password changed, etc.). The new `/api/integrations/fortnox/route.ts` OAuth flow handles re-auth cleanly.

**Reply template:**
> Hi {name}, the connection just needs a fresh OAuth handshake. Open https://comandcenter.se/integrations, click "Reconnect" next to Fortnox, and approve the permissions again. Your historical data stays — only the live sync needs the refresh.
>
> If the reconnect doesn't work, reply with a screenshot and I'll dig in.

### "I see numbers I don't understand on the dashboard"

**Cause:** Often a data-source disagreement (PK vs Fortnox) or a missing month. The dashboard tries to flag these but copy can be opaque.

**Reply template:**
> Hi {name}, the number you're seeing is {explain in owner language}. The reason it differs from what you'd expect is {dig into the actual cause via /admin}.
>
> If you'd like to walk through it together, happy to jump on a 15-min call — pick a slot at https://cal.com/paul-comandcenter.

**Admin check:**
- Look at `monthly_metrics.cost_source` — anything ending `_disagrees` or `_partial` is a known discrepancy
- Cross-check `tracker_data` for the month — was Fortnox PDF applied?

### "Can I have a feature that does X?"

**Reply template:**
> Hi {name}, thanks for the suggestion. Adding this to the roadmap — won't promise a date but will let you know when it's in flight.
>
> Curious: would {clarifying question — what does the feature really need to do for them}?

**Internal:** add to `ROADMAP.md` under "Upcoming" with the requester's org tagged. Customer feedback drives priority more than gut feeling.

### "I want to cancel / downgrade"

**Reply template:**
> Hi {name}, sorry to hear it. Before processing the cancellation, two quick questions if you have a moment:
>
> 1. What pushed you to consider cancelling?
> 2. Is there something specific we could fix that would change your mind?
>
> No pressure — just want to learn so we can do better. Either way, your subscription will end on {next renewal date} and your data will be retained for 90 days after that per our terms (gives you time to change your mind or export).

**Internal:** flag every cancel in the support log. Three cancels in a month = pricing/product signal, not just churn.

### "Where's my invoice / receipt / VAT info"

**Reply template:**
> Hi {name}, you'll find every invoice + receipt at https://comandcenter.se/settings/billing — Stripe sends a copy automatically on each renewal too. For VAT changes (e.g. moving from individual to company billing) reply with the new details and I'll update your account.

### "I got a confirmation email but it says my address isn't verified"

**Cause:** Verification link expired (24h window) or they clicked it on a different device.

**Reply template:**
> Hi {name}, no problem — Sign in at https://comandcenter.se/login and you'll see a "Resend verification" link on the dashboard. If that doesn't work for any reason, reply and I'll verify the address from my side.

**Admin action:** if needed, go to Supabase → Authentication → Users → find by email → click "Confirm".

---

## Escalation

**When to ping me (founder) immediately:**
- S1 outage affecting any paying customer
- Suspected data loss / corruption
- Security report / pen-test contact / vuln disclosure
- Press / regulator / lawyer contact
- Customer threatens to leave / sue / complain publicly
- Anything billing-related from a Founding-tier customer

**Channel:** WhatsApp / Signal direct message — email isn't fast enough for these.

---

## Tools used during triage

| Tool | Purpose | Access |
|------|---------|--------|
| `/admin` (cc admin console) | Customer list, integration health, "login as" | Bearer `ADMIN_SECRET` |
| Vercel logs | Function errors, cron run history | https://vercel.com/paul-7076s-projects/comand-center |
| Supabase dashboard | DB inspection, table editor, auth user mgmt | https://supabase.com/dashboard/project/llzmixkrysduztsvmfzi |
| Stripe dashboard | Customer subscription state, payment history | https://dashboard.stripe.com |
| Resend dashboard | Email delivery status, bounces | https://resend.com/emails |
| Fortnox developer console | Token state, API call history (when debugging integration issues) | https://developer.fortnox.se |

**Login-as-customer in admin:** opens a read-only session as the customer's user. Use to reproduce visual issues. NEVER make changes from this mode — it'd show up in their audit log without consent.

---

## Knowledge base (TODO)

Public-facing help docs aren't built yet. When a question comes in 3× from different customers, that's the signal to write a help-doc article. Until then, hand-written email replies are fine.

Suggested first 5 articles to write once content stabilises:
1. Connecting Fortnox (with screenshots)
2. Connecting Personalkollen
3. Understanding your dashboard
4. Adding a second business
5. Cancelling or changing your plan

Host at `docs.comandcenter.se` (Notion → public published page, or similar low-overhead).

---

## Metrics to track (monthly)

Track in a simple Google Sheet — not over-engineered:

- Total support emails received
- Median time-to-first-response (target: under 4h business hours)
- Median time-to-resolution by severity
- Top 3 issue categories (to identify product fixes)
- Cancellation reasons (when known)

Review quarterly. If any metric trends wrong, that's the first sign of either too-many-customers-for-one-person or a recurring product issue.

---

## Future scope

When monthly support volume hits ~30 emails (probably around customer #10-15):
- Hire a part-time customer success person OR move to a shared inbox tool (Front, Help Scout, Plain)
- Build public help docs from accumulated email scripts
- Add a `?intercom` widget OR a "Contact support" form in `/settings` that pre-fills org + page context
- Status page at `status.comandcenter.se` (BetterStack or similar — public uptime + incident history)

Don't pre-build these. Wait for the volume signal.
