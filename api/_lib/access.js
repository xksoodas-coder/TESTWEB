import { getTursoClient } from './turso.js';
import { readSessionFromRequest } from './session.js';
import { resolveTenant } from './tenant.js';

/**
 * Helpers for store access.
 *
 * Two storefront modes (per-store, in bws_site_settings.orderMode):
 *   - 'cart'   (default): private — a registered customer must log in.
 *   - 'direct'         : public  — guests order via a landing form (no login).
 *
 * Reads (products/categories/store) are allowed for guests ONLY when the
 * store opted into 'direct' mode, so 'cart' stores stay private.
 */

let _settingsCache = new Map(); // storeId -> { at, settings }
const SETTINGS_TTL = 15 * 1000;

export async function getStoreSettings(storeId) {
    const cached = _settingsCache.get(storeId);
    if (cached && Date.now() - cached.at < SETTINGS_TTL) return cached.settings;
    let settings = {};
    try {
        const client = getTursoClient();
        const r = await client.execute({
            sql: `SELECT settings_json FROM bws_site_settings WHERE store_id = ?`,
            args: [storeId]
        });
        if (r.rows.length) settings = JSON.parse(r.rows[0].settings_json) || {};
    } catch { /* table may not exist yet */ }
    _settingsCache.set(storeId, { at: Date.now(), settings });
    return settings;
}

/** { storeId, guest, session?, tenant? } or null. guest = resolved from tenant (no session). */
export async function resolveStoreAccess(req) {
    const session = readSessionFromRequest(req);
    if (session && session.storeId) {
        return { storeId: session.storeId, guest: false, session };
    }
    const tenant = await resolveTenant(req).catch(() => null);
    if (tenant && tenant.storeId) {
        return { storeId: tenant.storeId, guest: true, tenant };
    }
    return null;
}

/** Read access for products/categories/store — guests need orderMode === 'direct'. */
export async function resolveReadAccess(req) {
    const acc = await resolveStoreAccess(req);
    if (!acc) return null;
    if (!acc.guest) return acc;
    const settings = await getStoreSettings(acc.storeId);
    if (settings.orderMode === 'direct') return acc;
    return null;
}
