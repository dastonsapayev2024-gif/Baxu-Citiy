# Baxu City — Telegram Mini App

Tuzilishi:
- `public/index.html` — o'yin (frontend, 3D xarita, hammasi shu yerda)
- `public/shim.js` — o'yinni sizning serveringizga ulaydi (Telegram orqali kirish)
- `api/db.js` — server (Vercel funksiyasi): ma'lumotlar, ruxsatlar, admin tekshiruvi
- `lib/server.js` — Telegram imzosini tekshirish va ruxsat qoidalari

## O'rnatish (taxminan 30 daqiqa)

### 1. Bot yarating
Telegram'da **@BotFather** → `/newbot` → nom va username bering.
U sizga **bot tokeni** beradi (`123456:ABC...`). Tokenni hech kimga bermang.

### 2. O'zingizning Telegram ID'ingizni bilib oling
**@userinfobot** ga `/start` yozing. U sizga raqamli ID beradi (masalan `123456789`).
Admin huquqi faqat shu ID'ga beriladi.

### 3. GitHub
GitHub'da yangi **Private** repo oching va shu papkadagi hamma fayllarni yuklang.

### 4. Vercel
1. vercel.com → Add New → Project → GitHub repongizni tanlang (Framework: Other).
2. **Storage** bo'limida bepul Postgres (Neon) bazasini yarating va shu loyihaga ulang.
   Vercel `DATABASE_URL` (yoki `POSTGRES_URL`) ni o'zi qo'shadi.
3. **Settings → Environment Variables** ga qo'shing:
   | Nomi | Qiymati |
   |---|---|
   | `BOT_TOKEN` | 1-qadamdagi bot tokeni |
   | `ADMIN_TG_ID` | 2-qadamdagi raqamli ID |
   | `APP_LINK` | (keyinroq, 6-qadam) |
4. Deploy bosing. Sizga `https://nom.vercel.app` manzil beriladi.

### 5. Mini App ni botga ulang
@BotFather → `/newapp` → botni tanlang → nom, tavsif, rasm (640x360) →
**Web App URL** so'ralganda Vercel manzilini yuboring → qisqa nom (masalan `game`) bering.
BotFather sizga `https://t.me/BOT_USERNAME/game` havolasini beradi. Shu havola o'yin.

### 6. Taklif havolalari uchun
Vercel → Environment Variables → `APP_LINK` = `https://t.me/BOT_USERNAME/game?startapp=`
(oxiri `?startapp=` bilan tugaydi). Keyin Redeploy qiling.

### 7. Tekshiring
Havolani Telegram'da oching. Siz (ADMIN_TG_ID) kirsangiz "Admin" yorlig'i chiqadi,
boshqalarda chiqmaydi. Birinchi kirganingizda Baxu binosi markazda 200 000 so'mga sotuvga qo'yiladi.

## Xavfsizlik — nima himoyalangan, nima yo'q

Himoyalangan (server tekshiradi):
- Telegram imzosi (initData, HMAC) — soxta o'yinchi yoki soxta ID yuborib bo'lmaydi.
- Admin faqat `ADMIN_TG_ID`. Sozlamalar, buyurtma tasdig'i, jurnal va admin tarixiga faqat admin yozadi.
- Boshqa odamning binosini o'zgartirib, o'chirib yoki o'g'irlab bo'lmaydi.
- Xabarlar faqat egasiga ko'rinadi; buyurtmalar faqat buyurtma bergan va adminga.
- Boshqa o'yinchi hisobiga faqat 0–100 coin sovg'a qo'shish mumkin, ayirib bo'lmaydi.

Hali himoyalanmagan (o'yin mantig'i brauzerda):
- O'yinchi **o'z** coin va qavat sonini brauzer orqali o'zgartira oladi (qavat sotib olish,
  sandiq, missiyalar hali brauzerda hisoblanadi). Haqiqiy pul bilan ishlatishdan oldin bu
  amallarni serverga ko'chirish kerak.
- So'rovlarga tezlik cheklovi (rate limit) yo'q.
- Pul to'lovi qo'lda tekshiriladi (bank API ulanmagan).

## Sinov rejimi
Telegram'siz sinash uchun vaqtincha `DEV_MODE=1` qo'ying va sahifani `?dev=Ism` bilan oching.
**Sinovdan keyin DEV_MODE ni o'chiring**, aks holda har kim istalgan nom bilan kira oladi.

## Maxfiylik
`public/index.html` ichida to'lov karta raqamlari bor (admin panelda o'zgartiriladi).
Repo **Private** bo'lsin.
