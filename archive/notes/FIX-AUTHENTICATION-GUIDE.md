# 🔐 Fix Authentication - Step by Step Guide

## 🚨 **Problem Identified**
Authentication is completely broken because Supabase environment variables are not set in Vercel production. This causes:
- ❌ Cannot sign in
- ❌ Dashboard doesn't load  
- ❌ AI assist returns 404
- ❌ Studio page inaccessible

## 🎯 **Root Cause**
The application requires these environment variables to connect to Supabase (authentication database):
1. `NEXT_PUBLIC_SUPABASE_URL`
2. `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. `SUPABASE_SERVICE_ROLE_KEY`

These are currently set to placeholder values in `.env.local` but need to be set in **Vercel Environment Variables**.

## 📋 **Step-by-Step Fix**

### **Step 1: Get Your Supabase Credentials**

1. **Go to Supabase Dashboard:**
   - Visit https://supabase.com/dashboard
   - Sign in with your account

2. **Select Your Project:**
   - Click on your CommandCenter project

3. **Get API Credentials:**
   - Go to **Settings → API**
   - Copy **"Project URL"** (this is your `NEXT_PUBLIC_SUPABASE_URL`)
   - Copy **"anon public"** key (this is your `NEXT_PUBLIC_SUPABASE_ANON_KEY`)

4. **Get Service Role Key:**
   - In the same **Settings → API** page
   - Look for **"service_role"** key (click "Reveal" if hidden)
   - Copy this as your `SUPABASE_SERVICE_ROLE_KEY`
   - ⚠️ **Warning:** This key has admin privileges, keep it secure!

### **Step 2: Add Environment Variables to Vercel**

1. **Go to Vercel Dashboard:**
   - Visit https://vercel.com/dashboard
   - Sign in with your account

2. **Select Your Project:**
   - Click on your CommandCenter project

3. **Navigate to Environment Variables:**
   - Go to **Settings → Environment Variables**

4. **Add Required Variables:**
   Click "Add New" and add these variables:

   | Variable Name | Value | Description |
   |--------------|-------|-------------|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://your-project-id.supabase.co` | From Supabase API page |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIs...` | From Supabase API page |
   | `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOiJIUzI1NiIs...` | From Supabase API page |
   | `ANTHROPIC_API_KEY` | `sk-ant-...` | Your Claude API key |
   | `CRON_SECRET` | `a-secure-random-string` | For cron job authentication |
   | `ADMIN_SECRET` | `admin123` (or change) | Admin panel password |

5. **Important Settings:**
   - ✅ Check "Automatically expose to Preview"
   - ✅ For production environment
   - ✅ Save all variables

### **Step 3: Redeploy the Application**

1. **Trigger a Redeploy:**
   - Go to **Deployments** tab
   - Click **"Redeploy"** on the latest deployment
   - Or push a small change to GitHub to trigger auto-deploy

2. **Wait for Deployment:**
   - Wait 2-3 minutes for deployment to complete
   - Check deployment logs for any errors

### **Step 4: Test Authentication**

After redeployment, test these:

1. **Sign In:**
   - Go to your app URL
   - Try to sign in with your credentials
   - Should redirect to dashboard

2. **Dashboard:**
   - Should load business data and charts
   - No authentication errors

3. **AI Assist:**
   - Click "Ask AI" button on any page
   - Should open and work properly

4. **Studio Page:**
   - Navigate to `/studio` or `/notebook/studio`
   - Should load without errors

## 🔧 **Troubleshooting**

### **If sign-in still doesn't work:**

1. **Check Browser Console:**
   - Open Developer Tools (F12)
   - Go to Console tab
   - Look for red error messages
   - Share these with support

2. **Check Vercel Logs:**
   - Go to Vercel → Project → Functions
   - Check for runtime errors
   - Look for Supabase connection errors

3. **Verify Supabase Project:**
   - Ensure project is active (not paused)
   - Check database is running
   - Verify tables exist (`organisation_members`, etc.)

4. **Test Supabase Connection:**
   ```bash
   curl "https://YOUR_PROJECT.supabase.co/rest/v1/"
   -H "apikey: YOUR_ANON_KEY"
   ```

### **Common Issues:**

1. **Wrong URL format:**
   - Should be: `https://project-id.supabase.co`
   - Not: `https://supabase.co/project/project-id`

2. **Missing tables:**
   - Run database migrations if tables don't exist
   - Check `supabase_schema.sql` for table definitions

3. **RLS Policies:**
   - Ensure Row Level Security is enabled
   - Check `organisation_members` table has proper policies

## ✅ **Success Checklist**

- [ ] Supabase credentials obtained
- [ ] Environment variables added to Vercel
- [ ] Application redeployed
- [ ] Can sign in successfully
- [ ] Dashboard loads with data
- [ ] AI assist works on all pages
- [ ] Studio page accessible

## 📞 **Need Help?**

If you're still having issues:

1. **Share error messages** from browser console
2. **Check Vercel deployment logs**
3. **Verify Supabase project is active**
4. **Ensure database tables exist**

Once authentication is fixed, the other issues (dashboard, AI assist, studio) should resolve automatically since they all depend on proper authentication.

---

**Estimated Time:** 10-15 minutes  
**Difficulty:** Easy  
**Impact:** Critical - fixes all authentication issues