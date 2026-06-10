/*
 * BigWebStore – Admin-side controller.
 * Each page wires itself up depending on which DOM elements exist.
 */

document.addEventListener('DOMContentLoaded', async () => {
    if (document.getElementById('loginForm')) {
        wireLogin();
        return;
    }

    if (!BWS.isAdminAuthed()) {
        window.location.href = 'admin-login.html';
        return;
    }

    wireLogout();

    try {
        if (document.getElementById('statTotalCategories')) {
            await renderDashboard();
        }
        if (document.getElementById('categoriesTableBody')) {
            await renderCategoriesTable();
            wireCategoriesToolbar();
        }
        if (document.getElementById('settingsForm')) {
            wireSettingsPage();
        }
        if (document.getElementById('descProductsList')) {
            await wireDescriptionsPage();
        }
    } catch (err) {
        console.error(err);
        showToastAdmin(err.message || 'خطأ في الاتصال بالخادم');
    }
});

// ===== Login =====
async function wireLogin() {
    if (BWS.isAdminAuthed()) {
        window.location.href = 'admin-dashboard.html';
        return;
    }

    // If the store is known from the link/domain, hide the store-code field —
    // the server resolves the store from the tenant.
    let tenantActive = false;
    try {
        const tenant = await BWS.resolveTenant();
        tenantActive = tenant && tenant.found && tenant.active;
        if (tenantActive) {
            const grp = document.getElementById('adminStoreIdGroup');
            if (grp) grp.style.display = 'none';
            const nameEl = document.getElementById('adminTenantName');
            if (nameEl && tenant.name) { nameEl.textContent = tenant.name; nameEl.hidden = false; }
        }
    } catch { /* platform host → keep store-code field */ }

    const form = document.getElementById('loginForm');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const storeId = tenantActive ? '' : document.getElementById('storeId').value.trim();
        const err = document.getElementById('loginError');
        err.hidden = true;

        const btn = form.querySelector('button[type="submit"]');
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'جاري الدخول...';

        const res = await BWS.adminLogin(username, password, storeId);
        if (res.ok) {
            window.location.href = 'admin-dashboard.html';
        } else {
            err.hidden = false;
            err.textContent = res.error || 'بيانات الدخول غير صحيحة';
            btn.disabled = false;
            btn.textContent = orig;
        }
    });
}

function wireLogout() {
    const btn = document.getElementById('logoutBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        BWS.adminLogout();
        window.location.href = 'admin-login.html';
    });
}

// ===== Dashboard =====
async function renderDashboard() {
    try {
        const all = await BWS.getAllFamilies();
        document.getElementById('statTotalCategories').textContent = all.length;
    } catch {
        document.getElementById('statTotalCategories').textContent = '—';
    }
}

// ===== Categories admin =====
async function renderCategoriesTable(filterText = '') {
    const tbody = document.getElementById('categoriesTableBody');
    const hidden = new Set(BWS.getHiddenIds());

    let all;
    try {
        all = await BWS.getAllFamilies();
    } catch (err) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align:center;padding:24px;color:var(--danger,#c53030)">
                    تعذّر الاتصال بالخادم: ${escapeHtmlAdmin(err.message || '')}
                </td>
            </tr>
        `;
        return;
    }

    const filtered = all.filter(f =>
        !filterText || f.name.toLowerCase().includes(filterText.toLowerCase())
    );

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align:center;padding:24px;color:var(--text-muted)">
                    لا توجد نتائج
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filtered.map(f => {
        const isHidden = hidden.has(f.id);
        return `
            <tr data-family-id="${f.id}">
                <td>${f.id}</td>
                <td>${escapeHtmlAdmin(f.name)}</td>
                <td>
                    <span class="status-pill ${isHidden ? 'hidden' : 'visible'}">
                        ${isHidden ? 'مخفي' : 'ظاهر'}
                    </span>
                </td>
                <td>
                    <button class="toggle-switch ${isHidden ? '' : 'on'}" aria-label="تبديل">
                        <span class="toggle-track"></span>
                        <span class="toggle-label">${isHidden ? 'مخفي' : 'ظاهر'}</span>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('tr').forEach(tr => {
        const id = Number(tr.dataset.familyId);
        const toggle = tr.querySelector('.toggle-switch');
        if (!toggle) return;
        toggle.addEventListener('click', async () => {
            BWS.toggleHidden(id);
            const stillHidden = new Set(BWS.getHiddenIds()).has(id);
            await renderCategoriesTable(document.getElementById('catSearch')?.value || '');
            showToastAdmin(stillHidden ? 'تم إخفاء التصنيف' : 'تم إظهار التصنيف');
        });
    });
}

function wireCategoriesToolbar() {
    const search = document.getElementById('catSearch');
    search?.addEventListener('input', () => {
        renderCategoriesTable(search.value);
    });

    document.getElementById('showAllBtn')?.addEventListener('click', async () => {
        BWS.setHiddenIds([]);
        await renderCategoriesTable(search?.value || '');
        showToastAdmin('تم إظهار جميع التصنيفات');
    });

    document.getElementById('hideAllBtn')?.addEventListener('click', async () => {
        if (!confirm('هل تريد إخفاء جميع التصنيفات من واجهة الزبون؟')) return;
        const all = await BWS.getAllFamilies();
        BWS.setHiddenIds(all.map(f => f.id));
        await renderCategoriesTable(search?.value || '');
        showToastAdmin('تم إخفاء جميع التصنيفات');
    });
}

// ===== Product descriptions admin =====
async function wireDescriptionsPage() {
    const listEl = document.getElementById('descProductsList');
    const searchEl = document.getElementById('descSearch');
    const loadMoreBtn = document.getElementById('descLoadMore');
    const PAGE_SIZE = 50;

    let descMap = {};        // uuid -> { shortDescription, description }
    let loaded = [];         // accumulated products across pages
    let page = 0;
    let total = Infinity;

    try {
        descMap = await BWS.fetchProductDescriptions();
    } catch (err) {
        descMap = {};
    }

    function hasDesc(uuid) {
        const d = descMap[uuid];
        return !!(d && ((d.shortDescription || '').trim() || (d.description || '').trim()));
    }

    function render() {
        const filter = (searchEl.value || '').trim().toLowerCase();
        const rows = loaded.filter(p => !filter || (p.name || '').toLowerCase().includes(filter));

        if (rows.length === 0) {
            listEl.innerHTML = `<p class="muted" style="padding:16px">لا توجد منتجات مطابقة</p>`;
            return;
        }

        listEl.innerHTML = rows.map(p => {
            const d = descMap[p.uuid] || { shortDescription: '', description: '' };
            const flagged = hasDesc(p.uuid);
            return `
                <div class="desc-row" data-uuid="${escapeHtmlAdmin(p.uuid)}">
                    <div class="desc-row-head">
                        <span class="desc-name">${escapeHtmlAdmin(p.name)}</span>
                        <span class="status-pill ${flagged ? 'visible' : 'hidden'}">
                            ${flagged ? 'له وصف' : 'بدون وصف'}
                        </span>
                        <button class="ghost-btn desc-toggle">تعديل الوصف</button>
                    </div>
                    <div class="desc-editor" hidden>
                        <label class="desc-label">وصف مختصر (نقاط — سطر لكل نقطة، يظهر بجانب اسم المنتج)</label>
                        <textarea class="admin-input desc-short" rows="3">${escapeHtmlAdmin(d.shortDescription || '')}</textarea>
                        <label class="desc-label">وصف كامل (فقرات تظهر أسفل المنتج)</label>
                        <textarea class="admin-input desc-full" rows="6">${escapeHtmlAdmin(d.description || '')}</textarea>
                        <div class="desc-actions">
                            <button class="primary-btn desc-save">حفظ الوصف</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('.desc-row').forEach(row => {
            const uuid = row.dataset.uuid;
            const editor = row.querySelector('.desc-editor');
            row.querySelector('.desc-toggle').addEventListener('click', () => {
                editor.hidden = !editor.hidden;
            });
            row.querySelector('.desc-save').addEventListener('click', async () => {
                const shortDescription = row.querySelector('.desc-short').value;
                const description = row.querySelector('.desc-full').value;
                const btn = row.querySelector('.desc-save');
                const orig = btn.textContent;
                btn.disabled = true;
                btn.textContent = 'جاري الحفظ...';
                try {
                    await BWS.saveProductDescription(uuid, shortDescription, description);
                    descMap[uuid] = { shortDescription, description };
                    const pill = row.querySelector('.status-pill');
                    const flagged = hasDesc(uuid);
                    pill.className = `status-pill ${flagged ? 'visible' : 'hidden'}`;
                    pill.textContent = flagged ? 'له وصف' : 'بدون وصف';
                    showToastAdmin('تم حفظ الوصف');
                } catch (err) {
                    showToastAdmin(err.message || 'تعذّر حفظ الوصف');
                } finally {
                    btn.disabled = false;
                    btn.textContent = orig;
                }
            });
        });
    }

    async function loadNextPage() {
        page += 1;
        loadMoreBtn.disabled = true;
        try {
            const { products, total: t } = await BWS.fetchAllProducts({ page, pageSize: PAGE_SIZE });
            total = t;
            loaded = loaded.concat(products);
            render();
        } catch (err) {
            if (page === 1) {
                listEl.innerHTML = `<p style="padding:16px;color:var(--danger,#c53030)">تعذّر تحميل المنتجات: ${escapeHtmlAdmin(err.message || '')}</p>`;
            }
        } finally {
            loadMoreBtn.disabled = false;
            loadMoreBtn.hidden = loaded.length >= total;
        }
    }

    searchEl.addEventListener('input', render);
    await loadNextPage();
    loadMoreBtn.addEventListener('click', loadNextPage);
}

// ===== Settings page =====
function wireSettingsPage() {
    const form = document.getElementById('settingsForm');
    const fields = {
        primary: document.getElementById('primary'),
        primaryHex: document.getElementById('primaryHex'),
        primaryDark: document.getElementById('primaryDark'),
        primaryDarkHex: document.getElementById('primaryDarkHex'),
        primaryLight: document.getElementById('primaryLight'),
        primaryLightHex: document.getElementById('primaryLightHex'),
        announcement: document.getElementById('announcement'),
        cartModePage: document.getElementById('cartModePage'),
        cartModeSidebar: document.getElementById('cartModeSidebar'),
        displayCategories: document.getElementById('displayCategories'),
        displayProducts: document.getElementById('displayProducts'),
        pageSize: document.getElementById('pageSize'),
        pageSizeWrap: document.getElementById('pageSizeWrap'),
        orderModeCart: document.getElementById('orderModeCart'),
        orderModeDirect: document.getElementById('orderModeDirect'),
        ppr4: document.getElementById('ppr4'),
        ppr5: document.getElementById('ppr5'),
        ppr6: document.getElementById('ppr6'),
        ppr7: document.getElementById('ppr7'),
        fpr4: document.getElementById('fpr4'),
        fpr5: document.getElementById('fpr5'),
        fpr6: document.getElementById('fpr6'),
        fpr7: document.getElementById('fpr7'),
        previewMain: document.getElementById('previewMain'),
        previewDark: document.getElementById('previewDark'),
        previewLight: document.getElementById('previewLight')
    };

    function syncPageSizeVisibility() {
        if (!fields.pageSizeWrap) return;
        fields.pageSizeWrap.style.display = fields.displayProducts.checked ? '' : 'none';
    }
    fields.displayCategories?.addEventListener('change', syncPageSizeVisibility);
    fields.displayProducts?.addEventListener('change', syncPageSizeVisibility);

    function setColorPair(colorEl, hexEl, value) {
        colorEl.value = value;
        hexEl.value = value.toUpperCase();
    }

    function syncColorToHex(colorEl, hexEl) {
        colorEl.addEventListener('input', () => {
            hexEl.value = colorEl.value.toUpperCase();
            updatePreview();
        });
        hexEl.addEventListener('input', () => {
            const v = hexEl.value.trim();
            if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
                colorEl.value = v;
                updatePreview();
            }
        });
    }

    function updatePreview() {
        fields.previewMain.style.backgroundColor = fields.primary.value;
        fields.previewDark.style.backgroundColor = fields.primaryDark.value;
        fields.previewLight.style.backgroundColor = fields.primaryLight.value;
    }

    function fillForm(s) {
        setColorPair(fields.primary, fields.primaryHex, s.theme.primary);
        setColorPair(fields.primaryDark, fields.primaryDarkHex, s.theme.primaryDark);
        setColorPair(fields.primaryLight, fields.primaryLightHex, s.theme.primaryLight);
        fields.announcement.value = s.announcement || '';
        if (s.cartMode === 'sidebar') fields.cartModeSidebar.checked = true;
        else fields.cartModePage.checked = true;
        if (s.displayMode === 'products') fields.displayProducts.checked = true;
        else fields.displayCategories.checked = true;
        if (fields.pageSize) fields.pageSize.value = s.pageSize || 25;
        if (s.orderMode === 'direct') fields.orderModeDirect.checked = true;
        else fields.orderModeCart.checked = true;
        const pprField = fields['ppr' + (s.productsPerRow || 7)];
        if (pprField) pprField.checked = true;
        const fprField = fields['fpr' + (s.familiesPerRow || 4)];
        if (fprField) fprField.checked = true;
        syncPageSizeVisibility();
        updatePreview();
    }

    async function load() {
        // Server is the source of truth for this store's settings.
        const s = await BWS.fetchSiteSettings({ adminAuth: true });
        fillForm(s);
    }

    syncColorToHex(fields.primary, fields.primaryHex);
    syncColorToHex(fields.primaryDark, fields.primaryDarkHex);
    syncColorToHex(fields.primaryLight, fields.primaryLightHex);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let pageSize = parseInt(fields.pageSize?.value, 10);
        if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 25;
        pageSize = Math.min(200, pageSize);

        const settings = {
            theme: {
                primary: fields.primary.value,
                primaryDark: fields.primaryDark.value,
                primaryLight: fields.primaryLight.value
            },
            announcement: fields.announcement.value,
            cartMode: fields.cartModeSidebar.checked ? 'sidebar' : 'page',
            displayMode: fields.displayProducts.checked ? 'products' : 'categories',
            pageSize,
            orderMode: fields.orderModeDirect.checked ? 'direct' : 'cart',
            productsPerRow: Number(document.querySelector('input[name="productsPerRow"]:checked')?.value || 7),
            familiesPerRow: Number(document.querySelector('input[name="familiesPerRow"]:checked')?.value || 4)
        };

        const btn = form.querySelector('button[type="submit"]');
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'جاري الحفظ...';
        try {
            await BWS.saveSiteSettings(settings);
            showToastAdmin('تم حفظ الإعدادات على الخادم');
        } catch (err) {
            showToastAdmin(err.message || 'تعذّر حفظ الإعدادات');
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    });

    document.getElementById('resetSettingsBtn').addEventListener('click', async () => {
        if (!confirm('استعادة الإعدادات الافتراضية؟')) return;
        fillForm(BWS.getDefaultSettings());
        showToastAdmin('تمت الاستعادة — اضغط حفظ لتطبيقها على الخادم');
    });

    load();
}

// ===== Utilities =====
function showToastAdmin(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToastAdmin._t);
    showToastAdmin._t = setTimeout(() => toast.classList.remove('show'), 2200);
}

function escapeHtmlAdmin(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
