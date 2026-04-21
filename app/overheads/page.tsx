'use client'
// @ts-nocheck
// app/overheads/page.tsx
//
// Phase 1 of the Fortnox ingestion feature: upload UI.  Drop zone that
// accepts multiple PDFs at once, sends them to /api/fortnox/upload in one
// multipart request, and lists the resulting fortnox_uploads rows with
// their current status.
//
// The extraction + review + apply flows come in later phases and will
// plug into the same list view below.

export const dynamic = 'force-dynamic'

import { useEffect, useRef, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import PageHero from '@/components/ui/PageHero'
import StatusPill from '@/components/ui/StatusPill'
import TopBar from '@/components/ui/TopBar'
import AttentionPanel from '@/components/ui/AttentionPanel'
import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Business { id: string; name: string; city: string | null }
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
  const fileRef = useRef<HTMLInputElement | null>(null)

  // ── Load businesses + selection ────────────────────────────────────────
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

  // ── Load uploads for selected business ─────────────────────────────────
  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    try {
      const r = await fetch(`/api/fortnox/uploads?business_id=${bizId}`, { cache: 'no-store' })
      const j = await r.json()
      if (Array.isArray(j.uploads)) setUploads(j.uploads)
    } catch {}
    setLoading(false)
  }, [bizId])

  useEffect(() => { if (bizId) load() }, [bizId, load])

  // ── Upload handler ──────────────────────────────────────────────────────
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
      const failed = (j.uploads ?? []).filter((u: any) => u.status === 'failed')
      if (failed.length) {
        setToast(`${j.uploaded} uploaded, ${j.failed} failed — ${failed[0].error}`)
      } else {
        setToast(`${j.uploaded} file${j.uploaded === 1 ? '' : 's'} uploaded — extracting next`)
      }
      await load()
    } catch (e: any) {
      setToast('Upload failed — ' + (e?.message ?? 'unknown'))
    }
    setUploading(false)
    setTimeout(() => setToast(''), 5000)
  }

  async function deleteUpload(id: string) {
    if (!confirm('Discard this upload?')) return
    const r = await fetch(`/api/fortnox/uploads?id=${id}`, { method: 'DELETE' })
    if (r.ok) load()
  }

  const selectedBiz = businesses.find(b => b.id === bizId) ?? null
  const pendingCount = uploads.filter(u => u.status === 'pending' || u.status === 'extracting').length
  const appliedCount = uploads.filter(u => u.status === 'applied').length

  return (
    <AppShell>
      <div style={{ maxWidth: 1000 }}>

        <TopBar
          crumbs={[
            { label: 'Financials' },
            { label: 'Overheads', active: true },
          ]}
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
                  {appliedCount > 0 && <> · <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>{appliedCount} applied</span></>}
                  {pendingCount > 0 && <> · <span style={{ color: UX.amberInk, fontWeight: UX.fwMedium }}>{pendingCount} pending</span></>}
                </>
          }
          context={uploads.length === 0
            ? 'Yearly P&L, monthly P&L, or supplier invoices. AI reads the PDF, extracts every line item, then you confirm before it hits your data.'
            : undefined}
        />

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
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
            {uploading
              ? 'Uploading…'
              : dragging ? 'Drop to upload'
              : 'Drop Fortnox PDFs here or click to select'}
          </div>
          <div style={{ fontSize: UX.fsMicro, color: UX.ink4 }}>
            PDF only · up to 10 MB each · up to 20 at a time
          </div>
        </div>

        {toast && (
          <div style={{
            background:   UX.indigoBg,
            border:       `0.5px solid ${UX.indigo}`,
            borderRadius: UX.r_md,
            padding:      '8px 12px',
            fontSize:     UX.fsBody,
            color:        UX.indigo,
            marginBottom: 12,
          }}>{toast}</div>
        )}

        {/* Uploads list */}
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
              gridTemplateColumns: '1fr 110px 90px 110px 40px',
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
              <span />
            </div>

            {uploads.map(u => {
              const tone: 'good' | 'bad' | 'warning' | 'neutral' =
                  u.status === 'applied'    ? 'good'
                : u.status === 'failed'     ? 'bad'
                : u.status === 'rejected'   ? 'bad'
                : u.status === 'extracted'  ? 'warning'
                :                             'neutral'
              const periodLabel = u.period_year && u.period_month
                ? `${MONTHS[u.period_month - 1]} ${u.period_year}`
                : u.period_year
                  ? `${u.period_year} (annual)`
                  : '—'
              return (
                <div key={u.id} style={{
                  display:       'grid',
                  gridTemplateColumns: '1fr 110px 90px 110px 40px',
                  gap:           10,
                  alignItems:    'center',
                  padding:       '10px 16px',
                  borderBottom:  `0.5px solid ${UX.borderSoft}`,
                  fontSize:      UX.fsBody,
                }}>
                  <span style={{ color: UX.ink1, fontWeight: UX.fwMedium, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                    {u.pdf_filename}
                    {u.error_message && <div style={{ fontSize: UX.fsMicro, color: UX.redInk, marginTop: 2 }}>{u.error_message}</div>}
                  </span>
                  <span style={{ color: UX.ink3, fontSize: UX.fsMicro }}>{periodLabel}</span>
                  <span style={{ textAlign: 'right' as const, color: UX.ink4, fontSize: UX.fsMicro, fontVariantNumeric: 'tabular-nums' as const }}>
                    {u.pdf_size_bytes ? `${(u.pdf_size_bytes / 1024).toFixed(0)} KB` : '—'}
                  </span>
                  <span style={{ textAlign: 'center' as const }}>
                    <StatusPill tone={tone}>{u.status.toUpperCase()}</StatusPill>
                  </span>
                  <span style={{ textAlign: 'right' as const }}>
                    {u.status !== 'applied' && (
                      <button
                        onClick={() => deleteUpload(u.id)}
                        title="Discard"
                        style={{ background: 'none', border: 'none', color: UX.ink4, cursor: 'pointer', fontSize: 14, padding: 4 }}
                      >×</button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        <div style={{ marginTop: 10, fontSize: UX.fsMicro, color: UX.ink4 }}>
          Extraction and review steps land in the next commit — uploads sit in the pending state until then.
        </div>
      </div>
    </AppShell>
  )
}
