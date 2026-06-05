/*
 * BigWebStore — صفحة الطلب المباشر (زبون عابر، بلا تسجيل دخول).
 * تُستعمل عندما يكون وضع المتجر "direct".
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

function imageOrPlaceholder(src, fallback) {
    if (src) {
        return `<img src="${escapeHtml(src)}" alt="" onerror="this.style.display='none'">`;
    }
    return `<div class="category-placeholder">${escapeHtml(fallback)}</div>`;
}

document.addEventListener('DOMContentLoaded', async () => {
    // Theme from cached settings.
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

    // Resolve the store from the link and confirm it is in direct mode.
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

    // Wilayas dropdown.
    const wilSel = document.getElementById('ofWilaya');
    wilSel.innerHTML = '<option value="">اختر الولاية</option>'
        + (window.BWS_WILAYAS || []).map(w => `<option>${escapeHtml(w)}</option>`).join('');

    // Load products.
    let products = [];
    try {
        const r = await BWS.fetchAllProducts({ page: 1, pageSize: 1000 });
        products = r.products || [];
    } catch { /* show empty */ }

    const qty = new Map();
    const selUuid = (new URLSearchParams(location.search).get('product') || '').trim();
    const selProduct = products.find(p => p.uuid === selUuid);
    if (selProduct && selProduct.available) qty.set(selUuid, 1);

    renderHero(selProduct);
    renderProducts(products, qty, selUuid);
    updateTotal(products, qty);

    document.getElementById('orderSubmit').addEventListener('click', () => submitOrder(products, qty));
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
    if (info.name) document.title = info.name;
}

function renderHero(product) {
    const hero = document.getElementById('orderHero');
    if (!product) {
        hero.innerHTML = '<div class="order-hero-note">اختر المنتجات وكمياتها من الأسفل ثم أكمل الطلب.</div>';
        return;
    }
    hero.innerHTML = `
        <div class="order-hero-img">
            ${imageOrPlaceholder(product.imageUrl, (product.name || '?').charAt(0))}
        </div>
        <div class="order-hero-info">
            <h1>${escapeHtml(product.name)}</h1>
            <div class="order-hero-price">${BWS.formatPrice(BWS.effectivePrice(product))}</div>
        </div>
    `;
}

function renderProducts(products, qty, selUuid) {
    const container = document.getElementById('orderProducts');
    if (products.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>لا توجد منتجات.</p></div>';
        return;
    }
    // Selected product first.
    const ordered = products.slice().sort((a, b) =>
        (a.uuid === selUuid ? -1 : 0) - (b.uuid === selUuid ? -1 : 0));

    container.innerHTML = ordered.map(p => {
        const available = p.available && p.quantity > 0;
        const q = qty.get(p.uuid) || 0;
        return `
        <div class="op-row${available ? '' : ' op-unavailable'}" data-uuid="${escapeHtml(p.uuid)}">
            <div class="op-img">${imageOrPlaceholder(p.imageUrl, (p.name || '?').charAt(0))}</div>
            <div class="op-info">
                <div class="op-name">${escapeHtml(p.name)}</div>
                <div class="op-price">${BWS.formatPrice(BWS.effectivePrice(p))}</div>
                <div class="op-status ${available ? 'status-available' : 'status-unavailable'}">${available ? 'متاح' : 'غير متاح'}</div>
            </div>
            <div class="op-qty">
                <button class="qty-btn op-dec" ${available ? '' : 'disabled'} aria-label="تقليل">−</button>
                <span class="op-val">${q}</span>
                <button class="qty-btn op-inc" ${available ? '' : 'disabled'} aria-label="زيادة">+</button>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.op-row').forEach(row => {
        const uuid = row.dataset.uuid;
        const p = products.find(x => x.uuid === uuid);
        const valEl = row.querySelector('.op-val');
        const cap = Number(p.quantity || 0);
        row.querySelector('.op-dec').addEventListener('click', () => {
            let q = qty.get(uuid) || 0;
            q = Math.max(0, q - 1);
            if (q === 0) qty.delete(uuid); else qty.set(uuid, q);
            valEl.textContent = q;
            updateTotal(products, qty);
        });
        row.querySelector('.op-inc').addEventListener('click', () => {
            let q = qty.get(uuid) || 0;
            if (q >= cap) { showToast('لا توجد كمية أكبر متاحة'); return; }
            q += 1;
            qty.set(uuid, q);
            valEl.textContent = q;
            updateTotal(products, qty);
        });
    });
}

function updateTotal(products, qty) {
    let total = 0;
    for (const p of products) {
        const q = qty.get(p.uuid) || 0;
        if (q > 0) total += BWS.effectivePrice(p) * q;
    }
    document.getElementById('orderTotal').textContent = BWS.formatPrice(total);
}

async function submitOrder(products, qty) {
    const name = document.getElementById('ofName').value.trim();
    const phone = document.getElementById('ofPhone').value.trim();
    const wilaya = document.getElementById('ofWilaya').value;
    const baladiya = document.getElementById('ofBaladiya').value.trim();
    const notes = document.getElementById('ofNotes').value.trim();
    const deliveryType = (document.querySelector('input[name="delivery"]:checked') || {}).value || 'home';

    if (!name || !phone) { showToast('الرجاء إدخال الاسم ورقم الهاتف'); return; }
    if (!wilaya) { showToast('الرجاء اختيار الولاية'); return; }

    const items = products
        .filter(p => (qty.get(p.uuid) || 0) > 0)
        .map(p => ({
            uuid: p.uuid, id: p.id ?? null, name: p.name,
            price: BWS.effectivePrice(p), quantity: qty.get(p.uuid),
            unitType: p.unitType || 'قطعة'
        }));
    if (items.length === 0) { showToast('اختر منتجًا واحدًا على الأقل'); return; }

    const btn = document.getElementById('orderSubmit');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'جاري الإرسال...';

    const res = await BWS.submitGuestOrder({ items, name, phone, wilaya, baladiya, deliveryType, notes });
    if (res.ok) {
        document.querySelector('.order-page').innerHTML = `
            <div class="order-success">
                <div class="order-success-icon">✅</div>
                <h2>تم إرسال طلبك بنجاح</h2>
                <p>سيتواصل معك المتجر قريبًا لتأكيد الطلب.</p>
                <a href="${withStore('index.html')}" class="checkout-btn" style="display:inline-block;text-decoration:none;margin-top:14px">العودة إلى المتجر</a>
            </div>`;
    } else {
        showToast(res.error || 'تعذّر إرسال الطلب');
        btn.disabled = false;
        btn.textContent = orig;
    }
}
