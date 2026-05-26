/*
 * BigWebStore – Local data layer
 *
 * Sample data mirroring the DigiSoftApp models (FamilyModel / ProductModel).
 * Later this file is the single point to replace with calls to the Turso
 * backend (or a small API in front of it).
 *
 * Hidden categories (Admin > visibility) are stored in localStorage under
 * "bws_hidden_categories" so the customer site reads them without a backend.
 */

const BWS = (function () {
    // Families and products will be loaded from the Turso server (DigiSoftApp
    // Families / Products tables) once the backend bridge is wired up.
    // For now both lists are empty so the UI shows the empty states.
    const families = [];
    const products = [];

    // ----- LocalStorage keys -----
    const LS_HIDDEN = 'bws_hidden_categories';
    const LS_CART = 'bws_cart';
    const LS_ADMIN_AUTH = 'bws_admin_authed';
    const LS_SETTINGS = 'bws_settings';
    const LS_USERS = 'bws_users';
    const LS_CUSTOMER = 'bws_customer_session';
    const LS_STORE_ID = 'bws_store_id';

    // ----- Default settings (admin can override via the settings page) -----
    // storeId is intentionally NOT here — it is inherited from the desktop
    // app's sync layer (SecureConfig.TursoStoreId / store_id column) and is
    // exposed via getStoreId() below.
    const DEFAULT_SETTINGS = {
        theme: {
            primary: '#ed5a1a',
            primaryDark: '#c94a14',
            primaryLight: '#ff7c3e'
        },
        announcement: '',           // empty → top bar hidden
        cartMode: 'page',           // 'page' | 'sidebar'
        siteMode: 'public'          // 'public' | 'private'
    };

    // ----- Store ID — auto-inherited from sync (placeholder for now) -----
    function getStoreId() {
        let id = localStorage.getItem(LS_STORE_ID);
        if (!id) {
            // Placeholder until the backend bridge delivers the real value
            // from SecureConfig.TursoStoreId.
            id = String(Math.floor(10000 + Math.random() * 90000));
            localStorage.setItem(LS_STORE_ID, id);
        }
        return id;
    }

    function setStoreId(value) {
        const v = String(value || '').trim();
        if (!v) return false;
        localStorage.setItem(LS_STORE_ID, v);
        return true;
    }

    // ----- Helpers -----
    function getHiddenIds() {
        try {
            return JSON.parse(localStorage.getItem(LS_HIDDEN) || '[]');
        } catch {
            return [];
        }
    }

    function setHiddenIds(ids) {
        localStorage.setItem(LS_HIDDEN, JSON.stringify(ids));
    }

    function getCart() {
        try {
            return JSON.parse(localStorage.getItem(LS_CART) || '[]');
        } catch {
            return [];
        }
    }

    function setCart(items) {
        localStorage.setItem(LS_CART, JSON.stringify(items));
    }

    function getSettings() {
        try {
            const raw = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
            if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            return {
                theme: { ...DEFAULT_SETTINGS.theme, ...(raw.theme || {}) },
                announcement: typeof raw.announcement === 'string'
                    ? raw.announcement : DEFAULT_SETTINGS.announcement,
                cartMode: raw.cartMode === 'sidebar' ? 'sidebar' : 'page',
                siteMode: raw.siteMode === 'private' ? 'private' : 'public'
            };
        } catch {
            return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        }
    }

    function setSettings(next) {
        const merged = { ...getSettings(), ...next };
        localStorage.setItem(LS_SETTINGS, JSON.stringify(merged));
    }

    function isAdminAuthed() {
        return localStorage.getItem(LS_ADMIN_AUTH) === '1';
    }

    function setAdminAuthed(value) {
        if (value) localStorage.setItem(LS_ADMIN_AUTH, '1');
        else localStorage.removeItem(LS_ADMIN_AUTH);
    }

    // ----- Customer users (created by admin) -----
    // Eventually persisted to the Turso server as new columns on a
    // customer-users table; today they live in localStorage only.
    function getUsers() {
        try {
            const list = JSON.parse(localStorage.getItem(LS_USERS) || '[]');
            const currentStore = getStoreId();
            // Backfill storeId for any legacy rows so the filter below behaves.
            return list.map(u => ({ ...u, storeId: u.storeId || currentStore }));
        } catch { return []; }
    }

    function getUsersForCurrentStore() {
        const storeId = getStoreId();
        return getUsers().filter(u => u.storeId === storeId);
    }

    function setUsers(list) {
        localStorage.setItem(LS_USERS, JSON.stringify(list));
    }

    function getCustomerSession() {
        try { return JSON.parse(localStorage.getItem(LS_CUSTOMER) || 'null'); }
        catch { return null; }
    }

    function setCustomerSession(data) {
        localStorage.setItem(LS_CUSTOMER, JSON.stringify(data));
    }

    function clearCustomerSession() {
        localStorage.removeItem(LS_CUSTOMER);
    }

    return {
        // ----- Public API -----
        getAllFamilies() {
            return families.slice();
        },

        getVisibleFamilies() {
            const hidden = new Set(getHiddenIds());
            return families.filter(f => !hidden.has(f.id));
        },

        getFamilyById(id) {
            return families.find(f => f.id === Number(id));
        },

        getFamilyByName(name) {
            return families.find(f => f.name === name);
        },

        getProductsForFamily(familyName) {
            return products.filter(p => p.family === familyName);
        },

        getProductById(id) {
            return products.find(p => p.id === Number(id));
        },

        // ----- Hidden categories (used by admin) -----
        getHiddenIds,
        setHiddenIds,

        toggleHidden(id) {
            const ids = new Set(getHiddenIds());
            if (ids.has(id)) ids.delete(id);
            else ids.add(id);
            setHiddenIds(Array.from(ids));
        },

        // ----- Cart -----
        getCart,
        setCart,

        addToCart(productId, qty = 1) {
            const p = this.getProductById(productId);
            if (!p) return false;
            if (p.totalQuantity <= 0) return false;
            const cart = getCart();
            const existing = cart.find(it => it.id === productId);
            if (existing) {
                existing.qty = Math.min(existing.qty + qty, p.totalQuantity);
            } else {
                cart.push({ id: productId, qty: Math.min(qty, p.totalQuantity) });
            }
            setCart(cart);
            return true;
        },

        removeFromCart(productId) {
            setCart(getCart().filter(it => it.id !== productId));
        },

        updateCartQty(productId, qty) {
            const p = this.getProductById(productId);
            if (!p) return;
            const cart = getCart();
            const item = cart.find(it => it.id === productId);
            if (!item) return;
            const next = Math.max(1, Math.min(qty, p.totalQuantity));
            item.qty = next;
            setCart(cart);
        },

        clearCart() {
            setCart([]);
        },

        cartCount() {
            return getCart().reduce((s, it) => s + it.qty, 0);
        },

        cartTotal() {
            return getCart().reduce((s, it) => {
                const p = this.getProductById(it.id);
                return s + (p ? p.sellPrice * it.qty : 0);
            }, 0);
        },

        // ----- Settings -----
        getSettings,
        setSettings,
        getDefaultSettings() {
            return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        },
        resetSettings() {
            localStorage.removeItem(LS_SETTINGS);
        },

        // ----- Admin -----
        isAdminAuthed,
        setAdminAuthed,

        adminLogin(username, password) {
            // Local-only check while backend is not wired up.
            if (username === 'admin' && password === 'admin') {
                setAdminAuthed(true);
                return true;
            }
            return false;
        },

        adminLogout() {
            setAdminAuthed(false);
        },

        // ----- Customer users (admin manages) -----
        getUsers,
        getUsersForCurrentStore,
        getStoreId,
        setStoreId,

        addUser(username, password) {
            const u = String(username || '').trim();
            const p = String(password || '');
            if (!u || !p) {
                return { ok: false, error: 'يجب إدخال اسم المستخدم وكلمة المرور' };
            }

            const storeId = getStoreId();
            const list = getUsers();

            // Password must be unique within this shop's customers.
            // (Per shop owner's requirement — different stores can share the
            // same password since they are isolated by storeId.)
            const passwordTaken = list.some(x =>
                x.storeId === storeId && x.password === p
            );
            if (passwordTaken) {
                return {
                    ok: false,
                    error: 'كلمة المرور مستخدمة من قبل زبون آخر، اختر كلمة مرور مختلفة'
                };
            }

            // Username duplicates are intentionally allowed within the store.

            list.push({
                username: u,
                password: p,
                storeId,
                createdAt: new Date().toISOString()
            });
            setUsers(list);
            // TODO: POST to backend so this user is written to the Turso server
            // (customer_users table with username, password, store_id columns).
            return { ok: true };
        },

        removeUser(username, createdAt) {
            // Use createdAt as a secondary key so duplicate usernames within a
            // store can be told apart.
            const storeId = getStoreId();
            setUsers(getUsers().filter(u => !(
                u.storeId === storeId &&
                u.username === username &&
                (!createdAt || u.createdAt === createdAt)
            )));
            // TODO: DELETE on backend.
        },

        // ----- Customer session -----
        getCustomerSession,
        clearCustomerSession,

        customerLogin(username, password, storeId) {
            const u = String(username || '').trim();
            const p = String(password || '');
            const s = String(storeId || '').trim();

            if (!u || !p || !s) {
                return { ok: false, error: 'يجب ملء جميع الحقول' };
            }

            // The customer must enter THIS shop's store id (mirrors how the
            // desktop app filters products by store_id during sync).
            const shopStoreId = getStoreId();
            if (s !== shopStoreId) {
                return { ok: false, error: 'رمز المتجر غير صحيح' };
            }

            // Only consider users that belong to this store. Duplicate usernames
            // across stores are fine; the storeId guarantees isolation.
            const user = getUsers().find(x =>
                x.storeId === shopStoreId &&
                x.username.toLowerCase() === u.toLowerCase() &&
                x.password === p
            );
            if (!user) {
                return { ok: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
            }

            setCustomerSession({
                username: user.username,
                storeId: shopStoreId,
                loginAt: new Date().toISOString()
            });
            return { ok: true };
        },

        customerLogout() {
            clearCustomerSession();
        },

        // ----- Formatting -----
        formatPrice(value) {
            return new Intl.NumberFormat('ar-DZ', {
                style: 'decimal',
                maximumFractionDigits: 0
            }).format(value) + ' د.ج';
        }
    };
})();
