# CommandCenter — Next.js Setup Instructions

## Step 1: Create the project (run these commands in your terminal)

```bash
npx create-next-app@14 command-center --typescript --app --no-tailwind --no-src-dir
cd command-center
```

## Step 2: Replace generated files with these files

Copy every file from this folder into your `command-center/` directory.
The folder structure must match exactly.

## Step 3: Install dependencies

```bash
npm install
```

## Step 4: Create .env.local in the project root

```bash
# Supabase (from supabase.com → your project → Settings → API)
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Anthropic (rotate your key first at console.anthropic.com)
ANTHROPIC_API_KEY=sk-ant-...

# Stripe (from stripe.com dashboard)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PRO=price_...

# Email
RESEND_API_KEY=re_...

# Security (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
CREDENTIAL_ENCRYPTION_KEY=64_char_hex
CRON_SECRET=any_random_string

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## Step 5: Test the connection

```bash
npm run dev
```

Open: http://localhost:3000/api/health
Expected: {"status":"ok","database":"connected"}

## Step 6: Test signup

Open: http://localhost:3000/login
Click "Sign up free" → create an account → verify email → log in

You should see the dashboard with the business switcher in the top bar.
