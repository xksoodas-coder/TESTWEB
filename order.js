/*
 * BigWebStore — صفحة الطلب المباشر (زبون عابر، بلا تسجيل دخول).
 * تصميم حديث يشبه صفحة المنتج مع نموذج الطلب وملخص الطلبية.
 */
function withStore(url) {
    try {
        const slug = new URLSearchParams(location.search).get('store');
        if (!slug) return url;
        return url + (url.includes('?') ? '&' : '?') + 'store=' + encodeURIComponent(slug);
    } catch { return url; }
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2400);
}

function makePlaceholder(text) {
    const div = document.createElement('div');
    div.className = 'category-placeholder';
    div.textContent = text;
    return div;
}
window.makePlaceholder = makePlaceholder;

function imageOrPlaceholder(src, fallback) {
    if (src) {
        // On load failure, fall back to the colored first-letter placeholder
        // (site color) instead of leaving an empty box.
        return `<img src="${escapeHtml(src)}" alt="" onerror="this.replaceWith(makePlaceholder('${escapeHtml(fallback)}'))">`;
    }
    return `<div class="category-placeholder">${escapeHtml(fallback)}</div>`;
}

// ---- State ----
let _selectedProduct = null;
let _allProducts = [];
let _currentQty = 1;
let _summaryOpen = true;

document.addEventListener('DOMContentLoaded', async () => {
    // Theme
    const applyTheme = () => {
        const s = BWS.getSettings();
        const root = document.documentElement;
        root.style.setProperty('--primary', s.theme.primary);
        root.style.setProperty('--primary-dark', s.theme.primaryDark);
        root.style.setProperty('--primary-light', s.theme.primaryLight);
        document.querySelectorAll('.top-bar').forEach(bar => {
            const text = (s.announcement || '').trim();
            const span = bar.querySelector('.top-bar-text');
            if (span) span.textContent = text;
            bar.hidden = text.length === 0;
        });
    };
    applyTheme();

    // Resolve tenant
    const tenant = await BWS.resolveTenant();
    if (tenant && tenant.found && tenant.active === false) {
        document.body.innerHTML = '<div style="min-height:100vh;display:flex;align-items:center;'
            + 'justify-content:center;font-family:sans-serif">هذا المتجر غير متاح حاليًا</div>';
        return;
    }
    try { await BWS.fetchSiteSettings(); } catch {}
    applyTheme();
    if (BWS.getSettings().orderMode !== 'direct') {
        window.location.replace(withStore('index.html'));
        return;
    }
    window.__BWS_DIRECT__ = true;

    await applyBranding();

    // Load products
    try {
        const r = await BWS.fetchAllProducts({ page: 1, pageSize: 1000 });
        _allProducts = r.products || [];
    } catch { /* empty */ }

    const selUuid = (new URLSearchParams(location.search).get('product') || '').trim();
    _selectedProduct = _allProducts.find(p => p.uuid === selUuid) || null;

    if (_selectedProduct && _selectedProduct.available) {
        _currentQty = 1;
    }

    renderOrderPage();
    renderRelatedProducts(selUuid);
});

async function applyBranding() {
    let info;
    try { info = await BWS.fetchStoreInfo(); } catch { return; }
    if (!info) return;
    if (info.logoUrl) {
        document.querySelectorAll('.logo-circle').forEach(el => {
            el.innerHTML = `<img src="${escapeHtml(info.logoUrl)}" alt="logo" onerror="this.style.display='none'">`;
            el.classList.add('has-logo');
        });
    }
    if (info.name) document.title = info.name + ' — الطلب';
}

function renderOrderPage() {
    const section = document.getElementById('orderTopSection');
    const p = _selectedProduct;

    if (!p) {
        section.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:60px 20px">
                <h2 style="color:var(--text-dark);margin-bottom:8px">لم يتم اختيار منتج</h2>
                <p style="color:var(--text-muted)">يرجى اختيار منتج من المتجر أولاً</p>
                <a href="${withStore('index.html')}" class="checkout-btn" style="display:inline-block;text-decoration:none;margin-top:14px;width:auto;padding:12px 32px">العودة إلى المتجر</a>
            </div>`;
        return;
    }

    const price = BWS.effectivePrice(p);
    const wilayas = (window.BWS_WILAYAS || []);

    section.innerHTML = `
        <!-- Left column: info + form + summary -->
        <div class="order-left-col">
            <h1 class="order-product-title">${escapeHtml(p.name)}</h1>
            ${p.shortDescription ? `<div class="order-product-badges">${
                p.shortDescription.split('\n').filter(l => l.trim()).map(l =>
                    `<span class="order-badge">${escapeHtml(l.trim())}</span>`
                ).join('')
            }</div>` : ''}
            <div class="order-product-price">${BWS.formatPrice(price)}</div>
            <div class="order-product-stars">★★★★★</div>

            <div class="order-instruction">
                للطلب أدخل معلوماتك في الخانات أسفله <span class="emoji">👇</span> .. ثم إضغط على زر "<strong>تأكيد الطلب</strong>"
            </div>

            <form id="orderForm" class="order-form" autocomplete="on">
                <div class="of-row">
                    <div class="of-field">
                        <input type="text" id="ofName" placeholder="الإسم الأول" required>
                    </div>
                    <div class="of-field">
                        <input type="tel" id="ofPhone" inputmode="tel" placeholder="رقم الهاتف" required>
                    </div>
                </div>
                <div class="of-row">
                    <div class="of-field">
                        <select id="ofWilaya" required>
                            <option value="">الولاية</option>
                            ${wilayas.map(w => `<option value="${escapeHtml(w.code + ' - ' + w.name)}" data-wid="${w.id}">${escapeHtml(w.code + ' - ' + w.name)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="of-field">
                        <select id="ofBaladiya" disabled>
                            <option value="">البلدية / الدائرة</option>
                        </select>
                    </div>
                </div>
                <div class="of-row">
                    <div class="of-field">
                        <select id="ofDelivery">
                            <option value="home">طريقة التسليم</option>
                            <option value="home">🏠 توصيل إلى المنزل</option>
                            <option value="office">🏢 توصيل إلى المكتب</option>
                        </select>
                    </div>
                    <div class="of-field">
                        <input type="text" id="ofNotes" placeholder="ملاحظة (إختيارية)">
                    </div>
                </div>
            </form>

            <!-- Order Summary -->
            <div class="order-summary-section">
                <button type="button" class="order-summary-toggle" id="summaryToggle">
                    <span><span class="summary-cart-icon">🛒</span> ملخص الطلبية</span>
                    <span class="toggle-icon open" id="toggleIcon">▲</span>
                </button>
                <div class="order-summary-body" id="summaryBody">
                    <div class="summary-item" id="summaryItemRow">
                        <span class="summary-item-name">
                            ${escapeHtml(p.name)}
                            <span class="summary-qty-badge" id="summaryQtyBadge">x${_currentQty}</span>
                        </span>
                        <span class="summary-item-price" id="summaryItemPrice">${BWS.formatPrice(price * _currentQty)}</span>
                    </div>
                    <div class="summary-row">
                        <span class="summary-row-label">🚚 سعر التوصيل</span>
                        <span class="summary-row-value" id="summaryDelivery">اختر ولاية التسليم</span>
                    </div>
                    <div class="summary-row total-row">
                        <span class="summary-row-label">الثمن الإجمالي</span>
                        <span class="summary-row-value" id="summaryTotal">${BWS.formatPrice(price * _currentQty)}</span>
                    </div>
                </div>
            </div>

            <!-- Action bar -->
            <div class="order-action-bar">
                <button type="button" class="order-submit-btn" id="orderSubmit">اضغط هنا للطلب</button>
                <div class="order-qty-controls">
                    <button type="button" class="order-qty-btn" id="qtyDec" aria-label="تقليل">−</button>
                    <span class="order-qty-value" id="qtyValue">${_currentQty}</span>
                    <button type="button" class="order-qty-btn" id="qtyInc" aria-label="زيادة">+</button>
                </div>
            </div>
        </div>

        <!-- Right column: product image -->
        <div class="order-right-col">
            <div class="order-product-image">
                ${imageOrPlaceholder(p.imageUrl, (p.name || '?').charAt(0))}
            </div>
        </div>
    `;

    // Bind events
    bindSummaryToggle();
    bindQtyControls();
    bindSubmit();
    bindWilayaChange();
    bindImageZoom();
    initScrollHeader(p, price);
}

// Populate & observe: when product title scrolls behind the header,
// switch the header to show product name + price.
function initScrollHeader(product, price) {
    const header = document.querySelector('.main-header');
    const titleEl = document.querySelector('.order-product-title');
    const hpbName = document.getElementById('hpbName');
    const hpbPrice = document.getElementById('hpbPrice');
    if (!header || !titleEl || !hpbName || !hpbPrice || !product) return;

    // Fill in the product info
    hpbName.textContent = product.name || '';
    hpbPrice.textContent = BWS.formatPrice(price);

    // Use IntersectionObserver to detect when the title leaves the viewport
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) {
                // Title is hidden behind the header → show product bar
                header.classList.add('header-scrolled');
            } else {
                // Title is visible → restore normal header
                header.classList.remove('header-scrolled');
            }
        });
    }, {
        // Account for the sticky header height
        rootMargin: '-90px 0px 0px 0px',
        threshold: 0
    });

    observer.observe(titleEl);
}

// Zoom on hover: enlarge the product image and follow the mouse,
// reset to normal when the mouse leaves (like commercial product pages).
function bindImageZoom() {
    const box = document.querySelector('.order-product-image');
    if (!box) return;
    const img = box.querySelector('img');
    if (!img) return; // no zoom for the placeholder

    box.addEventListener('mousemove', (e) => {
        const rect = box.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        img.style.transformOrigin = `${x}% ${y}%`;
        box.classList.add('zoom-active');
    });

    box.addEventListener('mouseleave', () => {
        box.classList.remove('zoom-active');
        img.style.transformOrigin = 'center center';
    });
}

function bindSummaryToggle() {
    const toggle = document.getElementById('summaryToggle');
    const body = document.getElementById('summaryBody');
    const icon = document.getElementById('toggleIcon');
    if (!toggle) return;

    toggle.addEventListener('click', () => {
        _summaryOpen = !_summaryOpen;
        body.style.display = _summaryOpen ? '' : 'none';
        icon.classList.toggle('open', _summaryOpen);
    });
}

function bindQtyControls() {
    const p = _selectedProduct;
    if (!p) return;
    const cap = Number(p.quantity || 0);
    const valEl = document.getElementById('qtyValue');
    const decBtn = document.getElementById('qtyDec');
    const incBtn = document.getElementById('qtyInc');

    decBtn.addEventListener('click', () => {
        if (_currentQty > 1) {
            _currentQty--;
            valEl.textContent = _currentQty;
            updateSummary();
        }
    });

    incBtn.addEventListener('click', () => {
        if (_currentQty >= cap) {
            showToast('لا توجد كمية أكبر متاحة');
            return;
        }
        _currentQty++;
        valEl.textContent = _currentQty;
        updateSummary();
    });
}

function updateSummary() {
    const p = _selectedProduct;
    if (!p) return;
    const price = BWS.effectivePrice(p);
    const total = price * _currentQty;

    const badge = document.getElementById('summaryQtyBadge');
    const itemPrice = document.getElementById('summaryItemPrice');
    const totalEl = document.getElementById('summaryTotal');

    if (badge) badge.textContent = 'x' + _currentQty;
    if (itemPrice) itemPrice.textContent = BWS.formatPrice(total);
    if (totalEl) totalEl.textContent = BWS.formatPrice(total);
}

function bindWilayaChange() {
    const wilSel = document.getElementById('ofWilaya');
    if (!wilSel) return;
    const balSel = document.getElementById('ofBaladiya');

    wilSel.addEventListener('change', () => {
        const deliveryEl = document.getElementById('summaryDelivery');
        if (wilSel.value) {
            if (deliveryEl) deliveryEl.textContent = 'اختر ولاية التسليم';
        }
        populateBaladiyas(wilSel, balSel);
    });
}

// Fill the baladiya dropdown with the communes of the selected wilaya,
// each shown as "post_code - name" (linked via the wilaya id).
function populateBaladiyas(wilSel, balSel) {
    if (!balSel) return;
    const opt = wilSel.options[wilSel.selectedIndex];
    const wid = opt ? opt.getAttribute('data-wid') : '';
    const communes = (window.BWS_COMMUNES || {})[String(wid)] || [];

    balSel.innerHTML = '<option value="">البلدية / الدائرة</option>' +
        communes.map(c => {
            const label = (c.code ? c.code + ' - ' : '') + c.name;
            return `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
        }).join('');
    balSel.disabled = communes.length === 0;
}

function bindSubmit() {
    const btn = document.getElementById('orderSubmit');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        const p = _selectedProduct;
        if (!p) return;

        const name = document.getElementById('ofName').value.trim();
        const phone = document.getElementById('ofPhone').value.trim();
        const wilaya = document.getElementById('ofWilaya').value;
        const baladiya = (document.getElementById('ofBaladiya')?.value || '').trim();
        const notes = (document.getElementById('ofNotes')?.value || '').trim();
        const deliveryType = document.getElementById('ofDelivery')?.value || 'home';

        if (!name || !phone) { showToast('الرجاء إدخال الاسم ورقم الهاتف'); return; }
        if (!wilaya) { showToast('الرجاء اختيار الولاية'); return; }

        const items = [{
            uuid: p.uuid,
            id: p.id ?? null,
            name: p.name,
            price: BWS.effectivePrice(p),
            quantity: _currentQty,
            unitType: p.unitType || 'قطعة'
        }];

        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'جاري الإرسال...';

        const res = await BWS.submitGuestOrder({ items, name, phone, wilaya, baladiya, deliveryType, notes });
        if (res.ok) {
            document.getElementById('orderPage').innerHTML = `
                <div class="order-success">
                    <div class="order-success-icon">✅</div>
                    <h2>تم إرسال طلبك بنجاح</h2>
                    <p>سيتواصل معك المتجر قريبًا لتأكيد الطلب.</p>
                    <a href="${withStore('index.html')}" class="checkout-btn order-success-btn">العودة إلى المتجر</a>
                </div>`;
        } else {
            showToast(res.error || 'تعذّر إرسال الطلب');
            btn.disabled = false;
            btn.textContent = orig;
        }
    });
}

function renderRelatedProducts(excludeUuid) {
    const container = document.getElementById('relatedProducts');
    const section = document.getElementById('orderRelatedSection');
    if (!container || !section) return;

    // Show the rest of the products from the SAME category (family) as the
    // selected product, excluding the one currently displayed. No limit.
    const family = _selectedProduct && _selectedProduct.family;
    let related = [];
    if (family) {
        related = _allProducts.filter(p =>
            p.uuid !== excludeUuid &&
            p.available && p.quantity > 0 &&
            p.family === family
        );
    }

    // Fallback: if the category has no other products, show other available ones.
    if (related.length === 0) {
        related = _allProducts
            .filter(p => p.uuid !== excludeUuid && p.available && p.quantity > 0)
            .slice(0, 4);
    }

    if (related.length === 0) return;

    // Update the heading to reflect that these belong to the same category.
    const titleEl = section.querySelector('.related-title');
    if (titleEl && family) titleEl.textContent = 'منتجات أخرى من نفس التصنيف';

    section.style.display = '';
    container.innerHTML = related.map(p => {
        const price = BWS.effectivePrice(p);
        const href = withStore('order.html?product=' + encodeURIComponent(p.uuid));
        return `
            <a class="related-card" href="${escapeHtml(href)}">
                <div class="related-card-img">
                    ${imageOrPlaceholder(p.imageUrl, (p.name || '?').charAt(0))}
                </div>
                <div class="related-card-body">
                    <div class="related-card-name">${escapeHtml(p.name)}</div>
                    <div class="related-card-price">${BWS.formatPrice(price)}</div>
                </div>
            </a>`;
    }).join('');
}
