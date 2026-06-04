import { getTursoClient } from './_lib/turso.js';
import { ensureTenantsTable, invalidateTenantCache } from './_lib/tenant.js';

/**
 * Platform-owner management of the tenant registry (bws_tenants).
 * Protected by the x-platform-key header which must equal BWS_PLATFORM_ADMIN_KEY.
 *
 *   GET    /api/tenants                 → list all tenants
 *   POST   /api/tenants  { ... }        → create/update a tenant (upsert by store_id)
 *   DELETE /api/tenants  { storeId }    → remove a tenant
 *
 * This is for YOU (the platform owner), not for individual store admins.
 */
function authorized(req) {
    const key = process.env.BWS_PLATFORM_ADMIN_KEY;
    if (!key) return false;
    return (req.headers['x-platform-key'] || '') === key;
}

function cleanSlug(s) {
    return (s || '').toString().trim().toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')   // safe DNS label
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

export default async function handler(req, res) {
    if (!authorized(req)) {
        res.status(401).json({ error: 'مفتاح المنصّة غير صحيح' });
        return;
    }

    try {
        const client = getTursoClient();
        await ensureTenantsTable(client);

        if (req.method === 'GET') {
            const r = await client.execute(
                `SELECT store_id, slug, custom_domain, domain_status, display_name,
                        is_active, plan, created_at, updated_at
                 FROM bws_tenants ORDER BY created_at DESC`
            );
            const tenants = r.rows.map(row => ({
                storeId: row.store_id,
                slug: row.slug,
                customDomain: row.custom_domain || '',
                domainStatus: row.domain_status || 'none',
                displayName: row.display_name || '',
                isActive: Number(row.is_active) !== 0,
                plan: row.plan || 'basic',
                createdAt: row.created_at,
                updatedAt: row.updated_at
            }));
            res.status(200).json({ tenants });
            return;
        }

        if (req.method === 'POST') {
            const b = req.body || {};
            const storeId = (b.storeId || '').toString().trim();
            const slug = cleanSlug(b.slug);
            if (!storeId || !slug) {
                res.status(400).json({ error: 'storeId و slug مطلوبان' });
                return;
            }
            const customDomain = (b.customDomain || '').toString().trim().toLowerCase() || null;
            const displayName = (b.displayName || '').toString().slice(0, 200);
            const isActive = b.isActive === false ? 0 : 1;
            const domainStatus = (b.domainStatus || (customDomain ? 'pending' : 'none')).toString();
            const plan = (b.plan || 'basic').toString();
            const now = new Date().toISOString();

            // Guard: slug / custom_domain must be unique to a different store.
            const dup = await client.execute({
                sql: `SELECT store_id FROM bws_tenants
                      WHERE (slug = ? OR (custom_domain IS NOT NULL AND custom_domain = ?))
                        AND store_id <> ?`,
                args: [slug, customDomain, storeId]
            });
            if (dup.rows.length) {
                res.status(409).json({ error: 'الـ slug أو الدومين مستعمل من متجر آخر' });
                return;
            }

            await client.execute({
                sql: `INSERT INTO bws_tenants
                        (store_id, slug, custom_domain, domain_status, display_name, is_active, plan, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(store_id) DO UPDATE SET
                        slug = excluded.slug,
                        custom_domain = excluded.custom_domain,
                        domain_status = excluded.domain_status,
                        display_name = excluded.display_name,
                        is_active = excluded.is_active,
                        plan = excluded.plan,
                        updated_at = excluded.updated_at`,
                args: [storeId, slug, customDomain, domainStatus, displayName, isActive, plan, now, now]
            });
            invalidateTenantCache();
            res.status(200).json({ ok: true });
            return;
        }

        if (req.method === 'DELETE') {
            const storeId = (req.body?.storeId || '').toString().trim();
            if (!storeId) { res.status(400).json({ error: 'storeId مطلوب' }); return; }
            await client.execute({
                sql: `DELETE FROM bws_tenants WHERE store_id = ?`,
                args: [storeId]
            });
            invalidateTenantCache();
            res.status(200).json({ ok: true });
            return;
        }

        res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('[tenants] error', err);
        res.status(500).json({ error: 'خطأ في إدارة المتاجر' });
    }
}
