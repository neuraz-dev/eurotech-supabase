import { isAuthorized, getValidToken, fetchAllItemIds, fetchAndUpsertItems, SYNC_PAGE_SIZE, SUPABASE_URL, SUPABASE_SERVICE_KEY } from './service.ts'

Deno.serve(async (req) => {
  // Sólo POST o llamadas internas
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 })
  }

  if (!isAuthorized(req)) {
    return Response.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    )
  }

  try {
    console.log('=== ML Sync iniciado ===')

    let page = 0
    let requestedIds: string[] | null = null
    try {
      const body = await req.json()
      if (Number.isInteger(body?.page) && body.page >= 0) page = body.page
      if (Array.isArray(body?.ids)) {
        const ids = body.ids.filter(
          (id: unknown): id is string =>
            typeof id === 'string' && id.trim().length > 0,
        )
        requestedIds = Array.from(new Set(ids))
      }
    } catch {
      // Empty cron body: start from the first page.
    }

    const tokenRow = await getValidToken()
    const ids =
      requestedIds ??
      (await fetchAllItemIds(tokenRow.access_token, tokenRow.user_id))
    const start = page * SYNC_PAGE_SIZE
    const pageIds = ids.slice(start, start + SYNC_PAGE_SIZE)
    const totalPages = Math.ceil(ids.length / SYNC_PAGE_SIZE)
    console.log(
      `Total productos: ${ids.length} (user_id: ${tokenRow.user_id}), página ${page + 1}/${totalPages}`,
    )
    const { upserted, results } = await fetchAndUpsertItems(pageIds, tokenRow.access_token)
    const hasMore = start + pageIds.length < ids.length

    if (hasMore) {
      const nextPage = page + 1
      console.log(`Disparando página siguiente: ${nextPage + 1}/${totalPages}`)
      fetch(`${SUPABASE_URL}/functions/v1/ml-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({ page: nextPage }),
      }).catch((error) =>
        console.error('Error disparando página siguiente:', error),
      )
    }

    const result = {
      success: results.every(r => r.outcome !== 'failed'),
      items_failed: results.filter(r => r.outcome === 'failed').length,
      total_ids: ids.length,
      page,
      total_pages: totalPages,
      upserted,
      synced_at: new Date().toISOString(),
      has_more: hasMore,
    }

    console.log('=== ML Sync finalizado ===', result)
    return Response.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('ML Sync error:', message)
    return Response.json({ success: false, error: message }, { status: 500 })
  }
})
