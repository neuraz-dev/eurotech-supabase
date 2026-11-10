import { withMonitorAuth } from '@/lib/monitoring/server'
import { NextResponse } from 'next/server'

// Invokes the ml-sync edge function (which pulls the seller's own items from ML).
// The UI calls this as fire-and-forget because ml-sync can take 1-2 minutes
// with the /items/{id}/prices calls enabled.
async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function POSTImpl() {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/ml-sync`
  const key = process.env.SUPABASE_SECRET_KEY
  if (!key)
    return NextResponse.json(
      { error: 'missing SUPABASE_SECRET_KEY' },
      { status: 500 },
    )

  try {
    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      'x-sync-secret': key,
      ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
    }

    const attempts = 3
    let lastStatus = 500
    let lastBody: unknown = null
    let lastError: string | null = null

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: '{}',
        })
        const text = await res.text()
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }

        if (res.ok) {
          return NextResponse.json(
            { status: res.status, body },
            { status: 200 },
          )
        }

        lastStatus = res.status
        lastBody = body
        lastError =
          typeof body === 'object' && body && 'error' in body
            ? String(
                (body as { error?: unknown }).error ??
                  `sync-own failed with status ${res.status}`,
              )
            : `sync-own failed with status ${res.status}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }

      if (attempt < attempts) {
        await sleep(750 * attempt)
      }
    }

    return NextResponse.json(
      {
        error: lastError ?? 'Error sincronizando propios',
        status: lastStatus,
        body: lastBody,
      },
      { status: 502 },
    )
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export const POST = withMonitorAuth(POSTImpl)
