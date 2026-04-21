// app/api/invoices/extract/route.ts
// Claude Vision extracts invoice details from a PDF or image
// Returns: vendor, amount, vat_amount, due_date, invoice_date, invoice_number, category

import { NextRequest, NextResponse } from 'next/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { getRequestAuth }        from '@/lib/supabase/server'
import { rateLimit }             from '@/lib/middleware/rate-limit'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
// Claude Vision on a large PDF/image can push past 60 s. Declare the
// ceiling explicitly so the route behaves identically on Hobby and Pro.
export const maxDuration = 300

const CATEGORIES = [
  'food_beverage','alcohol','staff','rent','cleaning',
  'repairs','marketing','utilities','admin','other'
]

export async function POST(req: NextRequest) {
  // Auth — this route calls Claude Vision (cost) and writes to Supabase Storage.
  // Without auth, anyone can trigger spend + upload files into the shared bucket.
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Per-user rate limit: 10 extractions per hour. Claude Vision is expensive.
  const gate = rateLimit(auth.userId, { windowMs: 60 * 60_000, max: 10 })
  if (!gate.allowed) return NextResponse.json({ error: 'Too many extractions — try later' }, { status: 429 })

  let formData: FormData
  try { formData = await req.formData() }
  catch { return NextResponse.json({ error: 'Invalid form data' }, { status: 400 }) }

  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const allowed = ['pdf', 'jpg', 'jpeg', 'png', 'webp']
  if (!allowed.includes(ext)) {
    return NextResponse.json({ error: 'Only PDF and images supported' }, { status: 400 })
  }

  try {
    const buffer  = Buffer.from(await file.arrayBuffer())
    const base64  = buffer.toString('base64')
    const isPdf   = ext === 'pdf'

    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const prompt = `You are extracting invoice data from a Swedish supplier invoice.

Extract ALL fields including every individual line item and return ONLY valid JSON with no other text:
{
  "vendor": "company name of the supplier",
  "invoice_number": "invoice/faktura number or null",
  "invoice_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD — look for 'förfallodatum', 'betalas senast', 'due date' or null",
  "amount": number in SEK excluding VAT (look for 'exkl moms', 'netto belopp', sum of all line items ex VAT),
  "vat_amount": number VAT amount in SEK (look for 'moms', 'mervärdesskatt'),
  "total_amount": number total including VAT,
  "category": one of: ${CATEGORIES.join(', ')} — based on what the vendor sells,
  "description": "brief description of what was purchased or null",
  "line_items": [
    {
      "description": "product name and details e.g. Kycklingfile 2kg",
      "quantity": number or null,
      "unit": "kg/st/l/förp or null",
      "unit_price": number ex VAT or null,
      "amount": number total for this line ex VAT,
      "vat_rate": number e.g. 12 or 25 or null
    }
  ]
}

Rules:
- Extract EVERY line item on the invoice — do not summarise or skip any
- All amounts must be numbers without currency symbols or spaces
- Dates must be YYYY-MM-DD format
- If a field cannot be found, use null
- line_items should be an empty array [] if no line items are visible
- For category: food suppliers = food_beverage, alcohol suppliers = alcohol, cleaning companies = cleaning, staffing agencies = staff, landlords = rent, utility companies = utilities, marketing agencies = marketing
- Return ONLY the JSON object, no markdown, no explanation`

    const content: any[] = [
      isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image',    source: { type: 'base64', media_type: `image/${ext === 'jpg' ? 'jpeg' : ext}`, data: base64 } },
      { type: 'text', text: prompt },
    ]

    const response = await client.messages.create({
      model:      AI_MODELS.AGENT,
      max_tokens: MAX_TOKENS.ASSISTANT,
      messages:   [{ role: 'user', content }],
    })

    const text = response.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim()

    // Parse JSON — strip any accidental markdown
    let clean = text.replace(/```json|```/g, '').trim()

    // If JSON was truncated, try to recover by closing open structures
    if (!clean.endsWith('}')) {
      // Find last complete line_item entry and close the JSON
      const lastBrace = clean.lastIndexOf('}')
      if (lastBrace > 0) {
        clean = clean.slice(0, lastBrace + 1)
        // Close any open arrays/objects
        const opens  = (clean.match(/\[/g) ?? []).length
        const closes = (clean.match(/\]/g) ?? []).length
        if (opens > closes) clean += ']}'
        else if (!clean.endsWith('}')) clean += '}'
      }
    }

    let parsed: any
    try {
      parsed = JSON.parse(clean)
    } catch {
      // Last resort: extract just the top-level fields without line_items
      const vendorMatch  = clean.match(/"vendor"\s*:\s*"([^"]+)"/)
      const amountMatch  = clean.match(/"amount"\s*:\s*([\d.]+)/)
      const dueDateMatch = clean.match(/"due_date"\s*:\s*"([^"]+)"/)
      const invNumMatch  = clean.match(/"invoice_number"\s*:\s*"([^"]+)"/)
      parsed = {
        vendor:         vendorMatch?.[1]  ?? null,
        amount:         amountMatch  ? parseFloat(amountMatch[1]) : null,
        due_date:       dueDateMatch?.[1] ?? null,
        invoice_number: invNumMatch?.[1]  ?? null,
        line_items:     [],
      }
    }

    // Validate and clean
    const result: Record<string, any> = {}
    if (parsed.vendor)         result.vendor         = String(parsed.vendor).trim()
    if (parsed.invoice_number) result.invoice_number = String(parsed.invoice_number).trim()
    if (parsed.invoice_date)   result.invoice_date   = parsed.invoice_date
    if (parsed.due_date)       result.due_date       = parsed.due_date
    if (parsed.amount != null) result.amount         = Math.abs(Number(parsed.amount))
    if (parsed.vat_amount != null) result.vat_amount = Math.abs(Number(parsed.vat_amount))
    if (parsed.category && CATEGORIES.includes(parsed.category)) result.category = parsed.category
    if (parsed.description)    result.description    = String(parsed.description).trim()

    // Line items
    if (Array.isArray(parsed.line_items) && parsed.line_items.length > 0) {
      result.line_items = parsed.line_items.map((item: any) => ({
        description: String(item.description ?? '').trim(),
        quantity:    item.quantity != null ? Number(item.quantity) : null,
        unit:        item.unit ? String(item.unit).trim() : null,
        unit_price:  item.unit_price != null ? Math.abs(Number(item.unit_price)) : null,
        amount:      item.amount != null ? Math.abs(Number(item.amount)) : null,
        vat_rate:    item.vat_rate != null ? Number(item.vat_rate) : null,
      }))
    } else {
      result.line_items = []
    }

    // Upload file to Supabase Storage so it can be viewed later
    try {
      const { createAdminClient } = await import('@/lib/supabase/server')
      const db       = createAdminClient()
      const ext      = file.name.split('.').pop()?.toLowerCase() ?? 'pdf'
      // Prefix with org_id so uploads can't be enumerated across tenants.
      const filename = `invoices/${auth.orgId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`

      const { data: upload, error: uploadError } = await db.storage
        .from('documents')
        .upload(filename, buffer, { contentType: file.type, upsert: false })

      if (!uploadError && upload) {
        const { data: { publicUrl } } = db.storage.from('documents').getPublicUrl(filename)
        result.file_url = publicUrl
      }
    } catch (uploadErr: any) {
      console.warn('File upload failed (continuing without):', uploadErr.message)
    }

    return NextResponse.json(result)
  } catch (err: any) {
    console.error('Invoice extraction error:', err.message)
    return NextResponse.json({ error: 'Extraction failed: ' + err.message }, { status: 500 })
  }
}
