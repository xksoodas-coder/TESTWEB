import { resolveTenant } from './_lib/tenant.js';

/**
 * GET /api/tenant
 * Resolves the storefront's tenant from the request (custom domain / subdomain
 * / ?store= slug) and returns its public identity. Used by the storefront to
 * know which store it is BEFORE the customer logs in (branding + login).
 *
 * Never returns secrets — storeId here is the same public store code customers
 * already use.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    try {
        const t = await resolveTenant(req);
        if (!t) {
            res.setHeader('Cache-Control', 'public, max-age=15');
            res.status(200).json({ found: false });
            return;
        }
        if (!t.active) {
            res.status(200).json({ found: true, active: false, name: t.name });
            return;
        }
        res.setHeader('Cache-Control', 'public, max-age=30');
        res.status(200).json({
            found: true,
            active: true,
            storeId: t.storeId,
            slug: t.slug,
            name: t.name
        });
    } catch (err) {
        console.error('[tenant] error', err);
        res.status(500).json({ error: 'تعذّر تحديد المتجر' });
    }
}
