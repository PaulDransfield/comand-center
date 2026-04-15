/**
 * integration-manager.js
 * lib/integrations/integration-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Central manager for all third-party integrations.
 * Handles storage, retrieval, testing, and token refresh for:
 *   - Fortnox (accounting)
 *   - Ancon, Zettle (POS)
 *   - Caspeco, Personalkollen (scheduling)
 *   - Handelsbanken, SEB (bank — CSV import only for now)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt, encryptObject, decryptObject, maskSecret } from './credential-encryption.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── INTEGRATION DEFINITIONS ──────────────────────────────────────────────────
// Describes every supported integration: what fields it needs,
// how to test the connection, how to refresh tokens.

export const INTEGRATION_DEFINITIONS = {

  fortnox: {
    name:        'Fortnox',
    category:    'accounting',
    description: 'Bokföring, fakturor och ekonomirapporter',
    authType:    'oauth2',
    docsUrl:     'https://developer.fortnox.se',
    fields: [
      { key: 'client_id',     label: 'Client ID',     type: 'text',     required: true,  encrypted: false,
        hint: 'Från Fortnox: Inställningar → Integrationer → API' },
      { key: 'client_secret', label: 'Client Secret', type: 'password', required: true,  encrypted: true,
        hint: 'Skapas tillsammans med Client ID' },
      { key: 'access_token',  label: 'Access Token',  type: 'hidden',   required: false, encrypted: true },
      { key: 'refresh_token', label: 'Refresh Token', type: 'hidden',   required: false, encrypted: true },
      { key: 'expires_at',    label: 'Expires At',    type: 'hidden',   required: false, encrypted: false },
    ],
  },

  ancon: {
    name:        'Ancon',
    category:    'pos',
    description: 'Kassasystem och försäljningsdata',
    authType:    'api_key',
    docsUrl:     'https://ancon.se/api',
    fields: [
      { key: 'api_key',     label: 'API-nyckel',   type: 'password', required: true, encrypted: true,
        hint: 'Hämtas från Ancon-portalen under Inställningar → API' },
      { key: 'location_id', label: 'Plats-ID',     type: 'text',     required: false, encrypted: false,
        hint: 'ID för din restaurang i Ancon (lämna tomt för alla platser)' },
      { key: 'api_url',     label: 'API-endpoint', type: 'text',     required: false, encrypted: false,
        hint: 'Standardvärde: https://api.ancon.se/v1 (ändra ej om du är osäker)' },
    ],
  },

  zettle: {
    name:        'Zettle (PayPal)',
    category:    'pos',
    description: 'Kortbetalningar och försäljningsrapporter',
    authType:    'oauth2',
    docsUrl:     'https://developer.zettle.com',
    fields: [
      { key: 'client_id',     label: 'Client ID',     type: 'text',     required: true,  encrypted: false,
        hint: 'Från Zettle Developer Portal' },
      { key: 'client_secret', label: 'Client Secret', type: 'password', required: true,  encrypted: true },
      { key: 'access_token',  label: 'Access Token',  type: 'hidden',   required: false, encrypted: true },
      { key: 'refresh_token', label: 'Refresh Token', type: 'hidden',   required: false, encrypted: true },
    ],
  },

  caspeco: {
    name:        'Caspeco',
    category:    'scheduling',
    description: 'Schemaläggning, arbetstid och personalkostnader',
    authType:    'api_key',
    docsUrl:     'https://developer.caspeco.se',
    fields: [
      { key: 'api_key',       label: 'API-nyckel',    type: 'password', required: true,  encrypted: true,
        hint: 'Hämtas från Caspeco: Administration → Integrationer → API-nycklar' },
      { key: 'company_id',    label: 'Företags-ID',   type: 'text',     required: true,  encrypted: false,
        hint: 'Ditt Caspeco-företags-ID (fråga Caspecos support)' },
      { key: 'unit_ids',      label: 'Enhets-ID:n',   type: 'text',     required: false, encrypted: false,
        hint: 'Kommaseparerade ID:n för enheter (t.ex. 101,102). Lämna tomt för alla.' },
      { key: 'api_version',   label: 'API-version',   type: 'select',   required: false, encrypted: false,
        options: ['v2', 'v3'], default: 'v2',
        hint: 'Välj v2 om du är osäker' },
    ],
  },

  personalkollen: {
    name:        'Personalkollen',
    category:    'scheduling',
    description: 'Tidrapportering, närvaro och löneunderlag',
    authType:    'api_key',
    docsUrl:     'https://personalkollen.se/api-dokumentation',
    fields: [
      { key: 'api_key',      label: 'API-nyckel',   type: 'password', required: true,  encrypted: true,
        hint: 'Hämtas från Personalkollen: Inställningar → Integrationer → API-nyckel' },
      { key: 'account_id',   label: 'Konto-ID',     type: 'text',     required: true,  encrypted: false,
        hint: 'Ditt kontots ID i Personalkollen' },
      { key: 'cost_centers', label: 'Kostnadsställen', type: 'text',  required: false, encrypted: false,
        hint: 'Filtrera på specifika kostnadsställen (valfritt)' },
    ],
  },

  handelsbanken: {
    name:        'Handelsbanken',
    category:    'bank',
    description: 'Bankutdrag och transaktioner (CSV-import)',
    authType:    'csv_import',
    docsUrl:     null,
    fields: [
      { key: 'account_number', label: 'Kontonummer', type: 'text', required: false, encrypted: false,
        hint: 'IBAN eller kontonummer för matchning' },
      { key: 'import_format',  label: 'Format',      type: 'select', required: true, encrypted: false,
        options: ['handelsbanken_se', 'seb_se', 'swedbank_se', 'nordea_se'],
        default: 'handelsbanken_se',
        hint: 'Välj bankformat för automatisk tolkning av CSV' },
    ],
  },

};

// ── CRUD: SAVE INTEGRATION ────────────────────────────────────────────────────

/**
 * saveIntegration(businessId, orgId, provider, credentials)
 * Encrypts sensitive fields and saves to database.
 * Safe to call for both create and update.
 */
export async function saveIntegration(businessId, orgId, provider, credentials) {
  const def = INTEGRATION_DEFINITIONS[provider];
  if (!def) throw new Error(`Unknown integration provider: ${provider}`);

  // Separate encrypted and plain fields
  const plainFields     = {};
  const encryptedFields = {};

  for (const field of def.fields) {
    if (field.type === 'hidden') continue;         // skip — set by OAuth flow
    const val = credentials[field.key];
    if (val === undefined || val === '') continue; // skip empty fields

    if (field.encrypted) {
      encryptedFields[field.key] = encrypt(val);
    } else {
      plainFields[field.key] = val;
    }
  }

  const { data, error } = await supabase
    .from('integrations')
    .upsert({
      org_id:          orgId,
      business_id:     businessId,
      provider,
      status:          'pending',          // will be updated after test
      // Store encrypted credentials as JSON
      credentials_enc: JSON.stringify(encryptedFields),
      config:          plainFields,         // non-sensitive config stored plain
      updated_at:      new Date().toISOString(),
    }, {
      onConflict: 'business_id,provider',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to save integration: ${error.message}`);

  // Test the connection immediately after saving
  const testResult = await testConnection(data.id, provider);
  return { integration: data, test: testResult };
}

/**
 * getIntegration(businessId, provider)
 * Returns decrypted credentials for server-side use.
 * NEVER call this from the frontend — server only.
 */
export async function getIntegration(businessId, provider) {
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('business_id', businessId)
    .eq('provider', provider)
    .maybeSingle();

  if (error || !data) return null;

  // Decrypt sensitive fields
  let decrypted = {};
  if (data.credentials_enc) {
    const enc = JSON.parse(data.credentials_enc);
    for (const [key, val] of Object.entries(enc)) {
      decrypted[key] = val ? decrypt(val) : null;
    }
  }

  return {
    ...data,
    credentials: { ...data.config, ...decrypted },  // merged plain + decrypted
  };
}

/**
 * getIntegrationForUI(businessId, provider)
 * Returns MASKED credentials safe to send to the frontend.
 * Password fields are replaced with masked versions.
 */
export async function getIntegrationForUI(businessId, provider) {
  const integration = await getIntegration(businessId, provider);
  if (!integration) return null;

  const def     = INTEGRATION_DEFINITIONS[provider];
  const masked  = { ...integration.credentials };

  // Mask any encrypted/password fields
  for (const field of def.fields) {
    if (field.encrypted && masked[field.key]) {
      masked[field.key] = maskSecret(masked[field.key]);
    }
  }

  return { ...integration, credentials: masked };
}

/**
 * getAllIntegrationsForBusiness(businessId)
 * Returns status + masked config for all integrations (for the dashboard cards).
 */
export async function getAllIntegrationsForBusiness(businessId) {
  const { data, error } = await supabase
    .from('integrations')
    .select('id, provider, status, last_sync_at, last_error, config, updated_at')
    .eq('business_id', businessId);

  if (error) return [];

  // Add definition metadata to each
  return (data || []).map(row => ({
    ...row,
    definition: INTEGRATION_DEFINITIONS[row.provider] || null,
    isConnected: row.status === 'connected',
    hasError:    row.status === 'error',
  }));
}

// ── CONNECTION TESTER ─────────────────────────────────────────────────────────

/**
 * testConnection(integrationId, provider)
 * Tests a stored integration by making a real API call.
 * Updates the status in the database.
 * Returns { success, message, details }
 */
export async function testConnection(integrationId, provider) {
  const { data: row } = await supabase
    .from('integrations')
    .select('*, business_id')
    .eq('id', integrationId)
    .single();

  if (!row) return { success: false, message: 'Integration not found' };

  const integration = await getIntegration(row.business_id, provider);
  if (!integration?.credentials) return { success: false, message: 'No credentials stored' };

  let result;
  try {
    switch (provider) {
      case 'fortnox':        result = await testFortnox(integration.credentials);        break;
      case 'ancon':          result = await testAncon(integration.credentials);          break;
      case 'zettle':         result = await testZettle(integration.credentials);         break;
      case 'caspeco':        result = await testCaspeco(integration.credentials);        break;
      case 'personalkollen': result = await testPersonalkollen(integration.credentials); break;
      case 'handelsbanken':  result = { success: true, message: 'CSV import ready' };   break;
      default:               result = { success: false, message: `No test for ${provider}` };
    }
  } catch (err) {
    result = { success: false, message: err.message };
  }

  // Update status in DB
  await supabase.from('integrations').update({
    status:       result.success ? 'connected' : 'error',
    last_error:   result.success ? null : result.message,
    updated_at:   new Date().toISOString(),
  }).eq('id', integrationId);

  return result;
}

// ── INDIVIDUAL CONNECTION TESTERS ─────────────────────────────────────────────

async function testFortnox(creds) {
  if (!creds.access_token) {
    // Check if we at least have client_id (OAuth not yet completed)
    if (creds.client_id) return { success: false, message: 'OAuth-flöde ej slutfört — klicka Anslut Fortnox', needsOAuth: true };
    return { success: false, message: 'Inga credentials lagrade' };
  }

  // Check token expiry
  if (creds.expires_at && new Date(creds.expires_at) < new Date()) {
    const refreshed = await refreshFortnoxToken(creds);
    if (!refreshed.success) return refreshed;
  }

  // Test with a lightweight API call — get company info
  const res = await fetch('https://api.fortnox.se/3/companyinformation', {
    headers: {
      'Authorization': `Bearer ${creds.access_token}`,
      'Accept':        'application/json',
    },
  });

  if (res.status === 401) return { success: false, message: 'Fortnox-token ogiltig — behöver återkopplas', needsOAuth: true };
  if (!res.ok)            return { success: false, message: `Fortnox API-fel ${res.status}` };

  const data = await res.json();
  return {
    success: true,
    message: `Ansluten till ${data.CompanyInformation?.CompanyName || 'Fortnox'}`,
    details: { company: data.CompanyInformation?.CompanyName, org_nr: data.CompanyInformation?.OrganizationNumber },
  };
}

async function testAncon(creds) {
  if (!creds.api_key) return { success: false, message: 'API-nyckel saknas' };

  const baseUrl = creds.api_url || 'https://api.ancon.se/v1';
  const res = await fetch(`${baseUrl}/health`, {
    headers: { 'X-API-Key': creds.api_key, 'Accept': 'application/json' },
  });

  if (res.status === 401) return { success: false, message: 'Ogiltig API-nyckel — kontrollera i Ancon-portalen' };
  if (res.status === 404) {
    // Try alternative endpoint — Ancon may not have /health
    const res2 = await fetch(`${baseUrl}/locations`, {
      headers: { 'X-API-Key': creds.api_key },
    });
    if (!res2.ok) return { success: false, message: `Ancon API svarade ej (${res2.status})` };
    const data = await res2.json();
    return { success: true, message: `Ancon ansluten — ${data.length || 0} platser` };
  }
  if (!res.ok) return { success: false, message: `Ancon API-fel ${res.status}` };

  return { success: true, message: 'Ancon ansluten' };
}

async function testZettle(creds) {
  if (!creds.access_token) return { success: false, message: 'OAuth ej slutfört', needsOAuth: true };

  const res = await fetch('https://oauth.zettle.com/users/me', {
    headers: { 'Authorization': `Bearer ${creds.access_token}` },
  });

  if (res.status === 401) return { success: false, message: 'Zettle-token utgången — behöver återkopplas', needsOAuth: true };
  if (!res.ok)            return { success: false, message: `Zettle API-fel ${res.status}` };

  const data = await res.json();
  return { success: true, message: `Zettle ansluten — ${data.name || data.email}` };
}

async function testCaspeco(creds) {
  if (!creds.api_key)    return { success: false, message: 'API-nyckel saknas' };
  if (!creds.company_id) return { success: false, message: 'Företags-ID saknas' };

  const version = creds.api_version || 'v2';
  const res = await fetch(`https://api.caspeco.se/${version}/companies/${creds.company_id}`, {
    headers: {
      'Authorization': `Bearer ${creds.api_key}`,
      'Accept':        'application/json',
    },
  });

  if (res.status === 401) return { success: false, message: 'Ogiltig API-nyckel — kontrollera i Caspeco Administration' };
  if (res.status === 403) return { success: false, message: 'Åtkomst nekad — API-nyckeln saknar behörigheter' };
  if (res.status === 404) return { success: false, message: `Företag ${creds.company_id} hittades ej` };
  if (!res.ok)            return { success: false, message: `Caspeco API-fel ${res.status}` };

  const data = await res.json();
  return { success: true, message: `Caspeco ansluten — ${data.name || creds.company_id}`, details: data };
}

async function testPersonalkollen(creds) {
  if (!creds.api_key)    return { success: false, message: 'API-nyckel saknas' };
  if (!creds.account_id) return { success: false, message: 'Konto-ID saknas' };

  const res = await fetch(`https://api.personalkollen.se/v1/accounts/${creds.account_id}`, {
    headers: {
      'X-API-Key': creds.api_key,
      'Accept':    'application/json',
    },
  });

  if (res.status === 401) return { success: false, message: 'Ogiltig API-nyckel' };
  if (res.status === 404) return { success: false, message: `Konto ${creds.account_id} hittades ej` };
  if (!res.ok)            return { success: false, message: `Personalkollen API-fel ${res.status}` };

  const data = await res.json();
  return { success: true, message: `Personalkollen ansluten — ${data.name || creds.account_id}` };
}

// ── TOKEN REFRESH ─────────────────────────────────────────────────────────────

export async function refreshFortnoxToken(creds) {
  if (!creds.refresh_token) return { success: false, message: 'No refresh token — needs full re-auth' };

  const res = await fetch('https://apps.fortnox.se/oauth-v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: creds.refresh_token,
      client_id:     creds.client_id,
      client_secret: creds.client_secret,
    }),
  });

  if (!res.ok) return { success: false, message: 'Fortnox refresh failed — needs re-auth', needsOAuth: true };

  const tokens = await res.json();
  return {
    success:       true,
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
}

// ── DATA FETCHERS (used by the tracker/dashboard) ─────────────────────────────

/**
 * fetchFortnoxFinancials(businessId, year, month)
 * Pulls vouchers from Fortnox and returns categorised financial data.
 */
export async function fetchFortnoxFinancials(businessId, year, month) {
  const integration = await getIntegration(businessId, 'fortnox');
  if (!integration?.credentials?.access_token) {
    throw new Error('Fortnox not connected');
  }

  const { access_token } = integration.credentials;
  const dateFrom = `${year}-${String(month).padStart(2,'0')}-01`;
  const dateTo   = new Date(year, month, 0).toISOString().split('T')[0]; // last day of month

  const res = await fetch(
    `https://api.fortnox.se/3/vouchers?fromdate=${dateFrom}&todate=${dateTo}&limit=500`,
    { headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' } }
  );

  if (!res.ok) throw new Error(`Fortnox API error: ${res.status}`);

  const data     = await res.json();
  const vouchers = data.Vouchers || [];

  // Map BAS accounts to cost categories
  const totals = { revenue: 0, staff: 0, food: 0, rent: 0, other: 0 };
  for (const voucher of vouchers) {
    for (const row of (voucher.VoucherRows || [])) {
      const account = parseInt(row.Account);
      const amount  = parseFloat(row.Debit) - parseFloat(row.Credit);
      if      (account >= 3000 && account <= 3999) totals.revenue += amount;
      else if (account >= 4000 && account <= 4999) totals.food    -= amount;
      else if (account >= 5000 && account <= 5999) totals.rent    -= amount;
      else if (account >= 7000 && account <= 7699) totals.staff   -= amount;
      else if (account >= 5000 && account <= 7999) totals.other   -= amount;
    }
  }

  return totals;
}

/**
 * fetchCaspecoLaborCosts(businessId, year, month)
 * Pulls actual labor costs from Caspeco for a given month.
 */
export async function fetchCaspecoLaborCosts(businessId, year, month) {
  const integration = await getIntegration(businessId, 'caspeco');
  if (!integration?.credentials?.api_key) throw new Error('Caspeco not connected');

  const { api_key, company_id, api_version = 'v2' } = integration.credentials;
  const dateFrom = `${year}-${String(month).padStart(2,'0')}-01`;
  const dateTo   = new Date(year, month, 0).toISOString().split('T')[0];

  const res = await fetch(
    `https://api.caspeco.se/${api_version}/companies/${company_id}/payroll?from=${dateFrom}&to=${dateTo}`,
    { headers: { 'Authorization': `Bearer ${api_key}`, 'Accept': 'application/json' } }
  );

  if (!res.ok) throw new Error(`Caspeco API error: ${res.status}`);

  const data = await res.json();
  return {
    total_labor_cost:     data.totalCost || 0,
    total_hours:          data.totalHours || 0,
    employee_count:       data.employeeCount || 0,
    average_hourly_cost:  data.averageHourlyCost || 0,
  };
}
