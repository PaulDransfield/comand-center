# CommandCenter

> AI-powered business intelligence for Swedish restaurants.
> Real-time financial tracking, document intelligence, and automated reporting.

**Live**: [bjorken-bcc.vercel.app](https://bjorken-bcc.vercel.app)  
**Stack**: Next.js 14 · Supabase · Anthropic Claude · Stripe · Vercel

---

## Quick Start (Local Development)

```bash
# 1. Clone and install
git clone https://github.com/PaulDransfield/command-center.git
cd command-center
npm install

# 2. Create environment file
cp .env.example .env.local
# Edit .env.local with your keys (see Environment Variables below)

# 3. Run dev server
npm run dev

# 4. Test connection
curl http://localhost:3000/api/health
# Expected: {"status":"ok","database":"connected"}
```

---

## Deployment (Vercel)

### First-time deploy

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy (will prompt for project setup)
vercel

# Link to existing project
vercel link
```

### Environment variables

Set these in Vercel Dashboard → Project → Settings → Environment Variables:

```bash
# Supabase — from supabase.com → your project → Settings → API
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Anthropic — ⚠️ ROTATE before deploy: console.anthropic.com → API Keys
ANTHROPIC_API_KEY=sk-ant-...

# Stripe — from stripe.com dashboard
STRIPE_SECRET_KEY=sk_live_...          # Use sk_test_ for development
STRIPE_WEBHOOK_SECRET=whsec_...        # From Stripe → Webhooks → signing secret
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PRO=price_...

# Email
RESEND_API_KEY=re_...

# Security — generate each with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CREDENTIAL_ENCRYPTION_KEY=64_hex_chars
CRON_SECRET=any_random_string
ADMIN_SECRET=admin123  # Password for admin panel access

# Fortnox — from developer.fortnox.se (apply for developer account)
FORTNOX_CLIENT_ID=...
FORTNOX_CLIENT_SECRET=...

# Monitoring (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# App
NEXT_PUBLIC_APP_URL=https://yourapp.vercel.app
```

### Database setup

1. Create a Supabase project at supabase.com (Europe West region)
2. Run SQL in order in SQL Editor:
   ```
   supabase_schema.sql
   support_schema.sql
   beta_signups table (see app/api/beta/signup/route.ts)
   ```
3. Verify RLS: `SELECT count(*) FROM organisations;` as anon user should return 0

### Stripe setup

1. Create products in Stripe Dashboard:
   - **Starter**: 499 SEK/month (or $29 USD)
   - **Pro**: 999 SEK/month (or $79 USD)
2. Copy Price IDs to `STRIPE_PRICE_STARTER` and `STRIPE_PRICE_PRO`
3. Add webhook endpoint: `https://yourapp.vercel.app/api/stripe/webhook`
4. Subscribe to events: `customer.subscription.*`, `invoice.payment_*`, `checkout.session.completed`, `charge.refunded`
5. Copy signing secret to `STRIPE_WEBHOOK_SECRET`

---

## Architecture

```
command-center/
├── app/
│   ├── (auth)/login/        — Login, signup, forgot password
│   ├── api/
│   │   ├── auth/            — Signup, callback (email verification)
│   │   ├── businesses/      — GET all businesses with tracker data
│   │   ├── chat/            — SSE streaming AI chat
│   │   ├── documents/upload/ — Multipart file upload to Supabase Storage
│   │   ├── integrations/
│   │   │   └── fortnox/     — OAuth2 connect, callback, sync, refresh
│   │   ├── stripe/          — checkout, webhook, portal, usage
│   │   ├── cron/            — hourly health checks, daily emails
│   │   ├── beta/signup/     — Beta program applications
│   │   └── health/          — Connection test
│   ├── dashboard/           — Main dashboard (individual + aggregate view)
│   ├── notebook/            — AI document intelligence
│   ├── tracker/             — Financial tracker with Fortnox sync
│   ├── integrations/        — Connect Fortnox, Ancon, Caspeco
│   ├── upgrade/             — Pricing page with usage meters
│   ├── onboarding/          — 6-step setup wizard
│   ├── beta/                — Beta signup page
│   ├── changelog/           — Public changelog
│   └── reset-password/      — Password reset form
├── components/
│   ├── dashboard/           — Topbar, Sidebar, KPICard
│   └── shared/              — MobileBottomNav
├── context/
│   └── BizContext.tsx       — Multi-business state provider
└── lib/
    ├── supabase/             — client.ts, server.ts (admin)
    ├── auth/                 — get-org.ts (JWT org extraction)
    ├── stripe/               — config.ts (plan limits)
    ├── integrations/         — encryption.ts (AES-256-GCM)
    ├── middleware/           — rate-limit.ts
    └── analytics/            — posthog.ts
```

---

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Database | Supabase PostgreSQL | SQL for financial queries; RLS for multi-tenancy |
| Auth | Supabase Auth | JWT + RLS out of the box |
| AI | Anthropic Claude | Best document Q&A; central key (users never see it) |
| AI streaming | Server-Sent Events | Real-time token streaming without WebSockets |
| Rate limiting | In-memory sliding window | No Redis needed; Upstash upgrade path documented |
| Credential storage | AES-256-GCM | Key in env var, never in database |
| Payments | Stripe | Swedish card support; customer portal built-in |
| Hosting | Vercel | Next.js native; cron jobs; edge deployment |

---

## GDPR & Compliance

- Tenant data isolated by PostgreSQL Row Level Security
- Personnummer stored as HMAC-SHA256 hash only
- All API credentials encrypted at rest (AES-256-GCM)
- Audit log is immutable (SQL RULES block UPDATE/DELETE)
- Admin impersonation requires explicit user consent per session
- Privacy policy at `/privacy`

---

## Development Commands

```bash
npm run dev         # Start dev server (localhost:3000)
npm run build       # Production build
npm run typecheck   # TypeScript check without building
npm run lint        # ESLint
```

---

## Support

- In-app widget: click the 💬 button on any page
- Email: support@commandcenter.se
- Admin dashboard: /admin (requires 2FA)
