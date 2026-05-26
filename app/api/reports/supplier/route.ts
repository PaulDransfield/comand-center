// app/api/reports/supplier/route.ts — supplier spend report (PDF/Word/PowerPoint).
// GET ?business_id=X&format=pdf|docx|pptx. See lib/reports/serve.ts.
import { NextRequest } from 'next/server'
import { serveReport } from '@/lib/reports/serve'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export function GET(req: NextRequest) { return serveReport(req, 'supplier') }
