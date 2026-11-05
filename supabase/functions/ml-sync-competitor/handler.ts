import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const ML_API = "https://api.mercadolibre.com";
const ML_OAUTH = "https://api.mercadolibre.com/oauth/token";

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}

export function createCompetitorHandler(supabase: SupabaseClient, options: {
  serviceKey: string;
  syncSecrets?: (string | undefined)[];
  clientId?: string;
  clientSecret?: string;
}): (req: Request) => Promise<Response> {
// ─── Token Management ────────────────────────────────────────────────────────

interface TokenRow {
  id: number;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  user_id: number;
}

async function getValidToken(): Promise<TokenRow> {
  const { data, error } = await supabase
    .schema("ml").from("ml_tokens")
    .select("*")
    .order("id", { ascending: false })
    .limit(1)
    .single<TokenRow>();

  if (error || !data) {
    throw new Error(`No token found in database: ${error?.message}`);
  }

  const expiresAt = new Date(data.expires_at);
  if (!Number.isFinite(expiresAt.getTime())) throw new Error("Invalid ML token expiry");
  const now = new Date();
  const bufferMs = 30 * 60 * 1000;

  if (expiresAt.getTime() - now.getTime() > bufferMs) {
    return data;
  }

  if (!data.refresh_token && expiresAt.getTime() > now.getTime()) return data;

  console.log("Token próximo a expirar, intentando renovar...");
  try {
    const newAccessToken = await refreshToken(data);
    return { ...data, access_token: newAccessToken };
  } catch (err) {
    console.warn("No se pudo renovar token:", err instanceof Error ? err.message : err);
    if (expiresAt.getTime() <= Date.now()) throw new Error("ML token expired; a valid token is required");
    return data;
  }
}

async function refreshToken(tokenRow: TokenRow): Promise<string> {
  if (!tokenRow.refresh_token) {
    throw new Error("No hay refresh_token almacenado.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: options.clientId ?? "",
    client_secret: options.clientSecret ?? "",
    refresh_token: tokenRow.refresh_token,
  });

  const res = await fetch(ML_OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Error renovando token ML: HTTP ${res.status}`);
  }

  const newToken = await res.json();
  const expiresAt = new Date(Date.now() + (newToken.expires_in ?? 21600) * 1000);

  const { error: saveError } = await supabase
    .schema("ml").from("ml_tokens")
    .update({
      access_token: newToken.access_token,
      refresh_token: newToken.refresh_token ?? tokenRow.refresh_token,
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tokenRow.id);

  if (saveError) throw new Error(`Error guardando token renovado: ${saveError.message}`);

  console.log(`Token renovado. Expira: ${expiresAt.toISOString()}`);
  return newToken.access_token;
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface CompetitorItem {
  id: string;
  our_sku: string;
  our_product_id: string | null;
  title: string | null;
  price: number | null;
  previous_price: number | null;
  thumbnail: string | null;
  permalink: string | null;
}

// Catalog product IDs are stored with /p/ or /up/ permalinks
function isCatalogItem(item: CompetitorItem): boolean {
  return !!(item.permalink?.includes("/p/") || item.permalink?.includes("/up/"));
}

interface CatalogItemResult {
  seller_id: number;
  price: number;
  currency_id: string;
  condition: string;
}

async function fetchCatalogPrice(
  catalogId: string,
  token: string,
  ourUserId: number
): Promise<{ price: number | null; sellerId: number | null; currency: string | null }> {
  const res = await fetch(
    `${ML_API}/products/${catalogId}/items?status=active&limit=20`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`ML catalog API returned HTTP ${res.status}`);

  const data = await res.json();
  const results: CatalogItemResult[] = data.results ?? [];
  if (results.length === 0) return { price: null, sellerId: null, currency: null };

  // Pick cheapest competitor (exclude our own seller ID)
  const competitors = results.filter((r) => r.seller_id !== ourUserId);
  const pool = competitors.length > 0 ? competitors : results;
  const best = pool.reduce((a, b) => (a.price <= b.price ? a : b));
  return { price: best.price, sellerId: best.seller_id, currency: best.currency_id ?? null };
}

interface MLItemPrice {
  id: string;
  code: number;
  body: {
    id: string;
    title: string | null;
    price: number | null;
    original_price: number | null;
    currency_id: string | null;
    available_quantity: number | null;
    sold_quantity: number | null;
    status: string | null;
    health: number | null;
    thumbnail: string | null;
    permalink: string | null;
  };
}

type AlertRuleType =
  | "price_changed"
  | "competitor_cheaper"
  | "competitor_pricier"
  | "price_diff_pct_above"
  | "price_diff_pct_below";

interface AlertRule {
  id: string;
  name: string;
  sku: string | null;
  rule_type: AlertRuleType;
  threshold_pct: number | null;
  enabled: boolean;
  compare_catalog_price: boolean;
}

interface OwnProductPrices {
  listPrice: number | null;
  salePrice: number | null;
  catalogPrice: number | null;
}

function normalizeSku(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

// ─── Exchange Rate ────────────────────────────────────────────────────────────

async function fetchUsdToUyu(): Promise<number | null> {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) return null;
    const data = await res.json();
    return (data.rates?.UYU as number) ?? null;
  } catch {
    return null;
  }
}

function convertUsdToUyu(usdAmount: number, rate: number): number {
  return Math.round(usdAmount * rate);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ─── ML API ──────────────────────────────────────────────────────────────────

async function fetchItemPrices(
  ids: string[],
  token: string
): Promise<MLItemPrice[]> {
  const idsParam = ids.join(",");
  const res = await fetch(
    `${ML_API}/items?ids=${idsParam}&attributes=id,title,price,original_price,currency_id,available_quantity,sold_quantity,status,health,thumbnail,permalink`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`ML API /items returned HTTP ${res.status}`);
  }
  return res.json() as Promise<MLItemPrice[]>;
}

// ─── Reglas ──────────────────────────────────────────────────────────────────

function evaluateRule(
  rule: AlertRule,
  priceBefore: number | null,
  priceAfter: number | null,
  ownPrices: OwnProductPrices,
): boolean {
  if (priceAfter === null) return false;

  const refPrice = resolveReferencePrice(rule, ownPrices);

  switch (rule.rule_type) {
    case "price_changed":
      // Only fire when price actually changed
      return priceBefore !== null && priceBefore !== priceAfter;

    case "competitor_cheaper":
      // Fire whenever competitor is cheaper than our reference price
      return refPrice !== null && priceAfter < refPrice;

    case "competitor_pricier":
      // Fire whenever competitor is more expensive than our reference price
      return refPrice !== null && priceAfter > refPrice;

    case "price_diff_pct_above": {
      // competidor más barato en al menos threshold_pct%
      if (refPrice === null || refPrice === 0 || rule.threshold_pct === null) return false;
      const diffPct = ((refPrice - priceAfter) / refPrice) * 100;
      return diffPct >= rule.threshold_pct;
    }

    case "price_diff_pct_below": {
      // competidor más caro en al menos threshold_pct%
      if (refPrice === null || refPrice === 0 || rule.threshold_pct === null) return false;
      const diffPct = ((priceAfter - refPrice) / refPrice) * 100;
      return diffPct >= rule.threshold_pct;
    }

    default:
      return false;
  }
}

function calcDiffPct(ourPrice: number | null, competitorPrice: number | null): number | null {
  if (ourPrice === null || ourPrice === 0 || competitorPrice === null) return null;
  return Number((((ourPrice - competitorPrice) / ourPrice) * 100).toFixed(2));
}

function resolveReferencePrice(rule: AlertRule, prices: OwnProductPrices): number | null {
  if (prices.salePrice !== null) return prices.salePrice;
  if (rule.compare_catalog_price && prices.catalogPrice !== null) return prices.catalogPrice;
  return prices.listPrice;
}

// ─── Core ────────────────────────────────────────────────────────────────────

async function syncCompetitorPrices(tokenRow: TokenRow): Promise<{
  items_processed: number;
  items_updated: number;
  alerts_fired: number;
  items_failed: number;
  items_skipped: number;
  alert_errors: number;
}> {
  // 1. Cargar todos los competitor items
  const { data: competitorItems, error: ciError } = await supabase
    .schema("ml").from("ml_competitor_items")
    .select("id, our_sku, our_product_id, title, price, previous_price, thumbnail, permalink");

  if (ciError) throw new Error(`Error cargando competitor items: ${ciError.message}`);
  if (!competitorItems || competitorItems.length === 0) {
    console.log("No hay competitor items registrados.");
    return { items_processed: 0, items_updated: 0, alerts_fired: 0, items_failed: 0, items_skipped: 0, alert_errors: 0 };
  }

  // 2. Cargar todas las reglas habilitadas
  const { data: rules, error: rulesError } = await supabase
    .schema("ml").from("ml_price_alert_rules")
    .select("*")
    .eq("enabled", true);

  if (rulesError) throw new Error(`Error cargando reglas: ${rulesError.message}`);
  const allRules: AlertRule[] = rules ?? [];

  // 3. Cargar precios propios por producto y por SKU (fallback para vínculos viejos)
  const productIds = [...new Set(
    (competitorItems as CompetitorItem[])
      .map((c) => c.our_product_id)
      .filter((id): id is string => !!id)
  )];
  const skus = [...new Set((competitorItems as CompetitorItem[]).map((c) => c.our_sku))];
  const [ownProductsByIdRes, ownProductsBySkuRes] = await Promise.all([
    productIds.length > 0
      ? supabase
        .schema("ml").from("ml_products")
        .select("id, sku, price, sale_price, catalog_price")
        .in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    skus.length > 0
      ? supabase
        .schema("ml").from("ml_products")
        .select("id, sku, price, sale_price, catalog_price")
        .in("sku", skus)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (ownProductsByIdRes.error) {
    throw new Error(`Error cargando precios propios por producto: ${ownProductsByIdRes.error.message}`);
  }
  if (ownProductsBySkuRes.error) {
    throw new Error(`Error cargando precios propios por SKU: ${ownProductsBySkuRes.error.message}`);
  }

  const ownPriceByProductId = new Map<string, OwnProductPrices>();
  for (const p of ownProductsByIdRes.data ?? []) {
    if (p.id && !ownPriceByProductId.has(p.id)) {
      ownPriceByProductId.set(p.id, {
        listPrice: p.price ?? null,
        salePrice: p.sale_price ?? null,
        catalogPrice: p.catalog_price ?? null,
      });
    }
  }

  const ownPriceBySku = new Map<string, OwnProductPrices>();
  for (const p of ownProductsBySkuRes.data ?? []) {
    if (p.sku && !ownPriceBySku.has(p.sku)) {
      ownPriceBySku.set(p.sku, {
        listPrice: p.price ?? null,
        salePrice: p.sale_price ?? null,
        catalogPrice: p.catalog_price ?? null,
      });
    }
  }

  function getOwnPrices(item: CompetitorItem): OwnProductPrices {
    if (item.our_product_id) {
      const productPrices = ownPriceByProductId.get(item.our_product_id);
      if (productPrices) return productPrices;
    }
    return ownPriceBySku.get(item.our_sku) ?? {
      listPrice: null,
      salePrice: null,
      catalogPrice: null,
    };
  }

  const token = tokenRow.access_token;

  let itemsUpdated = 0;
  let alertsFired = 0;
  let itemsSkipped = 0;
  let alertErrors = 0;
  const items = competitorItems as CompetitorItem[];

  const catalogItems = items.filter(isCatalogItem);
  const directItems = items.filter((i) => !isCatalogItem(i));

  console.log(`Catalog items: ${catalogItems.length}, Direct items: ${directItems.length}`);

  // Fetch exchange rate once for the whole sync run
  const usdRate = await fetchUsdToUyu();
  console.log(`USD→UYU rate: ${usdRate ?? "unavailable"}`);

  // ── Helper: process alerts and update for a resolved price ──────────────
  function buildUpdateAndAlerts(
    item: CompetitorItem,
    newPrice: number | null,
    usdPrice: number | null = null,
  ): {
    update: Record<string, unknown>;
    alerts: {
      rule_id: string;
      our_sku: string;
      competitor_item_id: string;
      our_price: number | null;
      catalog_price: number | null;
      competitor_price_before: number | null;
      competitor_price_after: number | null;
      diff_pct: number | null;
    }[];
  } {
    const prevPrice = item.price ?? null;
    const ownPrices = getOwnPrices(item);

    const update: Record<string, unknown> = {
      id: item.id,
      our_sku: item.our_sku,
      price: newPrice,
      previous_price: prevPrice,
      currency_id: "UYU",
      usd_price: usdPrice,
      synced_at: new Date().toISOString(),
    };

    const itemSku = normalizeSku(item.our_sku);
    const applicableRules = allRules.filter(
      (r) => r.sku === null || normalizeSku(r.sku) === itemSku
    );
    const alerts = applicableRules
      .filter((rule) => evaluateRule(rule, prevPrice, newPrice, ownPrices))
      .map((rule) => {
        const refPrice = resolveReferencePrice(rule, ownPrices);
        return {
          rule_id: rule.id,
          our_sku: item.our_sku,
          competitor_item_id: item.id,
          our_price: refPrice,
          catalog_price: ownPrices.catalogPrice,
          competitor_price_before: prevPrice,
          competitor_price_after: newPrice,
          diff_pct: calcDiffPct(refPrice, newPrice),
        };
      });

    return { update, alerts };
  }

  // ── 4a. Catalog items: use /products/{id}/items endpoint ─────────────────
  for (const batch of chunk(catalogItems, 10)) {
    const allAlerts: ReturnType<typeof buildUpdateAndAlerts>["alerts"] = [];
    const allUpdates: Record<string, unknown>[] = [];

    await Promise.all(batch.map(async (item) => {
      try {
        const { price: rawPrice, currency } = await fetchCatalogPrice(item.id, token, tokenRow.user_id);
        if (rawPrice === null) { itemsSkipped++; return; }

        let newPrice = rawPrice;
        let usdPrice: number | null = null;
        if (currency === "USD" && usdRate) {
          usdPrice = rawPrice;
          newPrice = convertUsdToUyu(rawPrice, usdRate);
        }

        const { update, alerts } = buildUpdateAndAlerts(item, newPrice, usdPrice);
        allUpdates.push(update);
        allAlerts.push(...alerts);
      } catch (err) {
        console.error(`Error fetching catalog ${item.id}: ${err instanceof Error ? err.message : err}`);
      }
    }));

    if (allUpdates.length > 0) {
      const { error: upsertError } = await supabase
        .schema("ml").from("ml_competitor_items")
        .upsert(allUpdates, { onConflict: "id" });
      if (upsertError) {
        console.error(`Error actualizando catalog items: ${upsertError.message}`);
        continue; // Do not emit alerts for prices that were not persisted.
      }
      itemsUpdated += allUpdates.length;
    }

    if (allAlerts.length > 0) {
      const { error: alertError } = await supabase.schema("ml").from("ml_price_alerts").insert(allAlerts);
      if (alertError) {
        alertErrors += allAlerts.length;
        console.error(`Error insertando alertas: ${alertError.message}`);
      } else alertsFired += allAlerts.length;
    }
  }

  // ── 4b. Direct items: batch via /items?ids= ──────────────────────────────
  for (const batch of chunk(directItems, 20)) {
    const ids = batch.map((i) => i.id);
    let mlResults: MLItemPrice[];

    try {
      mlResults = await fetchItemPrices(ids, token);
    } catch (err) {
      console.error(`Error fetching batch ${ids.join(",")}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    // 5. Para cada item del batch, actualizar y evaluar reglas
    const alertRows: {
      rule_id: string;
      our_sku: string;
      competitor_item_id: string;
      our_price: number | null;
      catalog_price: number | null;
      competitor_price_before: number | null;
      competitor_price_after: number | null;
      diff_pct: number | null;
    }[] = [];

    const updateRows: {
      id: string;
      our_sku: string;
      title: string | null;
      price: number | null;
      previous_price: number | null;
      currency_id: string;
      usd_price: number | null;
      available_quantity: number | null;
      sold_quantity: number | null;
      status: string | null;
      health: number | null;
      thumbnail: string | null;
      permalink: string | null;
      synced_at: string;
    }[] = [];

    for (const local of batch) {
      const result = mlResults.find((entry) => entry.id === local.id || entry.body?.id === local.id);
      if (!result || result.code !== 200 || !result.body) {
        console.error(`Error fetching item ${local.id}: HTTP ${result?.code ?? "missing result"}`);
        continue;
      }

      let newPrice = result.body.price ?? null;
      let usdPrice: number | null = null;
      if (result.body.currency_id === "USD" && newPrice !== null && usdRate) {
        usdPrice = newPrice;
        newPrice = convertUsdToUyu(newPrice, usdRate);
      }

      const prevPrice = local.price ?? null;
      const ownPrices = getOwnPrices(local);

      updateRows.push({
        id: local.id,
        our_sku: local.our_sku,
        title: result.body.title ?? local.title ?? null,
        price: newPrice,
        previous_price: prevPrice,
        currency_id: "UYU",
        usd_price: usdPrice,
        available_quantity: result.body.available_quantity ?? null,
        sold_quantity: result.body.sold_quantity ?? null,
        status: result.body.status ?? null,
        health: result.body.health ?? null,
        thumbnail: result.body.thumbnail ?? local.thumbnail ?? null,
        permalink: result.body.permalink ?? local.permalink ?? null,
        synced_at: new Date().toISOString(),
      });

      // Evaluar reglas aplicables: globales (sku=null) + específicas para este SKU
      const localSku = normalizeSku(local.our_sku);
      const applicableRules = allRules.filter(
        (r) => r.sku === null || normalizeSku(r.sku) === localSku
      );

      for (const rule of applicableRules) {
        if (evaluateRule(rule, prevPrice, newPrice, ownPrices)) {
          const refPrice = resolveReferencePrice(rule, ownPrices);
          alertRows.push({
            rule_id: rule.id,
            our_sku: local.our_sku,
            competitor_item_id: local.id,
            our_price: refPrice,
            catalog_price: ownPrices.catalogPrice,
            competitor_price_before: prevPrice,
            competitor_price_after: newPrice,
            diff_pct: calcDiffPct(refPrice, newPrice),
          });
        }
      }
    }

    // 6. Upsert precios actualizados
    if (updateRows.length > 0) {
      const { error: upsertError } = await supabase
        .schema("ml").from("ml_competitor_items")
        .upsert(updateRows, { onConflict: "id" });

      if (upsertError) {
        console.error(`Error actualizando precios: ${upsertError.message}`);
        continue; // Do not emit alerts for prices that were not persisted.
      } else {
        itemsUpdated += updateRows.length;
      }
    }

    // 7. Insertar alertas
    if (alertRows.length > 0) {
      const { error: alertError } = await supabase
        .schema("ml").from("ml_price_alerts")
        .insert(alertRows);

      if (alertError) {
        alertErrors += alertRows.length;
        console.error(`Error insertando alertas: ${alertError.message}`);
      } else {
        alertsFired += alertRows.length;
        console.log(`Alertas disparadas: ${alertRows.length}`);
        for (const a of alertRows) {
          console.log(
            `  [${a.rule_id}] SKU=${a.our_sku} item=${a.competitor_item_id} before=${a.competitor_price_before} after=${a.competitor_price_after} our=${a.our_price} diff=${a.diff_pct}%`
          );
        }
      }
    }
  }

  return {
    items_processed: items.length,
    items_updated: itemsUpdated,
    alerts_fired: alertsFired,
    items_failed: items.length - itemsUpdated - itemsSkipped,
    items_skipped: itemsSkipped,
    alert_errors: alertErrors,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

return async (req: Request): Promise<Response> => {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = [req.headers.get("apikey"), bearer, req.headers.get("x-sync-secret")];
  const allowed = [options.serviceKey, ...(options.syncSecrets ?? [])].filter((key): key is string => Boolean(key));
  if (!supplied.some((key) => key && allowed.some((secret) => constantTimeEqual(key, secret)))) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    console.log("=== ML Sync Competitor iniciado ===");

    const tokenRow = await getValidToken();
    const stats = await syncCompetitorPrices(tokenRow);

    const success = stats.items_failed === 0 && stats.alert_errors === 0;
    const result = { success, ...stats, synced_at: new Date().toISOString() };
    console.log("=== ML Sync Competitor finalizado ===", result);
    return Response.json(result, { status: success ? 200 : 500 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("ML Sync Competitor error:", message);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
};
}
