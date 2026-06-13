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

// ===== EXPERIMENTAL incremental projection into bws_products (staging only) =====
// Keeps the current-state table in sync with the changelog automatically:
//   INSERT/UPDATE → upsert the product's ONE row (newer snapshot wins by ts)
//   DELETE        → remove the row
//   QUANTITY_DELTA→ adjust the row's quantity (only deltas after the snapshot)
// A per-store cursor (last processed changelog rowid) makes it process ONLY new
// events each call — so cost stays flat no matter how big the changelog grows.
let _productsInfraReady = false;
async function ensureProductsTableInfra(client) {
    if (_productsInfraReady) return;
    await client.execute(`CREATE TABLE IF NOT EXISTS bws_products (
        store_id TEXT NOT NULL, uuid TEXT NOT NULL, name TEXT, family TEXT,
        quantity REAL DEFAULT 0, available INTEGER DEFAULT 0, sell_price REAL DEFAULT 0,
        wholesale_price REAL DEFAULT 0, price3 REAL DEFAULT 0, unit_type TEXT, barcode TEXT,
        image_version TEXT, web_visible INTEGER DEFAULT 1, last_ts TEXT, updated_at TEXT,
        PRIMARY KEY (store_id, uuid)
    )`);
    // The table may pre-exist (manual load) without last_ts → add + backfill.
    try { await client.execute(`ALTER TABLE bws_products ADD COLUMN last_ts TEXT`); } catch { /* exists */ }
    try { await client.execute(`UPDATE bws_products SET last_ts = '' WHERE last_ts IS NULL`); } catch { /* ignore */ }
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_bws_products_family ON bws_products(store_id, family)`);
    await client.execute(`CREATE TABLE IF NOT EXISTS bws_projection_cursor (
        store_id TEXT PRIMARY KEY, last_rowid INTEGER DEFAULT 0, updated_at INTEGER
    )`);
    _productsInfraReady = true;
}

async function projectNewEvents(client, storeId) {
    // Read (or initialise) the per-store cursor.
    const cur = await client.execute({
        sql: `SELECT last_rowid FROM bws_projection_cursor WHERE store_id = ?`,
        args: [storeId]
    });
    let lastRowid;
    if (cur.rows.length) {
        lastRowid = Number(cur.rows[0].last_rowid) || 0;
    } else {
        // First run: the table was already loaded (manual), so skip history and
        // start from the current max rowid → only future edits are projected.
        const mx = await client.execute({
            sql: `SELECT COALESCE(MAX(rowid), 0) AS m FROM turso_changelog
                  WHERE store_id = ? AND table_name = 'Products'`,
            args: [storeId]
        });
        lastRowid = Number(mx.rows[0].m) || 0;
        await client.execute({
            sql: `INSERT OR REPLACE INTO bws_projection_cursor (store_id, last_rowid, updated_at) VALUES (?, ?, ?)`,
            args: [storeId, lastRowid, Date.now()]
        });
        return;
    }

    const ev = await client.execute({
        sql: `SELECT rowid AS rid, record_uuid, operation, json_payload, timestamp
              FROM turso_changelog
              WHERE store_id = ? AND table_name = 'Products' AND rowid > ?
              ORDER BY rowid ASC LIMIT 5000`,
        args: [storeId, lastRowid]
    });
    if (!ev.rows.length) return;

    const stmts = [];
    let maxRowid = lastRowid;
    for (const r of ev.rows) {
        const rid = Number(r.rid);
        if (rid > maxRowid) maxRowid = rid;
        const op = r.operation;
        const ts = (r.timestamp || '').toString();
        const uuid = r.record_uuid;

        if (op === 'DELETE') {
            stmts.push({
                sql: `DELETE FROM bws_products
                      WHERE store_id = ? AND uuid = ? AND COALESCE(last_ts,'') <= ?`,
                args: [storeId, uuid, ts]
            });
        } else if (op === 'QUANTITY_DELTA') {
            let delta = 0;
            try { delta = Number(JSON.parse(r.json_payload).totalQuantityDelta || 0); } catch { /* skip */ }
            if (delta !== 0) {
                stmts.push({
                    sql: `UPDATE bws_products
                          SET quantity = quantity + ?,
                              available = CASE WHEN quantity + ? > 0 THEN 1 ELSE 0 END,
                              updated_at = ?
                          WHERE store_id = ? AND uuid = ? AND COALESCE(last_ts,'') < ?`,
                    args: [delta, delta, ts, storeId, uuid, ts]
                });
            }
        } else {
            // INSERT / UPDATE — a full snapshot.
            let d = null;
            try { d = JSON.parse(r.json_payload); } catch { /* skip */ }
            if (d) {
                const qty = Number(d.totalQuantity ?? 0);
                const hidden = d.webVisible === false ? 0 : 1;
                stmts.push({
                    sql: `INSERT INTO bws_products
                            (store_id, uuid, name, family, quantity, available, sell_price,
                             wholesale_price, price3, unit_type, barcode, image_version,
                             web_visible, last_ts, updated_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                          ON CONFLICT(store_id, uuid) DO UPDATE SET
                            name=excluded.name, family=excluded.family, quantity=excluded.quantity,
                            available=excluded.available, sell_price=excluded.sell_price,
                            wholesale_price=excluded.wholesale_price, price3=excluded.price3,
                            unit_type=excluded.unit_type, barcode=excluded.barcode,
                            image_version=excluded.image_version, web_visible=excluded.web_visible,
                            last_ts=excluded.last_ts, updated_at=excluded.updated_at
                          WHERE excluded.last_ts >= COALESCE(bws_products.last_ts,'')`,
                    args: [storeId, uuid, d.name ?? '', String(d.family ?? '').trim(),
                           qty, qty > 0 ? 1 : 0, Number(d.sellPrice ?? 0),
                           Number(d.wholesalePrice ?? 0), Number(d.price3 ?? 0),
                           d.unitType ?? 'قطعة', d.barcode ?? '', d.imageVersion ?? '',
                           hidden, ts, ts]
                });
            }
        }
    }

    stmts.push({
        sql: `INSERT INTO bws_projection_cursor (store_id, last_rowid, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(store_id) DO UPDATE SET last_rowid=excluded.last_rowid, updated_at=excluded.updated_at`,
        args: [storeId, maxRowid, Date.now()]
    });

    await client.batch(stmts, 'write');
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

    // EXPERIMENTAL (staging only): auto-project new changelog events into the
    // current-state table, then read straight from it.
    if (process.env.USE_PRODUCTS_TABLE === '1') {
        await ensureProductsTableInfra(client);
        try { await projectNewEvents(client, storeId); }
        catch (e) { console.error('[projection] error', e); }
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
