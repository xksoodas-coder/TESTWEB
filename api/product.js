import { getTursoClient } from './_lib/turso.js';
import { resolveReadAccess } from './_lib/access.js';
import { productImageUrl } from './_lib/r2.js';

/**
 * GET /api/product?uuid=<recordUuid>
 *
 * Returns the FULL detail of a single product — including the short and full
 * descriptions — by reading ONLY that product's changelog rows (not the whole
 * catalogue). The product list endpoint never returns descriptions, so they are
 * fetched lazily, only when a customer opens a specific product.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    try {
        const access = await resolveReadAccess(req);
        if (!access) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }
        const uuid = (req.query?.uuid || '').toString().trim();
        if (!uuid) {
            res.status(400).json({ error: 'معرّف المنتج مطلوب' });
            return;
        }

        const client = getTursoClient();
        const r = await client.execute({
            sql: `SELECT operation, json_payload, timestamp
                  FROM turso_changelog
                  WHERE store_id = ? AND table_name = 'Products' AND record_uuid = ?
                  ORDER BY timestamp ASC`,
            args: [access.storeId, uuid]
        });

        // Reduce this product's events (latest full snapshot + later deltas).
        let full = null, fullTs = '', deltaAfter = 0, deleted = false, lastTs = '';
        for (const row of r.rows) {
            const op = row.operation, ts = row.timestamp;
            let data = null;
            try { data = JSON.parse(row.json_payload); } catch { /* ignore */ }
            if (op === 'DELETE') {
                if (ts >= lastTs) deleted = true;
            } else if (op === 'QUANTITY_DELTA') {
                if (data && ts > fullTs) deltaAfter += Number(data.totalQuantityDelta || 0);
            } else {
                if (data && ts >= fullTs) { full = data; fullTs = ts; deltaAfter = 0; deleted = false; }
            }
            if (ts >= lastTs) lastTs = ts;
        }

        if (!full || deleted || full.webVisible === false) {
            res.status(404).json({ error: 'المنتج غير متاح' });
            return;
        }

        const qty = Number(full.totalQuantity ?? 0) + deltaAfter;
        const imageVersion = full.imageVersion ?? '';
        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
            uuid,
            name: full.name ?? '',
            shortDescription: full.shortDescription ?? '',
            description: full.description ?? '',
            price: Number(full.sellPrice ?? 0),
            price1: Number(full.sellPrice ?? 0),
            price2: Number(full.wholesalePrice ?? 0),
            price3: Number(full.price3 ?? 0),
            quantity: qty,
            available: qty > 0,
            unitType: full.unitType ?? 'قطعة',
            family: (full.family || '').toString().trim(),
            imageUrl: imageVersion ? productImageUrl(uuid, imageVersion) : ''
        });
    } catch (err) {
        console.error('[product] error', err);
        res.status(500).json({ error: 'تعذّر تحميل المنتج' });
    }
}
