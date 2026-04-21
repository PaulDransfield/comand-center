'use client'
// @ts-nocheck
// app/overheads/page.tsx
//
// The /overheads route is the end-to-end home for Fortnox PDF ingestion:
// bulk upload → auto-extract with Sonnet → review modal → apply.  Once
// applied, the data flows into tracker_data + tracker_line_items so the
// existing /tracker and the new overheads breakdown (next commit) light
// up.

export const dynamic = 'force-dynamic'

import { useEffect, useRef, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import PageHero from '@/components/ui/PageHero'
import StatusPill from '@/components/ui/StatusPill'
import TopBar from '@/components/ui/TopBar'
import AttentionPanel from '@/components/ui/AttentionPanel'
import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import { createClient as createSupabaseBrowser } from '@/lib/supabase/client'

interface Business { id: string; name: string; city: string | null }
interface ExtractionJob {
  status:        string
  attempts:      number
  max_attempts:  number
  scheduled_for: string | null
  progress:      { phase?: string; message?: string; percent?: number } | null
  error_message: string | null
}
interface Upload {
  id:                string
  business_id:       string
  doc_type:          string
  period_year:       number | null
  period_month:      number | null
  pdf_filename:      string
  pdf_size_bytes:    number | null
  status:            string
  error_message:     string | null
  extracted_at:      string | null
  applied_at:        string | null
  created_at:        string
  extracted_json?:   any
  // Embedded 1:1 via the unique foreign key. Supabase returns an array
  // when the FK target is non-unique and an object when it's unique —
  // our FK is UNIQUE so we get an object. Typed loosely for safety.
  extraction_jobs?:  ExtractionJob | ExtractionJob[] | null
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function OverheadsPage() {
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [bizId,      setBizId]      = useState<string | null>(null)
  const [uploads,    setUploads]    = useState<Upload[]>([])
  const [loading,    setLoading]    = useState(true)
  const [uploading,  setUploading]  = useState(false)
  const [dragging,   setDragging]   = useState(false)
  const [toast,      setToast]      = useState('')
  const [reviewId,   setReviewId]   = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const saved = localStorage.getItem('cc_selected_biz')
      const id = (saved && data.find(b => b.id === saved)) ? saved : data[0].id
      setBizId(id)
    }).catch(() => {})
    const onStorage = () => {
      const s = localStorage.getItem('cc_selected_biz')
      if (s) setBizId(s)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // initialLoadDone prevents the table from flickering through the
  // "Loading uploads…" placeholder on every 3-second poll while an
  // extraction is in flight. Only the first load shows the spinner;
  // subsequent polls mutate state silently.
  const initialLoadDone = useRef(false)
  const load = useCallback(async () => {
    if (!bizId) return
    if (!initialLoadDone.current) setLoading(true)
    try {
      const r = await fetch(`/api/fortnox/uploads?business_id=${bizId}`, { cache: 'no-store' })
      const j = await r.json()
      if (Array.isArray(j.uploads)) setUploads(j.uploads)
    } catch {}
    initialLoadDone.current = true
    setLoading(false)
  }, [bizId])

  // Reset initialLoadDone when the business switches so the spinner
  // shows once for the new business rather than a flash of the old
  // business's table.
  useEffect(() => { initialLoadDone.current = false; if (bizId) load() }, [bizId, load])

  // Supabase Realtime subscription — pushes row changes as they
  // happen, eliminating the 3s-polling loop we had before. We still
  // keep a safety-net slow poll (every 15s) while something is in
  // flight in case Realtime drops the connection silently.
  useEffect(() => {
    if (!bizId) return
    const sb = createSupabaseBrowser()
    const channel = sb.channel(`fortnox-uploads:${bizId}`)
      .on('postgres_changes', {
        event:  '*',
        schema: 'public',
        table:  'fortnox_uploads',
        filter: `business_id=eq.${bizId}`,
      }, () => { load() })
      .on('postgres_changes', {
        event:  '*',
        schema: 'public',
        table:  'extraction_jobs',
        filter: `business_id=eq.${bizId}`,
      }, () => { load() })
      .subscribe()
    return () => { sb.removeChannel(channel) }
  }, [bizId, load])

  // Safety-net slow poll while extracting — kicks in if Realtime drops.
  // 15s is cheap (1 req/15s/user) and only active while there's work.
  useEffect(() => {
    const extracting = uploads.some(u => u.status === 'extracting' || u.status === 'pending')
    if (!extracting) return
    const t = setInterval(() => load(), 15000)
    return () => clearInterval(t)
  }, [uploads, load])

  // Ticks every second while something is extracting so the status chip
  // can render elapsed seconds ("EXTRACTING · 12s") and the user knows
  // the UI is alive, not stuck.
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    const extracting = uploads.some(u => u.status === 'extracting' || u.status === 'pending')
    if (!extracting) return
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [uploads])

  async function extractOne(uploadId: string) {
    try {
      const r = await fetch('/api/fortnox/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_id: uploadId }),
      })
      // 409 = job already in-flight. Not an error — a worker is
      // already handling it. UI will see the status update when it
      // finishes. Surface a gentle toast so the user knows nothing
      // was lost.
      if (r.status === 409) {
        const j = await r.json().catch(() => ({}))
        setToast(j.error ?? 'Already extracting — wait for it to finish.')
        setTimeout(() => setToast(''), 5000)
      }
    } catch (e: any) {
      // Network errors flip the row to 'failed' server-side when the
      // worker detects the trigger never landed; UI picks that up on
      // next poll.
    }
  }

  async function handleFiles(files: FileList | File[]) {
    if (!bizId) { setToast('Pick a business first'); return }
    const arr = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'))
    if (!arr.length) { setToast('Only PDFs accepted'); return }

    setUploading(true); setToast('')
    try {
      const fd = new FormData()
      fd.append('business_id', bizId)
      for (const f of arr) fd.append('files', f)
      const r = await fetch('/api/fortnox/upload', { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `Upload failed (${r.status})`)

      const okIds = (j.uploads ?? []).filter((u: any) => u.status === 'pending').map((u: any) => u.id).filter(Boolean)
      setToast(`${j.uploaded} uploaded — extracting…`)
      await load()

      // Fire extractions in parallel (Sonnet call per PDF, ~15s each).
      // The server flips status=extracting immediately so the poll above
      // renders the progress chip.
      await Promise.all(okIds.map((id: string) => extractOne(id)))
      await load()
    } catch (e: any) {
      setToast('Upload failed — ' + (e?.message ?? 'unknown'))
    }
    setUploading(false)
    setTimeout(() => setToast(''), 6000)
  }

  async function deleteUpload(id: string) {
    if (!confirm('Discard this upload?')) return
    const r = await fetch(`/api/fortnox/uploads?id=${id}`, { method: 'DELETE' })
    if (r.ok) load()
  }

  async function retryExtract(id: string) {
    setUploads(prev => prev.map(u => u.id === id ? { ...u, status: 'extracting' } : u))
    await extractOne(id)
    load()
  }

  const selectedBiz = businesses.find(b => b.id === bizId) ?? null
  const pendingCount  = uploads.filter(u => u.status === 'pending' || u.status === 'extracting').length
  const reviewCount   = uploads.filter(u => u.status === 'extracted').length
  const appliedCount  = uploads.filter(u => u.status === 'applied').length

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>

        <TopBar
          crumbs={[{ label: 'Financials' }, { label: 'Overheads', active: true }]}
          rightSlot={selectedBiz ? (
            <span style={{ fontSize: UX.fsMicro, color: UX.ink3 }}>
              for <span style={{ color: UX.ink1, fontWeight: UX.fwMedium }}>{selectedBiz.name}</span>
            </span>
          ) : null}
        />

        <PageHero
          eyebrow="OVERHEADS — FORTNOX INGESTION"
          headline={
            uploads.length === 0
              ? <>Drop your Fortnox P&amp;L PDFs below to get started.</>
              : <>
                  <span style={{ fontWeight: UX.fwMedium }}>{uploads.length}</span> upload{uploads.length === 1 ? '' : 's'}
                  {reviewCount > 0  && <> · <span style={{ color: UX.indigo,  fontWeight: UX.fwMedium }}>{reviewCount} awaiting review</span></>}
                  {appliedCount > 0 && <> · <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>{appliedCount} applied</span></>}
                  {pendingCount > 0 && <> · <span style={{ color: UX.amberInk, fontWeight: UX.fwMedium }}>{pendingCount} processing</span></>}
                </>
          }
          context={uploads.length === 0
            ? 'Yearly P&L, monthly P&L, or supplier invoices. AI reads the PDF, extracts every line item, then you confirm before it hits your data.'
            : undefined}
        />

        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault(); setDragging(false)
            if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files)
          }}
          onClick={() => !uploading && fileRef.current?.click()}
          style={{
            background:    dragging ? UX.indigoBg : UX.cardBg,
            border:        `1.5px dashed ${dragging ? UX.indigo : UX.border}`,
            borderRadius:  UX.r_lg,
            padding:       '28px 20px',
            textAlign:     'center' as const,
            cursor:        uploading ? 'wait' : 'pointer',
            marginBottom:  16,
            transition:    'background .15s, border-color .15s',
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            multiple
            style={{ display: 'none' }}
            onChange={e => { if (e.target.files) handleFiles(e.target.files); if (fileRef.current) fileRef.current.value = '' }}
          />
          <div style={{ fontSize: 14, fontWeight: UX.fwMedium, color: UX.ink1, marginBottom: 4 }}>
            {uploading ? 'Uploading…' : dragging ? 'Drop to upload' : 'Drop Fortnox PDFs here or click to select'}
          </div>
          <div style={{ fontSize: UX.fsMicro, color: UX.ink4 }}>PDF only · up to 10 MB each · up to 20 at a time</div>
        </div>

        {toast && (
          <div style={{
            background:   UX.indigoBg, border: `0.5px solid ${UX.indigo}`,
            borderRadius: UX.r_md, padding: '8px 12px',
            fontSize:     UX.fsBody, color: UX.indigo, marginBottom: 12,
          }}>{toast}</div>
        )}

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>Loading uploads…</div>
        ) : uploads.length === 0 ? (
          <AttentionPanel
            title="Nothing uploaded yet"
            items={[
              { tone: 'warning', entity: 'Yearly P&L',   message: 'drop your Fortnox annual resultaträkning to track year-over-year overhead drift.' },
              { tone: 'warning', entity: 'Monthly P&L',  message: 'any months with Fortnox PDF detail land in /tracker and /overheads — AI flags cost creep.' },
            ]}
          />
        ) : (
          <UploadsTable
            uploads={uploads}
            nowMs={nowMs}
            onReview={(id: string) => setReviewId(id)}
            onRetry={retryExtract}
            onDelete={deleteUpload}
          />
        )}

        <div style={{ marginTop: 10, fontSize: UX.fsMicro, color: UX.ink4 }}>
          Applied rows feed <a href="/tracker" style={{ color: UX.indigo }}>/tracker</a> and the overheads breakdown below (landing next commit).
        </div>
      </div>

      {reviewId && (
        <ReviewModal
          uploadId={reviewId}
          onClose={() => setReviewId(null)}
          onDone={() => { setReviewId(null); load() }}
        />
      )}
    </AppShell>
  )
}

// ─── Uploads table ─────────────────────────────────────────────────────
function UploadsTable({ uploads, nowMs, onReview, onRetry, onDelete }: any) {
  return (
    <div style={{
      background:   UX.cardBg,
      border:       `0.5px solid ${UX.border}`,
      borderRadius: UX.r_lg,
      overflow:     'hidden' as const,
    }}>
      <div style={{
        padding:      '10px 16px',
        background:   UX.subtleBg,
        borderBottom: `0.5px solid ${UX.borderSoft}`,
        display:      'grid',
        gridTemplateColumns: '1fr 140px 110px 130px 120px 40px',
        gap:          10,
        fontSize:     UX.fsMicro,
        fontWeight:   UX.fwMedium,
        color:        UX.ink4,
        letterSpacing: '.06em',
        textTransform: 'uppercase' as const,
      }}>
        <span>File</span>
        <span>Period</span>
        <span style={{ textAlign: 'right' as const }}>Size</span>
        <span style={{ textAlign: 'center' as const }}>Status</span>
        <span style={{ textAlign: 'right' as const }}>Action</span>
        <span />
      </div>
      {uploads.map((u: Upload) => {
        // Low-confidence extractions get an amber chip even though the
        // status is "extracted", so the row visually screams "review me".
        const lowConfidence = u.status === 'extracted'
          && typeof u.error_message === 'string'
          && /low.?confidence/i.test(u.error_message)
        const tone: 'good' | 'bad' | 'warning' | 'neutral' | 'info' =
            u.status === 'applied'    ? 'good'
          : u.status === 'failed'     ? 'bad'
          : u.status === 'rejected'   ? 'bad'
          : lowConfidence             ? 'warning'
          : u.status === 'extracted'  ? 'info'
          : u.status === 'extracting' ? 'warning'
          :                             'neutral'
        const elapsedSec  = (u.status === 'extracting' || u.status === 'pending') && u.created_at
          ? Math.max(0, Math.floor(((nowMs ?? Date.now()) - new Date(u.created_at).getTime()) / 1000))
          : null
        const statusLabel = lowConfidence
          ? 'LOW CONFIDENCE'
          : elapsedSec !== null
            ? `EXTRACTING · ${elapsedSec}s`
            : u.status.toUpperCase()
        const periodLabel = u.period_year && u.period_month
          ? `${MONTHS[u.period_month - 1]} ${u.period_year}`
          : u.period_year
            ? `${u.period_year} (annual)`
            : '—'
        return (
          <div key={u.id} style={{
            display: 'grid',
            gridTemplateColumns: '1fr 140px 110px 130px 120px 40px',
            gap: 10,
            alignItems: 'center',
            padding: '10px 16px',
            borderBottom: `0.5px solid ${UX.borderSoft}`,
            fontSize: UX.fsBody,
          }}>
            <span style={{ color: UX.ink1, fontWeight: UX.fwMedium, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
              {u.pdf_filename}
              {(() => {
                // Prefer live job progress over the upload's error_message.
                const job = Array.isArray(u.extraction_jobs) ? u.extraction_jobs[0] : u.extraction_jobs
                const isExtracting = u.status === 'extracting' || u.status === 'pending'
                const progressMsg = isExtracting && job?.progress?.message ? job.progress.message : null
                const errorMsg    = !isExtracting ? (u.error_message ?? job?.error_message ?? null) : null
                const text = progressMsg ?? errorMsg
                if (!text) return null
                return (
                  <div style={{
                    fontSize:  UX.fsMicro,
                    color:     isExtracting ? UX.indigo : UX.redInk,
                    marginTop: 2,
                    whiteSpace: 'normal' as const,
                  }}>{text}</div>
                )
              })()}
            </span>
            <span style={{ color: UX.ink3, fontSize: UX.fsMicro }}>{periodLabel}</span>
            <span style={{ textAlign: 'right' as const, color: UX.ink4, fontSize: UX.fsMicro, fontVariantNumeric: 'tabular-nums' as const }}>
              {u.pdf_size_bytes ? `${(u.pdf_size_bytes / 1024).toFixed(0)} KB` : '—'}
            </span>
            <span style={{ textAlign: 'center' as const }}>
              <StatusPill tone={tone as any}>{statusLabel}</StatusPill>
            </span>
            <span style={{ textAlign: 'right' as const }}>
              {u.status === 'extracted' && (
                <button onClick={() => onReview(u.id)} style={actionBtn('primary')}>Review</button>
              )}
              {u.status === 'applied' && (
                <button onClick={() => onReview(u.id)} style={actionBtn('ghost')}>View</button>
              )}
              {u.status === 'failed' && (
                <button onClick={() => onRetry(u.id)} style={actionBtn('ghost')}>Retry</button>
              )}
              {(u.status === 'extracting' || u.status === 'pending') && (
                <button onClick={() => onDelete(u.id)} style={{ ...actionBtn('ghost'), color: UX.redInk }}>Cancel</button>
              )}
            </span>
            <span style={{ textAlign: 'right' as const }}>
              {u.status !== 'applied' && (
                <button
                  onClick={() => onDelete(u.id)}
                  title="Discard"
                  style={{ background: 'none', border: 'none', color: UX.ink4, cursor: 'pointer', fontSize: 14, padding: 4 }}
                >×</button>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function actionBtn(kind: 'primary' | 'ghost') {
  if (kind === 'primary') {
    return {
      padding: '4px 10px',
      background: UX.indigo,
      color: 'white',
      border: 'none',
      borderRadius: UX.r_sm,
      fontSize: UX.fsMicro,
      fontWeight: UX.fwMedium,
      cursor: 'pointer',
    } as any
  }
  return {
    padding: '4px 10px',
    background: 'transparent',
    color: UX.ink3,
    border: `0.5px solid ${UX.border}`,
    borderRadius: UX.r_sm,
    fontSize: UX.fsMicro,
    fontWeight: UX.fwMedium,
    cursor: 'pointer',
  } as any
}

// ─── Review modal ──────────────────────────────────────────────────────
function ReviewModal({ uploadId, onClose, onDone }: any) {
  const [upload, setUpload] = useState<any>(null)
  const [pdfUrl, setPdfUrl] = useState<string>('')
  const [applying, setApplying] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [err, setErr] = useState('')
  // Conflict state — if an existing tracker_data row would be replaced.
  const [conflict, setConflict] = useState<any>(null)
  const [ackConflict, setAckConflict] = useState(false)

  useEffect(() => {
    // Fetch the full list (default 50) and find the specific upload by id.
    // The older limit=1 hack only ever worked for the most recent upload —
    // reviewing any older one left the modal stuck on "Loading…".
    fetch(`/api/fortnox/uploads?include_json=1`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        const row = (j.uploads ?? []).find((u: any) => u.id === uploadId)
        setUpload(row ?? null)
      })
    fetch(`/api/fortnox/signed-url?id=${uploadId}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j?.url) setPdfUrl(j.url) })
    // Check whether a non-Fortnox entry exists for this period.
    fetch(`/api/fortnox/conflict-check?upload_id=${uploadId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j?.has_conflict) setConflict(j) })
  }, [uploadId])

  const extraction = upload?.extracted_json ?? null

  async function apply() {
    if (conflict && !ackConflict) {
      setErr('Please acknowledge the conflict before applying.')
      return
    }
    setApplying(true); setErr('')
    try {
      const r = await fetch('/api/fortnox/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_id: uploadId }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `Apply failed (${r.status})`)
      onDone()
    } catch (e: any) { setErr(e.message) }
    setApplying(false)
  }

  async function reject() {
    if (!confirm('Reject this upload? Applied data will be rolled back.')) return
    setRejecting(true); setErr('')
    try {
      const r = await fetch('/api/fortnox/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_id: uploadId }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `Reject failed (${r.status})`)
      onDone()
    } catch (e: any) { setErr(e.message) }
    setRejecting(false)
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: UX.r_lg, width: '100%', maxWidth: 1100, height: '90vh', overflow: 'hidden' as const, display: 'flex', flexDirection: 'column' as const }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${UX.borderSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: UX.fwMedium, color: UX.ink1 }}>
              Review: {upload?.pdf_filename ?? 'Loading…'}
            </div>
            <div style={{ fontSize: UX.fsMicro, color: UX.ink4 }}>
              {extraction?.doc_type === 'pnl_annual'
                ? `${extraction?.period?.year ?? ''} · Annual P&L`
                : extraction
                  ? `${MONTHS[(extraction?.period?.month ?? 1) - 1]} ${extraction?.period?.year} · Monthly P&L`
                  : ''}
              {extraction?.confidence && <> · AI confidence: <span style={{ fontWeight: UX.fwMedium }}>{extraction.confidence}</span></>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: UX.ink4 }}>×</button>
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 0 }}>
          {/* PDF preview — <object> renders PDFs more reliably than <iframe>
              in Chrome/Safari when the source is a signed Supabase URL.  We
              also always surface an "Open in new tab" link so the owner has
              a fallback path when the inline preview is blocked (some
              browsers or networks refuse to embed cross-origin PDFs). */}
          <div style={{ background: '#f3f4f6', borderRight: `1px solid ${UX.borderSoft}`, minHeight: 0, display: 'flex', flexDirection: 'column' as const }}>
            {pdfUrl ? (
              <>
                <div style={{ padding: '6px 10px', background: 'white', borderBottom: `1px solid ${UX.borderSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: UX.fsMicro }}>
                  <span style={{ color: UX.ink4 }}>PDF preview</span>
                  <a
                    href={pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: UX.indigo, textDecoration: 'none', fontWeight: UX.fwMedium }}
                  >
                    Open in new tab ↗
                  </a>
                </div>
                <object data={pdfUrl} type="application/pdf" style={{ flex: 1, width: '100%', border: 0 }}>
                  {/* Fallback when inline PDF rendering is blocked */}
                  <div style={{ padding: 30, textAlign: 'center' as const, color: UX.ink3, fontSize: UX.fsBody }}>
                    Your browser can't embed this PDF.{' '}
                    <a href={pdfUrl} target="_blank" rel="noopener noreferrer" style={{ color: UX.indigo }}>
                      Open it in a new tab
                    </a>
                    {' '}to cross-reference while you review.
                  </div>
                </object>
              </>
            ) : (
              <div style={{ padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>Loading PDF…</div>
            )}
          </div>

          {/* Extraction pane */}
          <div style={{ overflowY: 'auto' as const, padding: 20, minHeight: 0 }}>
            {!extraction ? (
              <div style={{ fontSize: UX.fsBody, color: UX.ink4 }}>Loading extraction…</div>
            ) : (
              <>
                {extraction.warnings?.length > 0 && (
                  <AttentionPanel
                    title="Warnings"
                    items={extraction.warnings.map((w: string) => ({ tone: 'warning', entity: 'AI', message: w }))}
                  />
                )}

                {conflict?.has_conflict && (
                  <ConflictPanel
                    existing={conflict.existing}
                    existingSource={conflict.existing_source}
                    incoming={extraction.rollup}
                    ack={ackConflict}
                    onAck={setAckConflict}
                  />
                )}

                <div style={{ fontSize: 11, fontWeight: UX.fwMedium, color: UX.ink4, textTransform: 'uppercase' as const, letterSpacing: '.06em', marginTop: 10, marginBottom: 8 }}>
                  Rollup
                </div>
                <RollupGrid rollup={extraction.rollup} />

                <div style={{ fontSize: 11, fontWeight: UX.fwMedium, color: UX.ink4, textTransform: 'uppercase' as const, letterSpacing: '.06em', marginTop: 18, marginBottom: 8 }}>
                  Line items ({extraction.lines?.length ?? 0})
                </div>
                <LineItemsTable lines={extraction.lines ?? []} />
              </>
            )}
          </div>
        </div>

        {err && (
          <div style={{ background: UX.redSoft, border: `0.5px solid ${UX.redBorder}`, color: UX.redInk, padding: '8px 16px', fontSize: UX.fsBody }}>{err}</div>
        )}

        <div style={{ padding: '12px 20px', borderTop: `1px solid ${UX.borderSoft}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {upload?.status === 'applied' ? (
            <button onClick={reject} disabled={rejecting} style={{ ...actionBtn('ghost'), padding: '7px 14px', fontSize: UX.fsBody, color: UX.redInk }}>
              {rejecting ? 'Rejecting…' : 'Unapply + reject'}
            </button>
          ) : (
            <>
              <button onClick={reject} disabled={rejecting || applying} style={{ ...actionBtn('ghost'), padding: '7px 14px', fontSize: UX.fsBody }}>
                {rejecting ? 'Rejecting…' : 'Reject'}
              </button>
              <button onClick={apply} disabled={applying || !extraction} style={{ ...actionBtn('primary'), padding: '7px 14px', fontSize: UX.fsBody }}>
                {applying ? 'Applying…' : 'Apply to P&L'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Conflict diff panel ──────────────────────────────────────────────
function ConflictPanel({ existing, existingSource, incoming, ack, onAck }: any) {
  if (!existing) return null
  const rows = [
    { label: 'Revenue',    existing: Number(existing.revenue     ?? 0), incoming: Number(incoming.revenue     ?? 0) },
    { label: 'Food cost',  existing: Number(existing.food_cost   ?? 0), incoming: Number(incoming.food_cost   ?? 0) },
    { label: 'Staff cost', existing: Number(existing.staff_cost  ?? 0), incoming: Number(incoming.staff_cost  ?? 0) },
    { label: 'Other cost', existing: Number(existing.other_cost  ?? 0), incoming: Number(incoming.other_cost  ?? 0) },
    { label: 'Net profit', existing: Number(existing.net_profit  ?? 0), incoming: Number(incoming.net_profit  ?? 0) },
  ]
  const sourceLabel = existingSource === 'manual'       ? 'a manual entry you typed'
                    : existingSource === 'fortnox_api'  ? 'a Fortnox API sync'
                    : existingSource === 'pos_sync'     ? 'a POS auto-sync'
                    :                                     `source: ${existingSource}`
  return (
    <div style={{
      marginBottom: 14,
      background:   '#fffbeb',
      border:       '1px solid #fde68a',
      borderRadius: 10,
      padding:      '12px 14px',
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', letterSpacing: '.04em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
        Existing data for this period
      </div>
      <div style={{ fontSize: 12, color: '#78350f', marginBottom: 10, lineHeight: 1.55 }}>
        Applying this PDF will replace {sourceLabel} for the same month. Compare the numbers below and acknowledge before continuing — the old values are preserved in the audit log (<code>fortnox_upload_id</code>) but will no longer drive the P&amp;L.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #fde68a' }}>
            <th style={{ textAlign: 'left' as const, padding: '4px 8px', fontSize: 10, fontWeight: 700, color: '#92400e', textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Metric</th>
            <th style={{ textAlign: 'right' as const, padding: '4px 8px', fontSize: 10, fontWeight: 700, color: '#92400e', textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Existing</th>
            <th style={{ textAlign: 'right' as const, padding: '4px 8px', fontSize: 10, fontWeight: 700, color: '#92400e', textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Fortnox PDF</th>
            <th style={{ textAlign: 'right' as const, padding: '4px 8px', fontSize: 10, fontWeight: 700, color: '#92400e', textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const diff = r.incoming - r.existing
            const bothZero = r.existing === 0 && r.incoming === 0
            return (
              <tr key={r.label}>
                <td style={{ padding: '4px 8px', color: '#374151' }}>{r.label}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' as const, color: '#374151', fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(r.existing)}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' as const, color: '#111', fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(r.incoming)}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right' as const, color: bothZero ? '#9ca3af' : (diff === 0 ? '#6b7280' : (diff > 0 ? '#15803d' : '#b91c1c')), fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const }}>
                  {bothZero ? '—' : diff === 0 ? '0 kr' : `${diff > 0 ? '+' : '−'}${fmtKr(Math.abs(diff))}`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, cursor: 'pointer', fontSize: 12, color: '#78350f' }}>
        <input type="checkbox" checked={ack} onChange={e => onAck(e.target.checked)} />
        Yes, replace the existing entry with the Fortnox values.
      </label>
    </div>
  )
}

function RollupGrid({ rollup }: { rollup: any }) {
  if (!rollup) return null
  const rows = [
    { label: 'Revenue',      value: rollup.revenue,      tone: 'good' },
    { label: 'Food cost',    value: rollup.food_cost,    tone: 'bad'  },
    { label: 'Staff cost',   value: rollup.staff_cost,   tone: 'bad'  },
    { label: 'Other cost',   value: rollup.other_cost,   tone: 'bad'  },
    { label: 'Depreciation', value: rollup.depreciation, tone: 'neutral' },
    { label: 'Financial',    value: rollup.financial,    tone: 'neutral' },
    { label: 'Net profit',   value: rollup.net_profit,   tone: rollup.net_profit >= 0 ? 'good' : 'bad' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
      {rows.map(r => (
        <div key={r.label} style={{
          border: `0.5px solid ${UX.borderSoft}`, borderRadius: UX.r_sm,
          padding: '6px 10px', background: UX.subtleBg,
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        }}>
          <span style={{ fontSize: UX.fsMicro, color: UX.ink4 }}>{r.label}</span>
          <span style={{
            fontSize: UX.fsBody, fontWeight: UX.fwMedium,
            color: r.tone === 'good' ? UX.greenInk : r.tone === 'bad' ? UX.redInk : UX.ink1,
            fontVariantNumeric: 'tabular-nums' as const,
          }}>{fmtKr(Number(r.value) || 0)}</span>
        </div>
      ))}
    </div>
  )
}

function LineItemsTable({ lines }: { lines: any[] }) {
  if (!lines.length) return <div style={{ fontSize: UX.fsBody, color: UX.ink4 }}>No line items extracted.</div>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: UX.fsMicro }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${UX.borderSoft}` }}>
          {['Label', 'Category', 'Sub', 'Account', 'Amount'].map(h => (
            <th key={h} style={{ padding: '5px 8px', textAlign: h === 'Amount' ? 'right' as const : 'left' as const, fontSize: 9, color: UX.ink4, fontWeight: UX.fwMedium, letterSpacing: '.06em', textTransform: 'uppercase' as const }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
            <td style={{ padding: '5px 8px', color: UX.ink1 }}>{l.label_sv ?? l.label}</td>
            <td style={{ padding: '5px 8px', color: UX.ink3 }}>{l.category}</td>
            <td style={{ padding: '5px 8px', color: l.subcategory ? UX.ink2 : UX.ink5 }}>{l.subcategory ?? '—'}</td>
            <td style={{ padding: '5px 8px', color: UX.ink4, fontVariantNumeric: 'tabular-nums' as const }}>{l.fortnox_account ?? '—'}</td>
            <td style={{ padding: '5px 8px', textAlign: 'right' as const, color: UX.ink1, fontVariantNumeric: 'tabular-nums' as const, fontWeight: UX.fwMedium }}>{fmtKr(Number(l.amount) || 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
