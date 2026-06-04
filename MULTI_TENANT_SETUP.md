# دليل التشغيل والتجريب — المتاجر متعددة المستأجرين

## 1) ما الذي أُضيف

**الخادم (Vercel/Turso):**
- `api/_lib/tenant.js` — جدول `bws_tenants` + محلّل المستأجر (دومين خاص / دومين فرعي / `?store=slug`) مع تخزين مؤقت.
- `api/tenant.js` — `GET` عام: يُرجع هوية المتجر من الرابط.
- `api/auth.js` — يأخذ `store_id` من المستأجر (موثوق) بدل إدخال المستخدم، مع إبقاء التوافق القديم (رمز يدوي).
- `api/tenants.js` — إدارة المتاجر لمالك المنصّة (محمي بـ `x-platform-key`).

**الواجهة:**
- `data.js` — `resolveTenant()` + ترويسة `x-store-slug` + جعل رمز المتجر اختياريًا.
- `main.js` — `ensureTenant()`: متجر معطّل = صفحة "غير متاح"، وتسجيل خروج تلقائي عند اختلاف المتجر.
- `login.html` — يخفي حقل رمز المتجر عندما يُعرف المتجر من الرابط، ويعرض اسمه.
- `platform-admin.html` — لوحتك لإنشاء/تعطيل المتاجر وربط الدومينات.

## 2) متغيّرات البيئة في Vercel (Settings → Environment Variables)

| المتغيّر | مثال | لماذا |
|---|---|---|
| `TURSO_DATABASE_URL` | (موجود) | قاعدة Turso |
| `TURSO_AUTH_TOKEN` | (موجود) | توكن Turso |
| `BWS_SESSION_SECRET` | (موجود) | توقيع الجلسات |
| `BWS_PLATFORM_ADMIN_KEY` | `سرّ-قوي-طويل` | لحماية `platform-admin` |
| `BWS_ROOT_DOMAIN` | `bigstore.dz` | **فقط للدومينات الفرعية** (`ali.bigstore.dz`) |

> بدون `BWS_ROOT_DOMAIN` تعمل حالتان: `?store=slug` والدومين الخاص. عند شراء دومينك وضبط Wildcard، أضِف `BWS_ROOT_DOMAIN` لتفعيل الدومينات الفرعية.

## 3) إنشاء متجر لزبون (الخطوة الأولى دائمًا)

1. افتح `https://<موقعك>/platform-admin.html`.
2. أدخل `BWS_PLATFORM_ADMIN_KEY`.
3. أنشئ متجرًا:
   - **Store ID** = نفس رمز المتجر المستعمل في البرنامج/الهاتف لذلك الزبون.
   - **Slug** = اسم الرابط (مثل `boutique-ali`).
   - **اسم المتجر** + (اختياري) **دومين خاص**.
4. احفظ.

## 4) الحالات الثلاث للتجريب

### الحالة A — رابط فوري بلا أي DNS (`?store=`)
```
https://<موقعك-على-vercel>/index.html?store=boutique-ali
```
- يظهر متجر هذا الزبون فقط؛ صفحة الدخول تخفي رمز المتجر.
- مناسبة للتجريب الفوري. (بعد أول دخول، يُحفظ المتجر محليًا فيبقى أثناء التنقّل.)

### الحالة B — دومين فرعي لكل زبون (`ali.bigstore.dz`)
1. في Vercel: Project → **Domains** → أضِف **Wildcard**: `*.bigstore.dz` (و`bigstore.dz`).
2. عند مزوّد دومينك: سجلّ `CNAME *  →  cname.vercel-dns.com` (وحسب تعليمات Vercel للجذر).
3. أضِف `BWS_ROOT_DOMAIN=bigstore.dz` في Vercel.
4. في `platform-admin`: المتجر بـ Slug = `boutique-ali`.
5. افتح: `https://boutique-ali.bigstore.dz` → يظهر متجره مباشرة.

### الحالة C — دومين خاص بالزبون (`www.boutique-ali.com`)
1. في `platform-admin`: ضع **الدومين الخاص** للمتجر.
2. في Vercel: Project → **Domains** → أضِف `www.boutique-ali.com` (و/أو الجذر).
3. الزبون عند مزوّد دومينه يضيف:
   - `CNAME www → cname.vercel-dns.com`
   - (للجذر `boutique-ali.com`): سجل `A`/`ALIAS` حسب ما يعرضه Vercel.
4. Vercel يتحقق ويُصدر **SSL تلقائيًا** خلال دقائق.
5. افتح `https://www.boutique-ali.com` → متجره وحده، مربوط بـ Store ID الخاص به.

> عند الكِبَر (مئات الدومينات) ننتقل إلى **Cloudflare for SaaS (Custom Hostnames)** كما في الخطة.

## 5) الأمان والعزل
- على الدومين/الدومين الفرعي يُحدَّد المتجر من **Host** (موثوق) — لا يمكن لزبون انتحال متجر آخر.
- `?store=` يُقبل فقط على دومين المنصّة (للتجريب) لا على دومين متجر حقيقي.
- كل بيانات API مفلترة بـ `store_id` المستخرج من المستأجر/التوكن.
- متجر مُعطّل (`is_active=0`) → صفحة "غير متاح" ويُمنع الدخول.

## 6) النشر
```powershell
cd C:\Users\Haithem\Desktop\DigiSoftApp07\bigwebstore
git add .
git commit -m "feat: multi-tenant storefronts (slug/subdomain/custom-domain) + platform admin"
git push
```
ثم اضبط `BWS_PLATFORM_ADMIN_KEY` (و`BWS_ROOT_DOMAIN` عند الحاجة) في Vercel.
