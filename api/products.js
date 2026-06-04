import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';
import { productImageUrl } from './_lib/r2.js';

/**
 * Reduce the Products changelog the same way the desktop / mobile apps do.
 *
 * Events (ordered by timestamp):
 *   INSERT / UPDATE  → carry the FULL product state, including the absolute
 *                      totalQuantity at that moment.
 *   QUANTITY_DELTA   → carry only { totalQuantityDelta }, applied on top of
 *                      the latest full state (CRDT for concurrent sales).
 *   DELETE           → remove the product.
 *
 * Naively taking "the latest event" breaks because a QUANTITY_DELTA after a
 * sale has no name/family — the product would vanish. So we keep the latest
 * full payload and only add deltas that happened AFTER it (an UPDATE already
 * re-snapshots the absolute quantity, so earlier deltas are baked in).
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
            // Only matters if it happened after the latest full snapshot.
            if (data && ts > entry.fullTs) {
                entry.deltaAfter += Number(data.totalQuantityDelta || 0);
            }
        } else {
            // INSERT / UPDATE — a fresh absolute snapshot.
            if (data && ts >= entry.fullTs) {
                entry.full = data;
                entry.fullTs = ts;
                entry.deltaAfter = 0;     // snapshot already includes prior deltas
                entry.deleted = false;    // a new snapshot revives the record
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
 * GET /api/products?family=<name>&favorites=1
 * Auth: Bearer <session token> (required — storeId comes from the token)
 *
 * Walks turso_changelog for table_name='Products', reduces to the latest
 * payload per record_uuid, and returns rows where the camelCase `family`
 * field matches the requested name. Each product carries an `isFavorite`
 * flag; with favorites=1 only the customer's favourites are returned.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const session = readSessionFromRequest(req);
        if (!session || !session.storeId) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }

        const familyFilter = (req.query?.family || '').toString().trim();
        const favoritesOnly = String(req.query?.favorites || '') === '1';
        // Optional server-side pagination (used by the "all products" storefront
        // mode). limit<=0 / missing → return everything.
        const limit = Math.max(0, parseInt(req.query?.limit, 10) || 0);
        const offset = Math.max(0, parseInt(req.query?.offset, 10) || 0);

        const client = getTursoClient();

        // Load the customer's favourites (best-effort; table may not exist yet).
        let favSet = new Set();
        if (session.customerUuid) {
            try {
                const favRes = await client.execute({
                    sql: `SELECT product_uuid FROM bws_favorites
                          WHERE store_id = ? AND customer_uuid = ?`,
                    args: [session.storeId, session.customerUuid]
                });
                favSet = new Set(favRes.rows.map(r => r.product_uuid));
            } catch { /* table missing → no favourites yet */ }
        }

        const result = await client.execute({
            sql: `SELECT record_uuid, operation, json_payload, timestamp
                  FROM turso_changelog
                  WHERE store_id = ? AND table_name = 'Products'
                  ORDER BY timestamp ASC`,
            args: [session.storeId]
        });

        const latest = reduceProducts(result.rows);
        const products = [];
        for (const [recordUuid, entry] of latest) {
            const data = entry.data;
            const family = (data.family || '').toString().trim();
            if (familyFilter && family !== familyFilter) continue;

            const isFavorite = favSet.has(recordUuid);
            if (favoritesOnly && !isFavorite) continue;

            const totalQty = Number(entry.quantity ?? 0);
            const imageVersion = data.imageVersion ?? '';
            const price1 = Number(data.sellPrice ?? 0);
            const price2 = Number(data.wholesalePrice ?? 0);
            const price3 = Number(data.price3 ?? 0);
            products.push({
                uuid: recordUuid,
                id: data.id ?? null,
                name: data.name ?? '',
                family,
                price: price1,
                price1,
                price2,
                price3,
                quantity: totalQty,
                available: totalQty > 0,
                unitType: data.unitType ?? 'قطعة',
                imageVersion,
                imageUrl: imageVersion ? productImageUrl(recordUuid, imageVersion) : '',
                barcode: data.barcode ?? '',
                isFavorite
            });
        }

        products.sort((a, b) => a.name.localeCompare(b.name, 'ar'));

        const total = products.length;
        const paged = limit > 0 ? products.slice(offset, offset + limit) : products;

        res.setHeader('Cache-Control', 'private, max-age=15');
        res.status(200).json({ products: paged, total });
    } catch (err) {
        console.error('[products] error', err);
        res.status(500).json({ error: 'تعذّر تحميل المنتجات' });
    }
}
