/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SWEDISH AUTHENTICATION — BANKID + FREJA EID                        ║
 * ║  Command Center SaaS Platform                                        ║
 * ║                                                                      ║
 * ║  BEFORE YOU READ THIS CODE — READ THIS FIRST:                        ║
 * ║                                                                      ║
 * ║  BankID is NOT a simple OAuth integration. It requires:              ║
 * ║                                                                      ║
 * ║  1. A signed agreement with Finansiell ID-Teknik BID AB              ║
 * ║     Apply at: https://www.bankid.com/en/foretag/anslutning           ║
 * ║     OR use a certified aggregator (see recommendations below)         ║
 * ║                                                                      ║
 * ║  2. A TLS client certificate issued by BankID                        ║
 * ║     Your server must present this cert on every API call              ║
 * ║                                                                      ║
 * ║  3. Business registration in Sweden                                  ║
 * ║     BankID will not issue credentials to non-Swedish entities         ║
 * ║                                                                      ║
 * ║  4. GDPR compliance documentation                                    ║
 * ║     Processing personnummer requires explicit legal basis             ║
 * ║                                                                      ║
 * ║  RECOMMENDED AGGREGATORS (simplest path to launch):                  ║
 * ║                                                                      ║
 * ║  → Signicat (signicat.com) — most established, REST API              ║
 * ║  → Freja eID+ (frejaeid.com) — also includes their own eID           ║
 * ║  → Veriam (veriam.com) — SaaS-focused                                ║
 * ║  → BankID via Supabase Auth (supabase.com/partners) — check if       ║
 * ║    a partner has built a Supabase BankID provider                     ║
 * ║                                                                      ║
 * ║  This code implements the DIRECT BankID API (v6.0) AND               ║
 * ║  a Signicat-based implementation so you can choose which path.        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * File locations in your Next.js project:
 *   lib/bankid/bankid-direct.js      — Direct BankID API client
 *   lib/bankid/bankid-signicat.js    — Signicat aggregator client
 *   pages/api/auth/bankid/auth.js    — Start authentication
 *   pages/api/auth/bankid/collect.js — Poll for completion
 *   pages/api/auth/bankid/cancel.js  — Cancel authentication
 */

// ══════════════════════════════════════════════════════════════════════════
// PART 1: DIRECT BANKID API CLIENT (lib/bankid/bankid-direct.js)
// Use this if you have a direct agreement with BankID issuer.
// You need: client certificate (.p12 file), CA certificate, and API key.
// ══════════════════════════════════════════════════════════════════════════

import https from 'https';
import fs   from 'fs';
import fetch from 'node-fetch';

// BankID API endpoints
const BANKID_ENDPOINTS = {
  test: 'https://appapi2.test.bankid.com/rp/v6.0',   // test environment
  prod: 'https://appapi2.bankid.com/rp/v6.0',         // production
};

/**
 * BankIDClient
 * Wraps the BankID Relying Party API v6.0.
 * Documentation: https://www.bankid.com/assets/bankid/rp/bankid-relying-party-guidelines-v3.6.pdf
 */
export class BankIDClient {
  constructor() {
    const isProd = process.env.BANKID_ENVIRONMENT === 'production';
    this.baseUrl = isProd ? BANKID_ENDPOINTS.prod : BANKID_ENDPOINTS.test;

    // TLS mutual authentication — required by BankID
    // BankID issues you a .p12 certificate file
    this.agent = new https.Agent({
      pfx:        fs.readFileSync(process.env.BANKID_CERT_PATH),
      passphrase: process.env.BANKID_CERT_PASSPHRASE,
      ca:         fs.readFileSync(process.env.BANKID_CA_CERT_PATH),
    });
  }

  async request(endpoint, body) {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method:  'POST',
      agent:   this.agent,
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new BankIDError(data.errorCode, data.details, res.status);
    }

    return data;
  }

  /**
   * auth(endUserIp, personalNumber?)
   * Starts a BankID authentication.
   *
   * endUserIp:      Required. The user's IP address.
   * personalNumber: Optional. If provided, only that person can authenticate.
   *                 If omitted, any BankID user can authenticate (QR code flow).
   *
   * Returns: { orderRef, autoStartToken, qrStartToken, qrStartSecret }
   */
  async auth(endUserIp, personalNumber = null) {
    const body = {
      endUserIp,
      requirement: {
        allowFingerprint: true,   // allow Touch ID / Face ID
        pinCode:          false,  // don't require PIN if biometrics available
      },
    };

    // If personalNumber provided, restrict to that specific person
    // ONLY use this if the user has already entered their personnummer
    if (personalNumber) {
      body.personalNumber = normalisePersonnummer(personalNumber);
    }

    return this.request('/auth', body);
  }

  /**
   * collect(orderRef)
   * Poll this every 2 seconds after calling auth().
   * Returns status: pending | complete | failed
   *
   * On complete: response.completionData contains the user's identity
   */
  async collect(orderRef) {
    return this.request('/collect', { orderRef });
  }

  /**
   * cancel(orderRef)
   * Cancels an outstanding authentication order.
   * Always call this if the user navigates away or times out.
   */
  async cancel(orderRef) {
    return this.request('/cancel', { orderRef });
  }

  /**
   * generateQRCode(qrStartToken, qrStartSecret, elapsedSeconds)
   * Generate the animated QR code data (update every second).
   * The QR code changes every second — this is a BankID security requirement.
   */
  generateQRCode(qrStartToken, qrStartSecret, elapsedSeconds) {
    const crypto = require('crypto');
    const qrAuthCode = crypto
      .createHmac('sha256', qrStartSecret)
      .update(String(elapsedSeconds))
      .digest('hex');
    return `bankid.${qrStartToken}.${elapsedSeconds}.${qrAuthCode}`;
  }
}

/**
 * normalisePersonnummer(input)
 * Accepts: 19901231-1234, 9012311234, 199012311234
 * Returns: 199012311234 (12-digit format required by BankID)
 */
function normalisePersonnummer(input) {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) {
    // Determine century: if year > current year's last 2 digits, assume 19xx, else 20xx
    const year = parseInt(digits.substring(0, 2));
    const currentYear = new Date().getFullYear() % 100;
    const century = year > currentYear ? '19' : '20';
    return century + digits;
  }
  if (digits.length === 12) return digits;
  throw new Error(`Invalid personnummer format: ${input}`);
}

/**
 * validatePersonnummer(pnr)
 * Validates a Swedish personnummer using the Luhn algorithm.
 * Returns true if valid.
 */
export function validatePersonnummer(pnr) {
  const digits = normalisePersonnummer(pnr).substring(2); // 10 digits
  if (digits.length !== 10) return false;

  // Luhn check on the last 10 digits
  const nums = digits.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = nums[i] * (i % 2 === 0 ? 2 : 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === nums[9];
}

class BankIDError extends Error {
  constructor(code, details, status) {
    super(`BankID error ${code}: ${details}`);
    this.code    = code;
    this.details = details;
    this.status  = status;
  }
}


// ══════════════════════════════════════════════════════════════════════════
// PART 2: SIGNICAT AGGREGATOR CLIENT (lib/bankid/bankid-signicat.js)
// Use this if you go through Signicat instead of direct BankID.
// Much simpler — no certificates, just API keys.
// Signicat handles the BankID relationship for you.
// ══════════════════════════════════════════════════════════════════════════

export class SignicatBankIDClient {
  constructor() {
    this.baseUrl  = 'https://api.signicat.com/auth/open/connect';
    this.clientId = process.env.SIGNICAT_CLIENT_ID;
    this.secret   = process.env.SIGNICAT_CLIENT_SECRET;
    this.domain   = process.env.SIGNICAT_DOMAIN; // yourapp.signicat.io
  }

  /**
   * getAuthUrl(state, redirectUri)
   * Returns the URL to redirect the user to for BankID authentication.
   * This is standard OAuth2 PKCE flow — much simpler than direct BankID.
   */
  getAuthUrl(state, redirectUri) {
    const params = new URLSearchParams({
      response_type:         'code',
      client_id:             this.clientId,
      redirect_uri:          redirectUri,
      scope:                 'openid profile signicat.national_id',
      acr_values:            'urn:signicat:oidc:method:sbid',  // Swedish BankID
      state,
      nonce:                 crypto.randomUUID(),
      ui_locales:            'sv',   // Swedish language in BankID UI
    });
    return `https://${this.domain}/auth/open/connect/authorize?${params}`;
  }

  /**
   * exchangeCode(code, redirectUri)
   * Exchange the OAuth code for tokens and user identity.
   * Call this in your /api/auth/callback endpoint.
   */
  async exchangeCode(code, redirectUri) {
    const res = await fetch(`${this.baseUrl}/token`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${this.clientId}:${this.secret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Signicat token exchange failed: ${err}`);
    }

    const tokens = await res.json();

    // Decode the ID token to get user identity
    // In production: verify the JWT signature using Signicat's JWKS endpoint
    const idToken = parseJWT(tokens.id_token);

    return {
      personnummer:   idToken['signicat.national_id'],  // Swedish personnummer
      name:           idToken.name,
      given_name:     idToken.given_name,
      family_name:    idToken.family_name,
      access_token:   tokens.access_token,
      id_token:       tokens.id_token,
    };
  }
}

function parseJWT(token) {
  const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
}


// ══════════════════════════════════════════════════════════════════════════
// PART 3: API ROUTES
// ══════════════════════════════════════════════════════════════════════════

// ── pages/api/auth/bankid/auth.js ──────────────────────────────────────────
// Starts a BankID authentication session (direct API approach)

import { BankIDClient } from '@/lib/bankid/bankid-direct';
import { createClient } from '@supabase/supabase-js';

const bankid   = new BankIDClient();
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function startBankIDAuth(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Get user's real IP (important: BankID requires the ACTUAL end-user IP)
  const endUserIp = req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.headers['x-real-ip']
    || req.socket.remoteAddress
    || '127.0.0.1';

  // Optionally accept a personnummer if the user entered it
  const { personalNumber } = req.body;

  try {
    const order = await bankid.auth(endUserIp, personalNumber || null);

    // Store the order in a temporary session (Redis or Supabase)
    await supabase.from('bankid_sessions').insert({
      order_ref:       order.orderRef,
      qr_start_token:  order.qrStartToken,
      qr_start_secret: order.qrStartSecret,
      ip_address:      endUserIp,
      created_at:      new Date().toISOString(),
      expires_at:      new Date(Date.now() + 3 * 60000).toISOString(), // 3 min timeout
    });

    res.json({
      orderRef:        order.orderRef,
      autoStartToken:  order.autoStartToken,   // for mobile deep link
      qrStartToken:    order.qrStartToken,     // for QR code generation
      qrStartSecret:   order.qrStartSecret,
    });

  } catch (err) {
    console.error('BankID auth error:', err);
    res.status(500).json({ error: err.message });
  }
}


// ── pages/api/auth/bankid/collect.js ──────────────────────────────────────
// Poll for authentication status. Frontend calls this every 2 seconds.

export default async function collectBankIDAuth(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { orderRef } = req.body;
  if (!orderRef) return res.status(400).json({ error: 'orderRef required' });

  try {
    const result = await bankid.collect(orderRef);

    if (result.status === 'complete') {
      const { completionData } = result;
      const personnummer = completionData.user.personalNumber;  // 12-digit
      const name         = completionData.user.name;
      const givenName    = completionData.user.givenName;
      const surname      = completionData.user.surname;

      // Find or create user account
      const authResult = await findOrCreateUserByBankID({
        personnummer,
        name,
        givenName,
        surname,
        signature:   completionData.signature,   // cryptographic proof
        ocspResponse:completionData.ocspResponse,
      });

      // Clean up the session
      await supabase.from('bankid_sessions').delete().eq('order_ref', orderRef);

      // Create a Supabase session for the user
      // NOTE: This requires a custom auth approach since Supabase doesn't
      // natively support BankID. Use admin API to create a session.
      const { data: sessionData } = await supabase.auth.admin.generateLink({
        type:       'magiclink',
        email:      authResult.email,
        options:    { redirectTo: process.env.NEXT_PUBLIC_APP_URL + '/dashboard' },
      });

      return res.json({
        status:       'complete',
        sessionToken: sessionData?.properties?.hashed_token,
        user:         {
          id:          authResult.id,
          name,
          email:       authResult.email,
          isNewUser:   authResult.isNewUser,
        },
      });
    }

    if (result.status === 'failed') {
      await supabase.from('bankid_sessions').delete().eq('order_ref', orderRef);
      return res.json({
        status:      'failed',
        hintCode:    result.hintCode,
        message:     getBankIDMessage(result.hintCode),
      });
    }

    // Still pending — return hint code for UI feedback
    return res.json({
      status:    result.status,   // 'pending'
      hintCode:  result.hintCode, // e.g. 'outstandingTransaction', 'userSign'
      message:   getBankIDMessage(result.hintCode),
    });

  } catch (err) {
    console.error('BankID collect error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * findOrCreateUserByBankID
 * Looks up an existing user by personnummer, or creates a new account.
 * This is where BankID identity links to your user database.
 */
async function findOrCreateUserByBankID({ personnummer, name, givenName, surname }) {
  // Check if user already exists with this personnummer
  const { data: existing } = await supabase
    .from('users')
    .select('id, email')
    .eq('personnummer_hash', hashPersonnummer(personnummer))
    .maybeSingle();

  if (existing) {
    // Update last BankID login time
    await supabase.from('users').update({ last_bankid_login: new Date().toISOString() }).eq('id', existing.id);
    return { ...existing, isNewUser: false };
  }

  // New user — create account
  // We don't have an email yet — the user will need to provide one
  // Generate a placeholder email using a hash of the personnummer
  // The user MUST verify/add their real email during onboarding
  const placeholderEmail = `bankid.${hashPersonnummer(personnummer).substring(0, 12)}@pending.commandcenter.se`;

  const { data: newAuthUser } = await supabase.auth.admin.createUser({
    email:             placeholderEmail,
    email_confirm:     true,
    user_metadata:     { full_name: name, auth_method: 'bankid' },
  });

  const { data: newUser } = await supabase.from('users').insert({
    id:                 newAuthUser.user.id,
    email:              placeholderEmail,
    full_name:          name,
    given_name:         givenName,
    family_name:        surname,
    personnummer_hash:  hashPersonnummer(personnummer),  // NEVER store plain personnummer
    auth_methods:       ['bankid'],
    email_verified:     false,   // must add real email
    created_at:         new Date().toISOString(),
  }).select().single();

  return { ...newUser, isNewUser: true };
}

/**
 * hashPersonnummer
 * NEVER store personnummer in plain text. Use HMAC-SHA256 with a server secret.
 * This lets you look up users by personnummer without storing the actual number.
 */
function hashPersonnummer(pnr) {
  const crypto = require('crypto');
  return crypto
    .createHmac('sha256', process.env.PERSONNUMMER_HMAC_SECRET)
    .update(pnr)
    .digest('hex');
}

/**
 * getBankIDMessage
 * Maps BankID hint codes to human-readable Swedish messages.
 */
function getBankIDMessage(hintCode) {
  const messages = {
    outstandingTransaction: 'Starta BankID-appen och följ instruktionerna.',
    noClient:               'Starta BankID-appen.',
    started:                'Söker efter BankID...',
    userSign:               'Skriv in din säkerhetskod i BankID-appen och välj Legitimera.',
    expiredTransaction:     'BankID-sessionen tog för lång tid. Försök igen.',
    certificateErr:         'BankID-certifikatet är ogiltigt. Kontakta din bank.',
    userCancel:             'BankID-inloggningen avbröts.',
    cancelled:              'Inloggningen avbröts.',
    startFailed:            'Kunde inte starta BankID. Försök igen.',
  };
  return messages[hintCode] || 'Vänligen vänta...';
}


// ── pages/api/auth/bankid/cancel.js ───────────────────────────────────────
export default async function cancelBankIDAuth(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { orderRef } = req.body;
  try {
    await bankid.cancel(orderRef);
    await supabase.from('bankid_sessions').delete().eq('order_ref', orderRef);
    res.json({ cancelled: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}


// ── pages/api/auth/callback/signicat.js ────────────────────────────────────
// OAuth callback for Signicat/Freja path

import { SignicatBankIDClient } from '@/lib/bankid/bankid-signicat';

const signicat = new SignicatBankIDClient();

export default async function signicatCallback(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/login?error=${encodeURIComponent(error)}`);
  }

  try {
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback/signicat`;
    const identity    = await signicat.exchangeCode(code, redirectUri);

    // Find or create user (same logic as direct BankID)
    const user = await findOrCreateUserByBankID({
      personnummer: identity.personnummer,
      name:         identity.name,
      givenName:    identity.given_name,
      surname:      identity.family_name,
    });

    // Set session cookie and redirect to dashboard
    res.setHeader('Set-Cookie', `cc_session=${user.id}; HttpOnly; Secure; SameSite=Lax; Path=/`);
    res.redirect(user.isNewUser ? '/onboarding' : '/dashboard');

  } catch (err) {
    console.error('Signicat callback error:', err);
    res.redirect('/login?error=auth_failed');
  }
}
