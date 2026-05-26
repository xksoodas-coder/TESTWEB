/*
 * BigWebStore – Customer-side controller.
 * Routes each page to the right render call based on which DOM IDs exist.
 */

document.addEventListener('DOMContentLoaded', () => {
    applyThemeAndAnnouncement();
    if (!enforcePrivateAccess()) return;   // redirected → stop init
    updateCartBadge();
    wireSearchPanel();
    initCartSidebar();
    wireCartIcons();
    renderCustomerBadge();

    if (document.getElementById('categoriesGrid')) {
        renderCategoriesGrid();
    }
    if (document.getElementById('productsGrid')) {
        renderProductsPage();
    }
    if (document.getElementById('cartContainer')) {
        renderCartPage();
    }
    if (document.getElementById('contactForm')) {
        wireContactForm();
    }
});

// ===== Private-mode gate =====
function enforcePrivateAccess() {
    const settings = BWS.getSettings();
    if (settings.siteMode !== 'private') return true;
    if (BWS.getCustomerSession()) return true;
    if (/login\.html$/i.test(window.location.pathname)) return true;
    window.location.replace('login.html');
    return false;
}

// ===== Customer "logged in as" badge =====
function renderCustomerBadge() {
    const session = BWS.getCustomerSession();
    if (!session) return;
    const headerLeft = document.querySelector('.header-left');
    if (!headerLeft || document.querySelector('.customer-info')) return;

    const wrap = document.createElement('div');
    wrap.className = 'customer-info';
    wrap.innerHTML = `
        <span class="customer-name">${escapeHtml(session.username)}</span>
        <button class="customer-logout" id="customerLogoutBtn">خروج</button>
    `;
    headerLeft.appendChild(wrap);

    document.getElementById('customerLogoutBtn').addEventListener('click', () => {
        BWS.customerLogout();
        const settings = BWS.getSettings();
        if (settings.siteMode === 'private') {
            window.location.href = 'login.html';
        } else {
            window.location.reload();
        }
    });
}

// ===== Theme + Announcement bar =====
function applyThemeAndAnnouncement() {
    const settings = BWS.getSettings();
    const root = document.documentElement;
    root.style.setProperty('--primary', settings.theme.primary);
    root.style.setProperty('--primary-dark', settings.theme.primaryDark);
    root.style.setProperty('--primary-light', settings.theme.primaryLight);

    document.querySelectorAll('.top-bar').forEach(bar => {
        const text = (settings.announcement || '').trim();
        const span = bar.querySelector('.top-bar-text');
        if (span) span.textContent = text;
        bar.hidden = text.length === 0;
    });
}

// ===== Header =====
function updateCartBadge() {
    const badge = document.getElementById('cartBadge');
    if (!badge) return;
    const count = BWS.cartCount();
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
}

function wireSearchPanel() {
    const btn = document.getElementById('searchBtn');
    const panel = document.getElementById('searchPanel');
    const close = document.getElementById('searchClose');
    const input = document.getElementById('searchInput');
    if (!btn || !panel) return;

    btn.addEventListener('click', () => {
        panel.classList.add('open');
        if (input) input.focus();
    });
    close?.addEventListener('click', () => panel.classList.remove('open'));
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const q = input.value.trim().toLowerCase();
            if (!q) return;
            const match = BWS.getVisibleFamilies()
                .find(f => f.name.toLowerCase().includes(q));
            if (match) {
                window.location.href = `products.html?familyId=${match.id}`;
            } else {
                showToast('لم يتم العثور على نتائج.');
            }
        } else if (e.key === 'Escape') {
            panel.classList.remove('open');
        }
    });
}

// ===== Cart Sidebar =====
function initCartSidebar() {
    if (document.getElementById('cartSidebar')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'cartBackdrop';
    backdrop.className = 'cart-backdrop';

    const sidebar = document.createElement('aside');
    sidebar.id = 'cartSidebar';
    sidebar.className = 'cart-sidebar';
    sidebar.innerHTML = `
        <div class="cart-sidebar-header">
            <h3>سلة المشتريات</h3>
            <button class="sidebar-close" id="sidebarClose" aria-label="إغلاق">×</button>
        </div>
        <div class="cart-sidebar-items" id="sidebarItems"></div>
        <div class="cart-sidebar-footer">
            <div class="summary-line total-line">
                <span>المجموع:</span>
                <span id="sidebarTotal">0 د.ج</span>
            </div>
            <button class="checkout-btn" id="sidebarCheckoutBtn">إتمام الطلب</button>
            <a href="cart.html" class="view-cart-link">عرض السلة الكاملة</a>
        </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(sidebar);

    backdrop.addEventListener('click', closeCartSidebar);
    sidebar.querySelector('#sidebarClose').addEventListener('click', closeCartSidebar);
    sidebar.querySelector('#sidebarCheckoutBtn').addEventListener('click', () => {
        showToast('سيتم تفعيل الطلب بعد ربط النظام بالحاسوب');
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCartSidebar();
    });
}

function openCartSidebar() {
    initCartSidebar();
    renderCartSidebar();
    document.getElementById('cartSidebar').classList.add('open');
    document.getElementById('cartBackdrop').classList.add('open');
}

function closeCartSidebar() {
    document.getElementById('cartSidebar')?.classList.remove('open');
    document.getElementById('cartBackdrop')?.classList.remove('open');
}

function renderCartSidebar() {
    const container = document.getElementById('sidebarItems');
    if (!container) return;
    const items = BWS.getCart();
    if (items.length === 0) {
        container.innerHTML = '<p class="empty-sidebar">السلة فارغة</p>';
    } else {
        container.innerHTML = items.map(it => {
            const p = BWS.getProductById(it.id);
            if (!p) return '';
            return `
                <div class="sidebar-item" data-product-id="${p.id}">
                    <div class="sidebar-item-img">
                        ${renderImageOrPlaceholder(p.image, p.name.charAt(0))}
                    </div>
                    <div class="sidebar-item-info">
                        <h4>${escapeHtml(p.name)}</h4>
                        <div class="item-price">${BWS.formatPrice(p.sellPrice)} × ${it.qty}</div>
                    </div>
                    <button class="sidebar-item-remove" aria-label="حذف">×</button>
                </div>
            `;
        }).join('');
        container.querySelectorAll('.sidebar-item').forEach(row => {
            const id = Number(row.dataset.productId);
            row.querySelector('.sidebar-item-remove').addEventListener('click', () => {
                BWS.removeFromCart(id);
                renderCartSidebar();
                updateCartBadge();
            });
        });
    }
    const totalEl = document.getElementById('sidebarTotal');
    if (totalEl) totalEl.textContent = BWS.formatPrice(BWS.cartTotal());
}

function wireCartIcons() {
    const mode = BWS.getSettings().cartMode;
    document.querySelectorAll('.cart-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (mode === 'sidebar') {
                e.preventDefault();
                openCartSidebar();
            }
        });
    });
}

// ===== Categories Grid =====
function renderCategoriesGrid() {
    const grid = document.getElementById('categoriesGrid');
    const families = BWS.getVisibleFamilies();

    if (families.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <h2>لا توجد تصنيفات حاليًا</h2>
                <p>الرجاء العودة لاحقًا.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = families.map(f => `
        <a href="products.html?familyId=${f.id}" class="category-card">
            <div class="category-image">
                ${renderImageOrPlaceholder(f.image, f.initial || f.name.charAt(0))}
            </div>
            <div class="category-name">${escapeHtml(f.name)}</div>
        </a>
    `).join('');
}

function renderImageOrPlaceholder(src, fallbackText) {
    if (src) {
        return `<img src="${escapeHtml(src)}" alt="" onerror="this.replaceWith(makePlaceholder('${escapeHtml(fallbackText)}'))">`;
    }
    return `<div class="category-placeholder">${escapeHtml(fallbackText)}</div>`;
}

// ===== Products Page =====
function renderProductsPage() {
    const params = new URLSearchParams(window.location.search);
    const familyId = Number(params.get('familyId'));
    const family = BWS.getFamilyById(familyId);

    const titleEl = document.getElementById('productsPageTitle');
    const subtitleEl = document.getElementById('productsPageSubtitle');

    if (!family) {
        titleEl.textContent = 'تصنيف غير موجود';
        subtitleEl.textContent = 'الرجاء اختيار تصنيف من قائمة التصنيفات';
        document.getElementById('emptyState').style.display = 'block';
        return;
    }

    // Block access to hidden categories.
    const hidden = new Set(BWS.getHiddenIds());
    if (hidden.has(family.id)) {
        titleEl.textContent = 'هذا التصنيف غير متاح';
        subtitleEl.textContent = '';
        document.getElementById('emptyState').style.display = 'block';
        return;
    }

    titleEl.textContent = family.name;
    subtitleEl.textContent = 'منتجات التصنيف';

    const products = BWS.getProductsForFamily(family.name);
    const grid = document.getElementById('productsGrid');
    const emptyState = document.getElementById('emptyState');

    if (products.length === 0) {
        grid.style.display = 'none';
        emptyState.style.display = 'block';
        return;
    }

    grid.innerHTML = products.map(p => {
        const available = p.totalQuantity > 0;
        return `
            <div class="product-card${available ? '' : ' unavailable'}">
                <div class="product-image">
                    ${renderImageOrPlaceholder(p.image, p.name.charAt(0))}
                </div>
                <div class="product-name">${escapeHtml(p.name)}</div>
                <div class="product-price">${BWS.formatPrice(p.sellPrice)}</div>
                <div class="product-status ${available ? 'status-available' : 'status-unavailable'}">
                    ${available ? 'متاح' : 'غير متاح'}
                </div>
                <button class="add-cart-btn"
                        data-product-id="${p.id}"
                        ${available ? '' : 'hidden'}>
                    إضافة إلى السلة
                </button>
            </div>
        `;
    }).join('');

    grid.querySelectorAll('.add-cart-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = Number(btn.dataset.productId);
            if (BWS.addToCart(id, 1)) {
                updateCartBadge();
                if (document.getElementById('cartSidebar')?.classList.contains('open')) {
                    renderCartSidebar();
                }
                showToast('تمت إضافة المنتج إلى السلة');
            } else {
                showToast('المنتج غير متاح');
            }
        });
    });
}

// ===== Cart Page =====
function renderCartPage() {
    const container = document.getElementById('cartContainer');
    const summary = document.getElementById('cartSummary');
    const emptyState = document.getElementById('emptyCartState');

    const cart = BWS.getCart();
    if (cart.length === 0) {
        container.style.display = 'none';
        summary.style.display = 'none';
        emptyState.style.display = 'block';
        return;
    }

    container.innerHTML = cart.map(item => {
        const p = BWS.getProductById(item.id);
        if (!p) return '';
        return `
            <div class="cart-item" data-product-id="${p.id}">
                <div class="cart-item-image">
                    ${renderImageOrPlaceholder(p.image, p.name.charAt(0))}
                </div>
                <div class="cart-item-info">
                    <h4>${escapeHtml(p.name)}</h4>
                    <div class="item-price">${BWS.formatPrice(p.sellPrice)}</div>
                    <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(p.family)}</div>
                </div>
                <div class="qty-controls">
                    <button class="qty-btn qty-dec" aria-label="تقليل">−</button>
                    <span class="qty-value">${item.qty}</span>
                    <button class="qty-btn qty-inc" aria-label="زيادة">+</button>
                </div>
                <button class="remove-btn">حذف</button>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.cart-item').forEach(row => {
        const id = Number(row.dataset.productId);
        row.querySelector('.qty-dec').addEventListener('click', () => {
            const current = BWS.getCart().find(it => it.id === id);
            if (!current) return;
            if (current.qty <= 1) {
                BWS.removeFromCart(id);
            } else {
                BWS.updateCartQty(id, current.qty - 1);
            }
            renderCartPage();
            updateCartBadge();
        });
        row.querySelector('.qty-inc').addEventListener('click', () => {
            const current = BWS.getCart().find(it => it.id === id);
            if (!current) return;
            BWS.updateCartQty(id, current.qty + 1);
            renderCartPage();
            updateCartBadge();
        });
        row.querySelector('.remove-btn').addEventListener('click', () => {
            BWS.removeFromCart(id);
            renderCartPage();
            updateCartBadge();
            showToast('تم حذف المنتج من السلة');
        });
    });

    document.getElementById('summaryCount').textContent = BWS.cartCount();
    document.getElementById('summaryTotal').textContent = BWS.formatPrice(BWS.cartTotal());

    document.getElementById('checkoutBtn').onclick = () => {
        showToast('سيتم تفعيل الطلب بعد ربط النظام بالحاسوب');
    };
    document.getElementById('clearCartBtn').onclick = () => {
        if (confirm('هل تريد فعلاً إفراغ السلة؟')) {
            BWS.clearCart();
            renderCartPage();
            updateCartBadge();
        }
    };
}

// ===== Contact Form =====
function wireContactForm() {
    const form = document.getElementById('contactForm');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        showToast('تم إرسال رسالتك. سنتواصل معك قريبًا.');
        form.reset();
    });
}

// ===== Utilities =====
function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2400);
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Globally exposed for the inline onerror handler on <img>.
function makePlaceholder(text) {
    const div = document.createElement('div');
    div.className = 'category-placeholder';
    div.textContent = text;
    return div;
}
window.makePlaceholder = makePlaceholder;
