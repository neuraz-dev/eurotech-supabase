export type PaginationItem = number | 'gap-before' | 'gap-after'

/** First, last and two neighbors on either side of the active page. */
export function paginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  const last = Math.max(1, Math.trunc(totalPages))
  const current = Math.max(1, Math.min(last, Math.trunc(currentPage)))
  const visible = new Set([1, last])
  for (let page = Math.max(1, current - 2); page <= Math.min(last, current + 2); page++) visible.add(page)
  const pages = [...visible].sort((a, b) => a - b)
  const result: PaginationItem[] = []
  for (const [index, page] of pages.entries()) {
    if (index && page - pages[index - 1] > 1) result.push(page <= current ? 'gap-before' : 'gap-after')
    result.push(page)
  }
  return result
}

export function jumpPage(value: string, totalPages: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 && page <= totalPages ? page : null
}
