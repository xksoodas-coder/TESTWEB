/*
 * BigWebStore – Admin-side controller.
 * Each page wires itself up depending on which DOM elements exist.
 */

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('loginForm')) {
        wireLogin();
        return;
    }

    // Every other admin page is protected.
    if (!BWS.isAdminAuthed()) {
        window.location.href = 'admin-login.html';
        return;
    }

    wireLogout();

    if (document.getElementById('statTotalCategories')) {
        renderDashboard();
    }
    if (document.getElementById('categoriesTableBody')) {
        renderCategoriesTable();
        wireCategoriesToolbar();
    }
    if (document.getElementById('settingsForm')) {
        wireSettingsPage();
    }
    if (document.getElementById('addUserForm')) {
        wireUsersPage();
    }
});

// ===== Login =====
function wireLogin() {
    if (BWS.isAdminAuthed()) {
        window.location.href = 'admin-dashboard.html';
        return;
    }
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        if (BWS.adminLogin(username, password)) {
            window.location.href = 'admin-dashboard.html';
        } else {
            const err = document.getElementById('loginError');
            err.hidden = false;
            err.textContent = 'بيانات الدخول غير صحيحة';
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
function renderDashboard() {
    const all = BWS.getAllFamilies();
    const users = BWS.getUsersForCurrentStore();
    const settings = BWS.getSettings();
    document.getElementById('statStoreId').textContent = BWS.getStoreId();
    document.getElementById('statTotalCategories').textContent = all.length;
    document.getElementById('statTotalUsers').textContent = users.length;
    document.getElementById('statSiteMode').textContent =
        settings.siteMode === 'private' ? 'خاص (تسجيل دخول)' : 'عام';
}

// ===== Categories admin =====
function renderCategoriesTable(filterText = '') {
    const tbody = document.getElementById('categoriesTableBody');
    const hidden = new Set(BWS.getHiddenIds());
    const all = BWS.getAllFamilies()
        .filter(f => !filterText || f.name.toLowerCase().includes(filterText.toLowerCase()));

    if (all.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align:center;padding:24px;color:var(--text-muted)">
                    لا توجد نتائج
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = all.map(f => {
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
        toggle.addEventListener('click', () => {
            BWS.toggleHidden(id);
            const stillHidden = new Set(BWS.getHiddenIds()).has(id);
            renderCategoriesTable(document.getElementById('catSearch')?.value || '');
            showToastAdmin(stillHidden ? 'تم إخفاء التصنيف' : 'تم إظهار التصنيف');
        });
    });
}

function wireCategoriesToolbar() {
    const search = document.getElementById('catSearch');
    search?.addEventListener('input', () => {
        renderCategoriesTable(search.value);
    });

    document.getElementById('showAllBtn')?.addEventListener('click', () => {
        BWS.setHiddenIds([]);
        renderCategoriesTable(search?.value || '');
        showToastAdmin('تم إظهار جميع التصنيفات');
    });

    document.getElementById('hideAllBtn')?.addEventListener('click', () => {
        if (!confirm('هل تريد إخفاء جميع التصنيفات من واجهة الزبون؟')) return;
        const ids = BWS.getAllFamilies().map(f => f.id);
        BWS.setHiddenIds(ids);
        renderCategoriesTable(search?.value || '');
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
        siteModePublic: document.getElementById('siteModePublic'),
        siteModePrivate: document.getElementById('siteModePrivate'),
        previewMain: document.getElementById('previewMain'),
        previewDark: document.getElementById('previewDark'),
        previewLight: document.getElementById('previewLight')
    };

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

    function load() {
        const s = BWS.getSettings();
        setColorPair(fields.primary, fields.primaryHex, s.theme.primary);
        setColorPair(fields.primaryDark, fields.primaryDarkHex, s.theme.primaryDark);
        setColorPair(fields.primaryLight, fields.primaryLightHex, s.theme.primaryLight);
        fields.announcement.value = s.announcement || '';
        if (s.cartMode === 'sidebar') fields.cartModeSidebar.checked = true;
        else fields.cartModePage.checked = true;
        if (s.siteMode === 'private') fields.siteModePrivate.checked = true;
        else fields.siteModePublic.checked = true;
        const storeIdEl = document.getElementById('settingsStoreId');
        if (storeIdEl) storeIdEl.textContent = BWS.getStoreId();
        updatePreview();
    }

    syncColorToHex(fields.primary, fields.primaryHex);
    syncColorToHex(fields.primaryDark, fields.primaryDarkHex);
    syncColorToHex(fields.primaryLight, fields.primaryLightHex);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        BWS.setSettings({
            theme: {
                primary: fields.primary.value,
                primaryDark: fields.primaryDark.value,
                primaryLight: fields.primaryLight.value
            },
            announcement: fields.announcement.value,
            cartMode: fields.cartModeSidebar.checked ? 'sidebar' : 'page',
            siteMode: fields.siteModePrivate.checked ? 'private' : 'public'
        });
        showToastAdmin('تم حفظ الإعدادات');
    });

    document.getElementById('resetSettingsBtn').addEventListener('click', () => {
        if (!confirm('استعادة الإعدادات الافتراضية؟')) return;
        BWS.resetSettings();
        load();
        showToastAdmin('تمت الاستعادة إلى الإعدادات الافتراضية');
    });

    load();
}

// ===== Users page =====
function wireUsersPage() {
    const form = document.getElementById('addUserForm');
    const errEl = document.getElementById('addUserError');
    const usernameInput = document.getElementById('newUsername');
    const passwordInput = document.getElementById('newPassword');

    // Show current shop's store id at the top of the page.
    const storeIdEl = document.getElementById('currentStoreId');
    if (storeIdEl) storeIdEl.textContent = BWS.getStoreId();

    document.getElementById('editStoreIdBtn')?.addEventListener('click', () => {
        const current = BWS.getStoreId();
        const next = prompt(
            'رمز المتجر الجديد\n' +
            '(يجب أن يطابق SecureConfig.TursoStoreId في تطبيق الحاسوب):',
            current
        );
        if (next === null) return;
        if (!BWS.setStoreId(next)) {
            showToastAdmin('الرمز لا يمكن أن يكون فارغًا');
            return;
        }
        if (storeIdEl) storeIdEl.textContent = BWS.getStoreId();
        renderUsers();
        showToastAdmin('تم تحديث رمز المتجر');
    });

    function renderUsers() {
        const tbody = document.getElementById('usersTableBody');
        const users = BWS.getUsersForCurrentStore();
        if (users.length === 0) {
            tbody.innerHTML = `
                <tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text-muted)">
                    لا يوجد مستخدمون بعد
                </td></tr>
            `;
            return;
        }
        tbody.innerHTML = users.map(u => `
            <tr data-username="${escapeHtmlAdmin(u.username)}" data-created="${escapeHtmlAdmin(u.createdAt || '')}">
                <td>${escapeHtmlAdmin(u.username)}</td>
                <td><span class="user-store-pill">${escapeHtmlAdmin(u.storeId)}</span></td>
                <td>${formatDate(u.createdAt)}</td>
                <td><button class="ghost-btn delete-user-btn" style="color:var(--danger)">حذف</button></td>
            </tr>
        `).join('');

        tbody.querySelectorAll('tr').forEach(tr => {
            const username = tr.dataset.username;
            const createdAt = tr.dataset.created;
            tr.querySelector('.delete-user-btn')?.addEventListener('click', () => {
                if (!confirm(`حذف المستخدم "${username}"؟`)) return;
                BWS.removeUser(username, createdAt);
                renderUsers();
                showToastAdmin('تم حذف المستخدم');
            });
        });
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        errEl.hidden = true;
        const result = BWS.addUser(usernameInput.value, passwordInput.value);
        if (!result.ok) {
            errEl.hidden = false;
            errEl.textContent = result.error;
            return;
        }
        form.reset();
        renderUsers();
        showToastAdmin('تم حفظ المستخدم');
    });

    renderUsers();
}

function formatDate(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('ar-DZ') + ' ' + d.toLocaleTimeString('ar-DZ', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return iso;
    }
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
