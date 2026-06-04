import { randomUUID, createHash, createHmac } from 'node:crypto';
import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';

// ─── Pusher Channels (same app the mobile listens on) ───
// Lets the store's phones get a real-time notification when a customer places
// an order. Credentials can be overridden via env; defaults match the app.
const PUSHER = {
    appId: process.env.PUSHER_APP_ID || '2152180',
    key: process.env.PUSHER_KEY || '0fa1f776b3ea9e8e337c',
    secret: process.env.PUSHER_SECRET || 'f2d2aedceba1a7a97287',
    cluster: process.env.PUSHER_CLUSTER || 'eu'
};

async function notifyNewOrder(storeId, customerName, total) {
    try {
        const channel = `store-${storeId}`;
        const message = `طلبية جديدة من ${customerName || 'زبون'} — ${Math.round(total)} دج`;
        const data = JSON.stringify({
            Type: 'order',
            Device: 'web',
            UserName: customerName || 'زبون',
            Store: storeId,
            Timestamp: new Date().toISOString(),
            Count: 1,
            Message: message
        });
        const body = JSON.stringify({ name: 'sync-update', channel, data });
        const path = `/apps/${PUSHER.appId}/events`;
        const ts = Math.floor(Date.now() / 1000).toString();
        const bodyMd5 = createHash('md5').update(body).digest('hex');
        const qs = `auth_key=${PUSHER.key}&auth_timestamp=${ts}&auth_version=1.0&body_md5=${bodyMd5}`;
        const sig = createHmac('sha256', PUSHER.secret)
            .update(`POST\n${path}\n${qs}`).digest('hex');
        const url = `https://api-${PUSHER.cluster}.pusher.com${path}?${qs}&auth_signature=${sig}`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        });
    } catch (err) {
        // Best-effort — never block order creation on the notification.
        console.error('[orders] pusher notify failed', err);
    }
}

/**
 * Orders live in a dedicated Turso table per store_id (multi-tenant).
 *
 * Schema:
 *   bws_pending_orders(
 *     uuid TEXT PRIMARY KEY,
 *     store_id TEXT NOT NULL,
 *     customer_uuid TEXT,
 *     customer_name TEXT,
 *     customer_phone TEXT,
 *     items_json TEXT NOT NULL,
 *     total REAL NOT NULL,
 *     status TEXT NOT NULL,
 *     notes TEXT,
 *     created_at TEXT NOT NULL
 *   )
 */

let _schemaReady = false;
async function ensureSchema(client) {
    if (_schemaReady) return;
    await client.batch([
        `CREATE TABLE IF NOT EXISTS bws_pending_orders (
            uuid TEXT PRIMARY KEY,
            store_id TEXT NOT NULL,
            customer_uuid TEXT,
            customer_name TEXT,
            customer_phone TEXT,
            items_json TEXT NOT NULL,
            total REAL NOT NULL,
            status TEXT NOT NULL,
            notes TEXT,
            created_at TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_bws_orders_store
            ON bws_pending_orders(store_id, status, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_bws_orders_customer
            ON bws_pending_orders(customer_uuid, created_at)`
    ], 'write');
    _schemaReady = true;
}

export default async function handler(req, res) {
    try {
        const session = readSessionFromRequest(req);
        if (!session || !session.storeId) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }

        const client = getTursoClient();
        await ensureSchema(client);

        if (req.method === 'POST') {
            const { items, notes, phone, name } = req.body || {};
            if (!Array.isArray(items) || items.length === 0) {
                res.status(400).json({ error: 'السلة فارغة' });
                return;
            }

            const cleanItems = items.map(it => ({
                uuid: it.uuid || null,
                id: it.id ?? null,
                name: String(it.name || ''),
                price: Number(it.price || 0),
                quantity: Number(it.quantity || 0),
                unitType: it.unitType || 'قطعة'
            })).filter(it => it.name && it.quantity > 0);

            if (cleanItems.length === 0) {
                res.status(400).json({ error: 'لا توجد منتجات صالحة في السلة' });
                return;
            }

            // Anti-spam: only authenticated customers reach here, and each
            // customer is capped at a small number of pending orders so nobody
            // can flood the store's order table.
            if (session.customerUuid) {
                const cntRes = await client.execute({
                    sql: `SELECT COUNT(*) AS c FROM bws_pending_orders
                          WHERE store_id = ? AND customer_uuid = ? AND status = 'pending'`,
                    args: [session.storeId, session.customerUuid]
                });
                const pendingCount = Number(cntRes.rows[0]?.c || 0);
                if (pendingCount >= 20) {
                    res.status(429).json({
                        error: 'لديك عدد كبير من الطلبيات المعلقة. انتظر حتى تتم معالجتها قبل إرسال طلب جديد.'
                    });
                    return;
                }
            }

            const total = cleanItems.reduce((s, it) => s + it.price * it.quantity, 0);
            const orderUuid = randomUUID();
            const createdAt = new Date().toISOString();

            await client.execute({
                sql: `INSERT INTO bws_pending_orders
                      (uuid, store_id, customer_uuid, customer_name, customer_phone,
                       items_json, total, status, notes, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
                args: [
                    orderUuid,
                    session.storeId,
                    session.customerUuid || null,
                    (name || session.name || '').toString().slice(0, 200),
                    (phone || session.phone || '').toString().slice(0, 50),
                    JSON.stringify(cleanItems),
                    total,
                    (notes || '').toString().slice(0, 1000),
                    createdAt
                ]
            });

            // Real-time push to the store's devices (best-effort).
            await notifyNewOrder(
                session.storeId,
                (name || session.name || '').toString(),
                total
            );

            res.status(201).json({ ok: true, uuid: orderUuid, total, status: 'pending', createdAt });
            return;
        }

        if (req.method === 'GET') {
            const result = await client.execute({
                sql: `SELECT uuid, total, status, items_json, created_at
                      FROM bws_pending_orders
                      WHERE store_id = ? AND customer_uuid = ?
                      ORDER BY created_at DESC LIMIT 50`,
                args: [session.storeId, session.customerUuid]
            });
            const orders = result.rows.map(r => ({
                uuid: r.uuid,
                total: Number(r.total),
                status: r.status,
                items: JSON.parse(r.items_json || '[]'),
                createdAt: r.created_at
            }));
            res.status(200).json({ orders });
            return;
        }

        res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('[orders] error', err);
        res.status(500).json({ error: 'تعذّر إرسال الطلب' });
    }
}
