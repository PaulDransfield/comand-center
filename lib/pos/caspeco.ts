// @ts-nocheck
// lib/pos/caspeco.ts
// Caspeco staff scheduling integration
// Auth: Authorization: Bearer <api_key>
// Base: https://api.caspeco.se/v1 (standard REST)

const BASE = 'https://api.caspeco.se/v1'

async function fetchAll(endpoint: string, token: string): Promise<any[]> {
  const results: any[] = []
  let url: string | null = `${BASE}${endpoint}`
  let page = 1

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Caspeco ${endpoint} error: ${res.status} ${res.statusText}`)
    const data = await res.json()

    // Caspeco may use different pagination — handle both array and paged response
    if (Array.isArray(data)) {
      results.push(...data)
      url = null // no pagination info, assume one page
    } else if (data.data) {
      results.push(...data.data)
      url = data.next_page_url ?? null
    } else {
      results.push(data)
      url = null
    }
    page++
    if (page > 50) break // safety limit
  }
  return results
}

export async function getCaspecoEmployees(token: string) {
  try {
    const employees = await fetchAll('/employees', token)
    return employees.map((e: any) => ({
      id:        e.id,
      name:      `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim(),
      email:     e.email ?? null,
      role:      e.role ?? e.position ?? null,
      is_active: e.active ?? e.is_active ?? true,
    }))
  } catch (e: any) {
    console.error('Caspeco employees error:', e.message)
    return []
  }
}

export async function getCaspecoShifts(token: string, fromDate: string, toDate: string) {
  try {
    const shifts = await fetchAll(`/shifts?from=${fromDate}&to=${toDate}`, token)
    return shifts.map((s: any) => {
      const start = s.start_time ?? s.started_at ?? s.from
      const end   = s.end_time   ?? s.ended_at   ?? s.to
      const hours = start && end
        ? (new Date(end).getTime() - new Date(start).getTime()) / 3600000
        : (s.hours ?? s.duration_hours ?? 0)
      return {
        id:          s.id,
        employee_id: s.employee_id ?? s.user_id,
        employee_name: s.employee_name ?? s.user_name ?? null,
        department:  s.department ?? s.cost_center ?? s.section ?? null,
        start:       start,
        end:         end,
        hours:       Math.round(hours * 10) / 10,
        cost:        parseFloat(s.cost ?? s.salary_cost ?? 0),
        date:        start ? start.slice(0,10) : null,
      }
    }).filter((s: any) => s.date)
  } catch (e: any) {
    console.error('Caspeco shifts error:', e.message)
    return []
  }
}

export async function testCaspecoConnection(token: string) {
  const res = await fetch(`${BASE}/employees?limit=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Connection failed: ${res.status} ${res.statusText}`)
  return { ok: true, message: 'Caspeco connected successfully' }
}
