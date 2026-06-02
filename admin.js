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
    } catch (err) {
        console.error(err);
        showToastAdmin(err.message || 'خطأ في الاتصال بالخادم');
    }
});

// ===== Login =====
function wireLogin() {
    if (BWS.isAdminAuthed()) {
        window.location.href = 'admin-dashboard.html';
        return;
    }
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const storeId = document.getElementById('storeId').value.trim();
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
            pageSize
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
