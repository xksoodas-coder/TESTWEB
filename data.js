/*
 * BigWebStore – data layer (client-side).
 *
 * Server-backed data (categories, products, customer auth, orders) goes
 * through fetch() to /api/* endpoints. Local UI state (cart, theme, hidden
 * categories, admin auth) stays in localStorage so the page survives reloads.
 */

const BWS = (function () {
    // ----- localStorage keys -----
    const LS_HIDDEN = 'bws_hidden_categories';
    const LS_CART = 'bws_cart';
    const LS_SETTINGS = 'bws_settings';
    const LS_SESSION_TOKEN = 'bws_session_token';
    const LS_CUSTOMER = 'bws_customer';
    const LS_ADMIN_TOKEN = 'bws_admin_token';
    const LS_ADMIN_SESSION = 'bws_admin_session';
    const LS_PRICE_TIER = 'bws_price_tier'; // global selected price tier (1/2/3)

    const DEFAULT_SETTINGS = {
        theme: {
            primary: '#ed5a1a',
            primaryDark: '#c94a14',
            primaryLight: '#ff7c3e'
        },
        announcement: '',
        cartMode: 'page',
        // Storefront layout: 'categories' = show category tiles first,
        // 'products' = show all products directly (paginated).
        displayMode: 'categories',
        pageSize: 25
    };

    // In-memory cache, refilled per page load.
    let _familiesCache = null;
    let _storeInfoCache = null;
    const _productsByFamily = new Map();

    // ----- small storage helpers -----
    function readJSON(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
        catch { return fallback; }
    }
    function writeJSON(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    // ----- settings (admin) -----
    function getSettings() {
        const raw = readJSON(LS_SETTINGS, null);
        if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        const pageSize = Number(raw.pageSize);
        return {
            theme: { ...DEFAULT_SETTINGS.theme, ...(raw.theme || {}) },
            announcement: typeof raw.announcement === 'string'
                ? raw.announcement : DEFAULT_SETTINGS.announcement,
            cartMode: raw.cartMode === 'sidebar' ? 'sidebar' : 'page',
            displayMode: raw.displayMode === 'products' ? 'products' : 'categories',
            pageSize: Number.isFinite(pageSize) && pageSize > 0
                ? Math.min(200, Math.floor(pageSize)) : DEFAULT_SETTINGS.pageSize
        };
    }
    function setSettings(next) {
        writeJSON(LS_SETTINGS, { ...getSettings(), ...next });
    }

    // ----- admin auth (server-backed token) -----
    const getAdminToken = () => localStorage.getItem(LS_ADMIN_TOKEN) || null;
    const getAdminSession = () => readJSON(LS_ADMIN_SESSION, null);
    const isAdminAuthed = () => !!getAdminToken();

    // ----- hidden categories (admin toggle) -----
    const getHiddenIds = () => readJSON(LS_HIDDEN, []);
    const setHiddenIds = (ids) => writeJSON(LS_HIDDEN, ids);

    // ----- cart -----
    // Items now carry their own snapshot of price/name/family/unitType/uuid
    // so the cart page does not need to re-query the server.
    const getCart = () => readJSON(LS_CART, []);
    const setCart = (items) => writeJSON(LS_CART, items);

    // ----- session -----
    const getSessionToken = () => localStorage.getItem(LS_SESSION_TOKEN) || null;
    const setSessionToken = (t) => {
        if (t) localStorage.setItem(LS_SESSION_TOKEN, t);
        else localStorage.removeItem(LS_SESSION_TOKEN);
    };
    const getCustomerSession = () => readJSON(LS_CUSTOMER, null);
    const clearCustomerSession = () => {
        localStorage.removeItem(LS_CUSTOMER);
        localStorage.removeItem(LS_SESSION_TOKEN);
    };

    // ----- API helper -----
    async function apiFetch(path, options = {}) {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        // Storefront calls use the customer token; admin calls use the admin
        // token. On a pure-admin browser (no customer session) fall back to the
        // admin token so shared GET endpoints (categories) still authenticate.
        const token = options.adminAuth
            ? getAdminToken()
            : (getSessionToken() || getAdminToken());
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetch(path, {
            ...options,
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined
        });

        let payload = null;
        try { payload = await res.json(); } catch { /* non-JSON response */ }

        if (!res.ok) {
            const message = payload?.error || `HTTP ${res.status}`;
            const err = new Error(message);
            err.status = res.status;
            throw err;
        }
        return payload || {};
    }

    return {
        // ----- settings -----
        getSettings,
        setSettings,
        getDefaultSettings: () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
        resetSettings: () => localStorage.removeItem(LS_SETTINGS),

        // Pull the store's settings from the server and cache them locally so
        // applyThemeAndAnnouncement() (sync) reflects them on the next render.
        async fetchSiteSettings({ adminAuth = false } = {}) {
            try {
                const data = await apiFetch('/api/site-settings', { method: 'GET', adminAuth });
                if (data && data.settings && typeof data.settings === 'object') {
                    writeJSON(LS_SETTINGS, data.settings);
                }
            } catch { /* keep local cache */ }
            return getSettings();
        },
        // Admin-only: persist the store's settings on the server.
        async saveSiteSettings(settings) {
            writeJSON(LS_SETTINGS, settings);
            await apiFetch('/api/site-settings', {
                method: 'POST', body: { settings }, adminAuth: true
            });
        },

        // ----- admin -----
        isAdminAuthed,
        getAdminSession,
        async adminLogin(username, password, storeId) {
            try {
                const data = await apiFetch('/api/auth', {
                    method: 'POST',
                    body: { username, password, storeId, role: 'admin' }
                });
                if (!data.token) return { ok: false, error: 'تعذّر تسجيل الدخول' };
                localStorage.setItem(LS_ADMIN_TOKEN, data.token);
                writeJSON(LS_ADMIN_SESSION, {
                    username,
                    name: data.customer?.name || username,
                    storeId
                });
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err.message || 'تعذّر تسجيل الدخول' };
            }
        },
        adminLogout() {
            localStorage.removeItem(LS_ADMIN_TOKEN);
            localStorage.removeItem(LS_ADMIN_SESSION);
        },

        // ----- hidden categories -----
        getHiddenIds,
        setHiddenIds,
        toggleHidden(id) {
            const ids = new Set(getHiddenIds());
            if (ids.has(id)) ids.delete(id); else ids.add(id);
            setHiddenIds(Array.from(ids));
        },

        // ----- categories (server) -----
        async fetchFamilies({ force = false } = {}) {
            if (!force && _familiesCache) return _familiesCache;
            const data = await apiFetch('/api/categories', { method: 'GET' });
            _familiesCache = data.families || [];
            return _familiesCache;
        },
        async getAllFamilies() {
            return await this.fetchFamilies();
        },
        async getVisibleFamilies() {
            const all = await this.fetchFamilies();
            const hidden = new Set(getHiddenIds());
            return all.filter(f => !hidden.has(f.id));
        },
        async getFamilyById(id) {
            const all = await this.fetchFamilies();
            return all.find(f => f.id === Number(id)) || null;
        },

        // ----- store info (server) -----
        async fetchStoreInfo({ force = false } = {}) {
            if (!force && _storeInfoCache) return _storeInfoCache;
            try {
                const data = await apiFetch('/api/store', { method: 'GET' });
                _storeInfoCache = {
                    name: data.name || '',
                    activity: data.activity || '',
                    address: data.address || '',
                    phone1: data.phone1 || '',
                    phone2: data.phone2 || '',
                    email: data.email || '',
                    rib: data.rib || '',
                    logoUrl: data.logoUrl || ''
                };
            } catch {
                _storeInfoCache = { name: '', activity: '', address: '', phone1: '', phone2: '', email: '', rib: '', logoUrl: '' };
            }
            return _storeInfoCache;
        },

        // ----- account balance (server) -----
        async fetchAccount() {
            try {
                return await apiFetch('/api/account', { method: 'GET' });
            } catch {
                return { remaining: 0, paid: 0, available: false };
            }
        },

        // ----- favorites (server) -----
        async fetchFavorites() {
            try {
                const data = await apiFetch('/api/favorites', { method: 'GET' });
                return data.uuids || [];
            } catch {
                return [];
            }
        },
        async addFavorite(uuid) {
            return await apiFetch('/api/favorites', { method: 'POST', body: { uuid } });
        },
        async removeFavorite(uuid) {
            return await apiFetch('/api/favorites', { method: 'DELETE', body: { uuid } });
        },

        // ----- products (server) -----
        async fetchProductsForFamily(familyName) {
            if (_productsByFamily.has(familyName)) return _productsByFamily.get(familyName);
            const data = await apiFetch(
                `/api/products?family=${encodeURIComponent(familyName)}`,
                { method: 'GET' }
            );
            _productsByFamily.set(familyName, data.products || []);
            return data.products || [];
        },
        async fetchFavoriteProducts() {
            const data = await apiFetch('/api/products?favorites=1', { method: 'GET' });
            return data.products || [];
        },
        // All products across the store, paginated (used by "products" display mode).
        async fetchAllProducts({ page = 1, pageSize = 25 } = {}) {
            const offset = Math.max(0, (page - 1) * pageSize);
            const data = await apiFetch(
                `/api/products?limit=${pageSize}&offset=${offset}`,
                { method: 'GET' }
            );
            return { products: data.products || [], total: Number(data.total || 0) };
        },

        // ----- cart -----
        getCart,
        clearCart: () => setCart([]),

        addToCart(product, qty = 1) {
            if (!product || !product.uuid) return false;
            if (!product.available || product.quantity <= 0) return false;
            const cart = getCart();
            const existing = cart.find(it => it.uuid === product.uuid);
            const cap = Number(product.quantity);
            if (existing) {
                existing.qty = Math.min(existing.qty + qty, cap);
            } else {
                // Snapshot the product's tier prices so the cart can switch
                // between them later (per-product pricing) without re-querying.
                const prices = this.productTierPrices(product);
                const tier = this.isPricePerProduct()
                    ? this.firstAllowedTier()
                    : this.getGlobalTier();
                cart.push({
                    uuid: product.uuid,
                    id: product.id ?? null,
                    name: product.name,
                    family: product.family,
                    prices,
                    tier,
                    price: this.priceForTier(prices, tier),
                    unitType: product.unitType || 'قطعة',
                    imageUrl: product.imageUrl || '',
                    maxQty: cap,
                    qty: Math.min(qty, cap)
                });
            }
            setCart(cart);
            return true;
        },

        // Switch a cart item to another allowed price tier (per-product mode).
        setCartItemTier(uuid, tier) {
            const cart = getCart();
            const item = cart.find(it => it.uuid === uuid);
            if (!item || !item.prices) return;
            item.tier = tier;
            item.price = this.priceForTier(item.prices, tier);
            setCart(cart);
        },

        removeFromCart(uuid) {
            setCart(getCart().filter(it => it.uuid !== uuid));
        },

        updateCartQty(uuid, qty) {
            const cart = getCart();
            const item = cart.find(it => it.uuid === uuid);
            if (!item) return;
            const cap = Number(item.maxQty || 9999);
            item.qty = Math.max(1, Math.min(qty, cap));
            setCart(cart);
        },

        cartCount: () => getCart().reduce((s, it) => s + Number(it.qty || 0), 0),
        cartTotal: () => getCart().reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 0), 0),

        // ----- customer session (server) -----
        getCustomerSession,
        getSessionToken,
        async customerLogin(username, password, storeId) {
            try {
                const data = await apiFetch('/api/auth', {
                    method: 'POST',
                    body: { username, password, storeId }
                });
                setSessionToken(data.token);
                writeJSON(LS_CUSTOMER, {
                    username,
                    name: data.customer?.name || username,
                    phone: data.customer?.phone || '',
                    storeId,
                    // Price permissions for this customer (which tiers they may
                    // use, and whether each product's price can be switched).
                    priceTiers: Array.isArray(data.customer?.priceTiers) && data.customer.priceTiers.length
                        ? data.customer.priceTiers : [1],
                    pricePerProduct: data.customer?.pricePerProduct === true,
                    loginAt: new Date().toISOString()
                });
                localStorage.removeItem(LS_PRICE_TIER); // reset global tier on login
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err.message || 'تعذّر تسجيل الدخول' };
            }
        },
        customerLogout: () => clearCustomerSession(),

        // ----- orders (server) -----
        async submitOrder({ notes = '', name = '', phone = '' } = {}) {
            const items = getCart();
            if (items.length === 0) {
                return { ok: false, error: 'السلة فارغة' };
            }
            try {
                const data = await apiFetch('/api/orders', {
                    method: 'POST',
                    body: {
                        items: items.map(it => ({
                            uuid: it.uuid,
                            id: it.id,
                            name: it.name,
                            price: it.price,
                            quantity: it.qty,
                            unitType: it.unitType
                        })),
                        notes,
                        name,
                        phone
                    }
                });
                setCart([]);
                return { ok: true, uuid: data.uuid, total: data.total };
            } catch (err) {
                return { ok: false, error: err.message || 'تعذّر إرسال الطلب' };
            }
        },

        // ----- pricing (per-customer tiers) -----
        // Which price tiers (1/2/3) this customer may use. Defaults to [1].
        allowedTiers() {
            const c = getCustomerSession();
            const t = (c && Array.isArray(c.priceTiers)) ? c.priceTiers : [1];
            const clean = t.map(Number).filter(n => n === 1 || n === 2 || n === 3);
            return clean.length ? Array.from(new Set(clean)).sort() : [1];
        },
        firstAllowedTier() { return this.allowedTiers()[0]; },
        isPricePerProduct() {
            const c = getCustomerSession();
            return !!(c && c.pricePerProduct) && this.allowedTiers().length > 1;
        },
        getGlobalTier() {
            const allowed = this.allowedTiers();
            const saved = Number(localStorage.getItem(LS_PRICE_TIER));
            return allowed.includes(saved) ? saved : allowed[0];
        },
        setGlobalTier(t) {
            if (this.allowedTiers().includes(Number(t))) {
                localStorage.setItem(LS_PRICE_TIER, String(Number(t)));
            }
        },
        productTierPrices(product) {
            const p1 = Number(product.price1 ?? product.price ?? 0);
            const p2 = Number(product.price2 ?? 0);
            const p3 = Number(product.price3 ?? 0);
            return { 1: p1, 2: p2, 3: p3 };
        },
        priceForTier(prices, tier) {
            const v = Number(prices?.[tier] ?? 0);
            if (v > 0) return v;
            // Fallback: tier price not set → use price1, else first positive.
            const p1 = Number(prices?.[1] ?? 0);
            if (p1 > 0) return p1;
            for (const k of [2, 3]) { if (Number(prices?.[k]) > 0) return Number(prices[k]); }
            return 0;
        },
        // Tiers usable for a given product: allowed AND have a positive price.
        itemUsableTiers(prices) {
            const usable = this.allowedTiers().filter(t => Number(prices?.[t]) > 0);
            return usable.length ? usable : [this.firstAllowedTier()];
        },
        nextTier(prices, currentTier) {
            const tiers = this.itemUsableTiers(prices);
            const i = tiers.indexOf(Number(currentTier));
            return tiers[(i + 1) % tiers.length];
        },
        // Effective price shown on a product card (before adding to cart).
        effectivePrice(product) {
            const prices = this.productTierPrices(product);
            const tier = this.isPricePerProduct() ? this.firstAllowedTier() : this.getGlobalTier();
            return this.priceForTier(prices, tier);
        },
        tierLabel(t) { return 'سعر ' + t; },

        // ----- formatting -----
        formatPrice(value) {
            return new Intl.NumberFormat('ar-DZ', {
                style: 'decimal',
                maximumFractionDigits: 0
            }).format(value) + ' د.ج';
        }
    };
})();
