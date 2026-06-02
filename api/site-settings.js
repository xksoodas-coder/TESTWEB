import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';

/**
 * Per-store website settings, stored on the server so every customer who
 * logs in with a given store code sees the layout/theme the shop's admin
 * configured for that code.
 *
 *   GET  /api/site-settings   → { settings }   (any logged-in customer)
 *   POST /api/site-settings   → { ok: true }   (admin session only)
 *
 * Table: bws_site_settings(store_id TEXT PRIMARY KEY, settings_json TEXT,
 *                          updated_at TEXT)
 */

async function ensureTable(client) {
    await client.execute(`
        CREATE TABLE IF NOT EXISTS bws_site_settings (
            store_id    TEXT PRIMARY KEY,
            settings_json TEXT NOT NULL DEFAULT '{}',
            updated_at  TEXT
        )
    `);
}

export default async function handler(req, res) {
    try {
        const session = readSessionFromRequest(req);
        if (!session || !session.storeId) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }

        const client = getTursoClient();
        await ensureTable(client);

        if (req.method === 'GET') {
            const r = await client.execute({
                sql: `SELECT settings_json FROM bws_site_settings WHERE store_id = ?`,
                args: [session.storeId]
            });
            let settings = null;
            if (r.rows.length) {
                try { settings = JSON.parse(r.rows[0].settings_json); } catch { settings = null; }
            }
            res.setHeader('Cache-Control', 'private, max-age=10');
            res.status(200).json({ settings });
            return;
        }

        if (req.method === 'POST') {
            if (!session.isAdmin) {
                res.status(403).json({ error: 'صلاحية الإدارة مطلوبة' });
                return;
            }
            const incoming = req.body?.settings;
            if (!incoming || typeof incoming !== 'object') {
                res.status(400).json({ error: 'إعدادات غير صالحة' });
                return;
            }
            const json = JSON.stringify(incoming);
            await client.execute({
                sql: `INSERT INTO bws_site_settings (store_id, settings_json, updated_at)
                      VALUES (?, ?, ?)
                      ON CONFLICT(store_id) DO UPDATE SET
                          settings_json = excluded.settings_json,
                          updated_at    = excluded.updated_at`,
                args: [session.storeId, json, new Date().toISOString()]
            });
            res.status(200).json({ ok: true });
            return;
        }

        res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('[site-settings] error', err);
        res.status(500).json({ error: 'تعذّر تحميل إعدادات الموقع' });
    }
}
