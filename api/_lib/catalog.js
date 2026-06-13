import { getTursoClient } from './turso.js';
import { productImageUrl } from './r2.js';

/**
 * Shared catalog layer (server-side).
 *
 * The storefront used to reduce the ENTIRE `turso_changelog` (every product
 * event ever recorded, including a QUANTITY_DELTA per sale) on every single
 * page load — an unbounded, un-cached scan that grew with the store's whole
 * sales history. This module replaces that with a per-store materialised
 * snapshot:
 *
 *   bws_catalog_snapshot(store_id PK, products_json, updated_at)
 *
 * `getCatalog()` returns the snapshot instantly when it is younger than
 * CATALOG_TTL; otherwise it rebuilds it from the changelog once, writes the
 * snapshot, and serves it. So the expensive reduction runs at most once per
 * TTL window per store, no matter how many customers hit the storefront.
 *
 * Stock can be up to CATALOG_TTL stale here — that is safe because stock is
 * re-validated server-side at order time (same guarantee the client SWR cache
 * already relies on).
 *
 * The snapshot stores the fully-shaped product list WITHOUT the per-customer
 * `isFavorite` flag (that is applied per request by the caller) so the same
 * bytes are valid for every customer of the tenant.
 */

const CATALOG_TTL_MS = 60 * 1000; // rebuild the DB snapshot at most once/min per store
const MEM_TTL_MS = 20 * 1000;     // serve a warm instance from RAM without any DB read

// Per-instance parsed-catalog cache: storeId → { at, products }. Avoids reading
// and re-parsing the (possibly multi-MB) snapshot row on every warm request.
const _memCatalog = new Map();

// Ensure the snapshot table (and, best-effort, the composite changelog index)
// exist. Guarded so the DDL runs at most once per warm serverless instance,
// never per request. The table and the index are created separately so a slow
// first-time index build on a large changelog can't block snapshot usage (and
// the index is also created canonically by the desktop sync engine).
let _infraReady = false;
export async function ensureCatalogInfra(client) {
    if (_infraReady) return;
    await client.execute(`CREATE TABLE IF NOT EXISTS bws_catalog_snapshot (
        store_id     TEXT PRIMARY KEY,
        products_json TEXT NOT NULL DEFAULT '[]',
        updated_at   INTEGER NOT NULL DEFAULT 0
    )`);
    // The hot storefront query filters by (store_id, table_name) and orders by
    // timestamp. Without this composite index it scans every row of the store's
    // changelog (invoices, payments, ...) to find the Products rows.
    try {
        await client.execute(`CREATE INDEX IF NOT EXISTS idx_changelog_store_table_ts
            ON turso_changelog(store_id, table_name, timestamp)`);
    } catch { /* index build slow/unavailable → snapshot still works */ }
    _infraReady = true;
}

/**
 * Reduce the Products changelog the same way the desktop / mobile apps do.
 * INSERT/UPDATE carry a full snapshot (absolute totalQuantity); QUANTITY_DELTA
 * adds on top of the latest full snapshot (CRDT for concurrent sales); DELETE
 * removes the product.
 */
function reduceProducts(rows) {
    const state = new Map(); // record_uuid → {full, fullTs, deltaAfter, lastTs, deleted}

    for (const row of rows) {
        const uuid = row.record_uuid;
        const op = row.operation;
        const ts = row.timestamp;
        let entry = state.get(uuid);
        if (!entry) {
            entry = { full: null, fullTs: '', deltaAfter: 0, lastTs: '', deleted: false };
            state.set(uuid, entry);
        }

        let data = null;
        try { data = JSON.parse(row.json_payload); } catch { /* ignore */ }

        if (op === 'DELETE') {
            if (ts >= entry.lastTs) entry.deleted = true;
        } else if (op === 'QUANTITY_DELTA') {
            if (data && ts > entry.fullTs) {
                entry.deltaAfter += Number(data.totalQuantityDelta || 0);
            }
        } else {
            if (data && ts >= entry.fullTs) {
                entry.full = data;
                entry.fullTs = ts;
                entry.deltaAfter = 0;
                entry.deleted = false;
            }
        }
        if (ts >= entry.lastTs) entry.lastTs = ts;
    }

    const out = new Map();
    for (const [uuid, e] of state) {
        if (e.deleted || !e.full) continue;
        out.set(uuid, {
            data: e.full,
            quantity: Number(e.full.totalQuantity ?? 0) + e.deltaAfter
        });
    }
    return out;
}

/**
 * Build the fully-shaped catalog for a store directly from the changelog.
 * Returns an array of products (sorted by name), WITHOUT per-customer flags.
 */
export async function buildCatalog(client, storeId) {
    const result = await client.execute({
        sql: `SELECT record_uuid, operation, json_payload, timestamp
              FROM turso_changelog
              WHERE store_id = ? AND table_name = 'Products'
              ORDER BY timestamp ASC`,
        args: [storeId]
    });

    // Extra prices (4..7) live in a standalone table keyed by product uuid.
    let extraPrices = {};
    try {
        const ep = await client.execute({
            sql: `SELECT json_payload FROM turso_product_extra_prices WHERE store_id = ? LIMIT 1`,
            args: [storeId]
        });
        if (ep.rows.length && ep.rows[0].json_payload) {
            extraPrices = JSON.parse(ep.rows[0].json_payload) || {};
        }
    } catch { /* table may not exist yet */ }

    // Per-product sizes/capacities from ProductSizes events (latest wins).
    const sizesByUuid = {};
    try {
        const sz = await client.execute({
            sql: `SELECT record_uuid, json_payload, timestamp
                  FROM turso_changelog
                  WHERE store_id = ? AND table_name = 'ProductSizes'
                  ORDER BY timestamp ASC`,
            args: [storeId]
        });
        for (const r of sz.rows) {
            // Desktop/mobile emit the payload as { Rows: [{SizeName, Capacity}, ...] }
            // (NOT a bare array) — read .Rows so the sizes aren't dropped (was the
            // bug that made product sizes show empty on the storefront).
            let parsed = null;
            try { parsed = JSON.parse(r.json_payload); } catch { /* skip */ }
            const arr = Array.isArray(parsed)
                ? parsed
                : (parsed && Array.isArray(parsed.Rows)) ? parsed.Rows
                : (parsed && Array.isArray(parsed.rows)) ? parsed.rows
                : [];
            sizesByUuid[r.record_uuid] = arr
                .map(s => ({
                    name: String(s.SizeName ?? s.sizeName ?? s.name ?? ''),
                    capacity: Number(s.Capacity ?? s.capacity ?? 0)
                }))
                .filter(s => s.name && s.capacity > 0);
        }
    } catch { /* table may not exist yet */ }

    const latest = reduceProducts(result.rows);
    const products = [];
    for (const [recordUuid, entry] of latest) {
        const data = entry.data;
        // Hidden products never appear on the storefront (default = visible).
        if (data.webVisible === false) continue;
        const family = (data.family || '').toString().trim();

        const totalQty = Number(entry.quantity ?? 0);
        const imageVersion = data.imageVersion ?? '';
        const price1 = Number(data.sellPrice ?? 0);
        const price2 = Number(data.wholesalePrice ?? 0);
        const price3 = Number(data.price3 ?? 0);
        const ex = extraPrices[recordUuid] || [];
        const price4 = Number(ex[0] ?? 0);
        const price5 = Number(ex[1] ?? 0);
        const price6 = Number(ex[2] ?? 0);
        const price7 = Number(ex[3] ?? 0);
        products.push({
            uuid: recordUuid,
            id: data.id ?? null,
            name: data.name ?? '',
            family,
            price: price1,
            price1,
            price2,
            price3,
            price4,
            price5,
            price6,
            price7,
            quantity: totalQty,
            available: totalQty > 0,
            unitType: data.unitType ?? 'قطعة',
            imageVersion,
            imageUrl: imageVersion ? productImageUrl(recordUuid, imageVersion) : '',
            barcode: data.barcode ?? '',
            sizes: sizesByUuid[recordUuid] || []
        });
    }

    products.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return products;
}

/**
 * EXPERIMENTAL read model: build the catalog straight from the `bws_products`
 * current-state table (one shaped row per product) instead of reducing the
 * changelog. Enabled per-deployment via env USE_PRODUCTS_TABLE=1 — so it only
 * runs on the staging site, never in production.
 */
async function buildCatalogFromTable(client, storeId) {
    const r = await client.execute({
        sql: `SELECT uuid, name, family, quantity, available, sell_price,
                     wholesale_price, price3, unit_type, barcode, image_version
              FROM bws_products
              WHERE store_id = ? AND web_visible = 1`,
        args: [storeId]
    });
    const products = r.rows.map(row => {
        const price1 = Number(row.sell_price ?? 0);
        const imageVersion = String(row.image_version ?? '');
        const qty = Number(row.quantity ?? 0);
        return {
            uuid: row.uuid,
            id: null,
            name: row.name ?? '',
            family: (row.family ?? '').toString().trim(),
            price: price1,
            price1,
            price2: Number(row.wholesale_price ?? 0),
            price3: Number(row.price3 ?? 0),
            price4: 0, price5: 0, price6: 0, price7: 0,
            quantity: qty,
            available: Number(row.available) === 1,
            unitType: row.unit_type ?? 'قطعة',
            imageVersion,
            imageUrl: imageVersion ? productImageUrl(row.uuid, imageVersion) : '',
            barcode: row.barcode ?? '',
            sizes: []
        };
    });
    products.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return products;
}

/**
 * Return the store's catalog (array of shaped products) using the snapshot
 * cache. Rebuilds from the changelog only when the snapshot is missing or
 * older than CATALOG_TTL_MS. On a rebuild failure, falls back to the stale
 * snapshot rather than throwing.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]  Always rebuild (e.g. right after a known write).
 */
export async function getCatalog(client, storeId, { force = false } = {}) {
    // Warm-instance fast path: skip the DB entirely for a short window.
    if (!force) {
        const mem = _memCatalog.get(storeId);
        if (mem && (Date.now() - mem.at) < MEM_TTL_MS) return mem.products;
    }

    // EXPERIMENTAL (staging only): read the current-state products table.
    if (process.env.USE_PRODUCTS_TABLE === '1') {
        const products = await buildCatalogFromTable(client, storeId);
        _memCatalog.set(storeId, { at: Date.now(), products });
        return products;
    }

    await ensureCatalogInfra(client);

    let stale = null;
    if (!force) {
        try {
            const r = await client.execute({
                sql: `SELECT products_json, updated_at FROM bws_catalog_snapshot WHERE store_id = ?`,
                args: [storeId]
            });
            if (r.rows.length) {
                const updatedAt = Number(r.rows[0].updated_at || 0);
                const fresh = (Date.now() - updatedAt) < CATALOG_TTL_MS;
                const parsed = JSON.parse(r.rows[0].products_json || '[]');
                if (Array.isArray(parsed)) {
                    if (fresh) {
                        _memCatalog.set(storeId, { at: Date.now(), products: parsed });
                        return parsed;
                    }
                    stale = parsed; // keep as a fallback if the rebuild fails
                }
            }
        } catch { /* snapshot unreadable → rebuild below */ }
    }

    try {
        const products = await buildCatalog(client, storeId);
        try {
            await client.execute({
                sql: `INSERT INTO bws_catalog_snapshot (store_id, products_json, updated_at)
                      VALUES (?, ?, ?)
                      ON CONFLICT(store_id) DO UPDATE SET
                          products_json = excluded.products_json,
                          updated_at    = excluded.updated_at`,
                args: [storeId, JSON.stringify(products), Date.now()]
            });
        } catch { /* snapshot write failed → still serve the fresh build */ }
        _memCatalog.set(storeId, { at: Date.now(), products });
        return products;
    } catch (err) {
        if (stale) return stale; // serve stale rather than error out
        throw err;
    }
}

export { CATALOG_TTL_MS };
