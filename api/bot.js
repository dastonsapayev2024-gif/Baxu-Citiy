'use strict';
const crypto = require('crypto');
const TOKEN = () => String(process.env.BOT_TOKEN || '').replace(/\s+/g, '');
const SECRET = () => crypto.createHash('sha256').update('wh:' + TOKEN()).digest('hex').slice(0, 40);
const tg = (m, body) => fetch('https://api.telegram.org/bot' + TOKEN() + '/' + m, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
}).then(r => r.json()).catch(e => ({ ok: false, description: String(e && e.message || e) }));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = 'https://' + host;

  // GET: holat tekshirish yoki webhookni ulash (?setup=1)
  if (req.method === 'GET') {
    if (!TOKEN()) return res.status(500).send('BOT_TOKEN sozlanmagan');
    if (req.query && req.query.setup != null) {
      const r = await tg('setWebhook', {
        url: base + '/api/bot', secret_token: SECRET(),
        allowed_updates: ['message'], drop_pending_updates: true
      });
      return res.json({ ok: !!r.ok, info: r.description || 'webhook ulandi', url: base + '/api/bot' });
    }
    return res.send('Bot webhook tayyor');
  }

  if (req.headers['x-telegram-bot-api-secret-token'] !== SECRET()) return res.status(401).end();
  let u = req.body;
  try { if (typeof u === 'string') u = JSON.parse(u); } catch (e) { u = {}; }
  const m = u && u.message;
  if (!m || !m.chat) return res.status(200).end();

  const appBase = String(process.env.APP_LINK || 'https://t.me/Baxu_Biznes_Bot/game?startapp=').split('?')[0];
  const parts = String(m.text || '').trim().split(/\s+/);
  const payload = /^[A-Za-z0-9_-]{1,64}$/.test(parts[1] || '') ? parts[1] : '';
  const link = payload ? appBase + '?startapp=' + payload : appBase;
  const share = 'https://t.me/share/url?url=' + encodeURIComponent(appBase) + '&text=' + encodeURIComponent('Baxu City: shahringni qur, do‘stlar bilan o‘yna va coin top!');
  const kb = { inline_keyboard: [[{ text: '🎮 O‘ynash', url: link }], [{ text: '👥 Do‘stni chaqirish', url: share }]] };
  const caption = '🏙 <b>Baxu City</b>\n\nO‘z shahringni qur, uy sotib ol, do‘stlar bilan o‘yna, coin top va boy bo‘l!\n\nBoshlash uchun pastdagi tugmani bosing 👇';

  let r = await tg('sendPhoto', { chat_id: m.chat.id, photo: base + '/start.jpg', caption, parse_mode: 'HTML', reply_markup: kb });
  if (!r.ok) await tg('sendMessage', { chat_id: m.chat.id, text: caption, parse_mode: 'HTML', reply_markup: kb });
  res.status(200).end();
};
