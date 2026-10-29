import { skuKey } from './sku.ts'

type ProductIdentity = { id: string; sku: string | null }
type CompetitorOwner = { our_product_id: string | null; our_sku: string }

export function indexProducts<T extends ProductIdentity>(products: T[]) {
  const byId = new Map<string, T>()
  const bySku = new Map<string, T[]>()
  for (const product of products) {
    byId.set(product.id, product)
    const key = skuKey(product.sku)
    if (key) bySku.set(key, [...(bySku.get(key) ?? []), product])
  }
  return { byId, bySku }
}

export function resolveCompetitorProducts<T extends ProductIdentity>(
  competitor: CompetitorOwner,
  products: ReturnType<typeof indexProducts<T>>,
): T[] {
  if (competitor.our_product_id) {
    const product = products.byId.get(competitor.our_product_id)
    return product ? [product] : []
  }
  return products.bySku.get(skuKey(competitor.our_sku) ?? '') ?? []
}
