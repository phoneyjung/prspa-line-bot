// ═══════════════════════════════════════════════════════════════════
// PR Spa LINE Bot — Cloudflare Worker  (r1)
//   ⏰ cron  : โพสต์ "📲 อัปเดตพนักงาน" เข้ากลุ่ม LINE ทุก 2 ชม. (09/11/13/15/17/19/21 น.)
//              ข้อความมาจาก snapshots/today_{shop}.lineText ที่แอดมิน (r161+) เขียนทุก 3 นาที
//   🔔 webhook: /webhook   (OA "Admin" ตัวเดียว โพสต์ได้ทุกร้าน)
//              · บอทถูกเชิญเข้ากลุ่ม → ตอบ "รหัสกลุ่ม" ให้ก๊อปไปใส่ตั้งค่า
//              · พิมพ์ "ใครว่าง" ในกลุ่มร้าน → ตอบอัปเดตล่าสุดของร้านนั้น (reply ฟรี) · "ใครว่าง ys" ระบุร้านได้
//              · พิมพ์ "รหัสกลุ่ม" / "id" → ตอบ groupId / userId
//   🛠 manual : GET /run?shop=gs|ys|all&key=ADMIN_KEY   ·   GET /status?key=ADMIN_KEY
//
//   ตั้งค่า (Settings → Variables and Secrets):
//     LINE_TOKEN   Channel access token ของ OA Admin
//     LINE_SECRET  Channel secret ของ OA Admin (ไว้ตรวจลายเซ็น webhook)
//     GROUP_GS     รหัสกลุ่มลูกค้าเกอิชา · GROUP_YS รหัสกลุ่มโยชิ (ได้จากบอทตอบตอนเชิญเข้ากลุ่ม)
//     FIREBASE_API_KEY  (web API key ของ geisha-coupon — ตัวเดียวกับใน app.js)
//     ADMIN_KEY    รหัสอะไรก็ได้ ไว้กด /run ทดสอบ
//     OWNER_ID     (ไม่บังคับ) userId เจ้าของ — รับแจ้งเมื่อโพสต์ไม่ได้ (ทัก OA แล้วพิมพ์ "id" จะได้มา)
// ═══════════════════════════════════════════════════════════════════

const PROJECT = 'geisha-coupon';
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SHOPS = { gs: { key: 'geisha', name: 'เกอิชา' }, ys: { key: 'yoshi', name: 'โยชิ' } };
const STALE_MIN = 40;          // snapshot เก่ากว่านี้ = แอดมินไม่ได้เปิดอยู่ → ไม่โพสต์
const HEARTS = ['❤️', '🧡', '💛', '💚', '💙', '💜'];
const DOW_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(postAll(env, 'cron', 'all')); },

  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'POST' && (p === '/webhook' || p.startsWith('/webhook/'))) return handleWebhook(req, env);
    if (p === '/run') {
      if (url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
      const r = await postAll(env, 'manual', url.searchParams.get('shop') || 'all');
      return json(r);
    }
    if (p === '/status') {
      if (url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
      const doc = await fsGet(env, 'config/lineAutoPost');
      return json({ now: bkkNow().toISOString(), status: doc ? fromFs(doc.fields) : null });
    }
    return new Response('PR Spa LINE bot OK · ' + bkkNow().toISOString());
  },
};

// ─────────────────────────── โพสต์อัปเดต ───────────────────────────
async function postAll(env, source, which) {
  const out = {};
  for (const shop of Object.keys(SHOPS)) {
    if (which !== 'all' && which !== shop) continue;
    out[shop] = await postOne(env, shop, source);
  }
  return out;
}

async function postOne(env, shop, source) {
  const S = shop.toUpperCase();
  const token = env.LINE_TOKEN, group = env['GROUP_' + S];
  if (!token) return { skip: 'ยังไม่ตั้ง LINE_TOKEN' };
  if (!group) return { skip: 'ยังไม่ตั้ง GROUP_' + S + ' (เชิญบอทเข้ากลุ่มแล้วก๊อปรหัสมาใส่)' };
  const cfg = SHOPS[shop];
  const snap = await fsGet(env, `snapshots/today_${cfg.key}`);
  if (!snap) return await record(env, shop, { ok: false, reason: 'ไม่พบ snapshot' });
  const d = fromFs(snap.fields);
  const now = bkkNow();
  const today = ymd(now);
  const ageMin = d.updatedAt ? Math.round((Date.now() - Number(d.updatedAt)) / 60000) : 9999;
  if (d.date !== today || ageMin > STALE_MIN) {
    const reason = `snapshot เก่า (${d.date} · ${ageMin} นาที) — แอดมินไม่ได้เปิดอยู่?`;
    await notifyOwner(env, shop, `⚠️ ${cfg.name}: ไม่ได้โพสต์อัปเดต ${hm(now)} น.\n${reason}\nเปิดแอดมินทิ้งไว้ 1 เครื่อง ระบบจะส่งขึ้นเว็บทุก 3 นาทีเอง`);
    return await record(env, shop, { ok: false, reason });
  }
  const text = (d.lineText && d.lineText.trim()) ? d.lineText.trim() : fallbackText(cfg, d, now);
  const res = await linePush(token, group, text);
  return await record(env, shop, { ok: res.ok, code: res.status, body: res.body.slice(0, 160), len: text.length, source, ageMin });
}

async function record(env, shop, info) {
  const at = bkkNow();
  try {
    await fsPatch(env, 'config/lineAutoPost', { [shop]: { ...info, at: at.toISOString(), atTh: hm(at) } }, [shop]);
  } catch (_) {}
  return info;
}

async function notifyOwner(env, shop, text) {
  const token = env.LINE_TOKEN, to = env.OWNER_ID;
  if (!token || !to) return;
  try { await linePush(token, to, text); } catch (_) {}
}

// สำรอง: ถ้าแอดมินยังเป็นเวอร์ชันเก่า (ไม่มี lineText) — ประกอบเองจาก rows
function fallbackText(cfg, d, now) {
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const isTop = r => (r.tier === 'Top');
  const tag = r => r.tier === 'Top' ? ' (TOP.!)' : r.tier === 'Hot' ? ' (HOT.!)' : r.tier === 'New' ? ' (NEW.!)' : r.tier === 'Comeback' ? ' (COMEBACK.!)' : '';
  let t = `🌸⛩ อัปเดตพนักงานประจำวัน ${DOW_TH[now.getUTCDay()]} ⛩🌸\n🕰 อัปเดตล่าสุด เวลา ${d.updatedAtStr || hm(now)} น.\n\n`;
  const p = rows.filter(r => !isTop(r)), top = rows.filter(isTop);
  p.forEach((r, i) => { t += `${HEARTS[i % HEARTS.length]}${r.nick} ${r.time}${tag(r)}\n`; });
  if (top.length) {
    t += `🎏🏮🏮🏮 TOP 🏮🏮🏮🎏\n`;
    top.forEach((r, i) => { t += `${HEARTS[(p.length + i) % HEARTS.length]}${r.nick} ${r.time}${tag(r)}\n`; });
  }
  if (!rows.length) t += 'ยังไม่มีคนเข้างาน\n';
  t += `\n🔹 หมายเหตุ: (1) = ว่างได้อีก 1 ชม.\n🏪 ${cfg.name}`;
  return t;
}

// ─────────────────────────── webhook ───────────────────────────
function shopOfSource(env, src, txt) {
  const m = /\b(gs|ys)\b/i.exec(txt || '');
  if (m) return m[1].toLowerCase();
  if (src && src.groupId) { for (const k of Object.keys(SHOPS)) if (env['GROUP_' + k.toUpperCase()] === src.groupId) return k; }
  return 'gs';
}
async function handleWebhook(req, env) {
  const token = env.LINE_TOKEN, secret = env.LINE_SECRET;
  const raw = await req.text();
  if (secret) {
    const sig = req.headers.get('x-line-signature') || '';
    if (!(await verifySig(secret, raw, sig))) return new Response('bad signature', { status: 401 });
  }
  let body; try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  for (const ev of (body.events || [])) {
    try {
      const src = ev.source || {};
      const where = src.groupId ? `รหัสกลุ่ม (ใส่ GROUP_GS หรือ GROUP_YS):\n${src.groupId}` : src.roomId ? `รหัสห้อง:\n${src.roomId}` : `userId (ใส่ OWNER_ID):\n${src.userId || '-'}`;
      if (ev.type === 'join') {   // บอทถูกเชิญเข้ากลุ่ม/ห้อง
        await lineReply(token, ev.replyToken, `✅ Admin เข้ากลุ่มแล้ว\n${where}\n\nก๊อปรหัสนี้ไปใส่ตั้งค่า Worker → บอทจะโพสต์อัปเดตพนักงานทุก 2 ชม. (09–21 น.)`);
        continue;
      }
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') continue;
      const txt = String(ev.message.text || '').trim();
      const low = txt.toLowerCase();
      if (low === 'sw') {                                   // 🎟 โค้ดคู่ (เดิม Apps Script)
        await lineReply(token, ev.replyToken, 'sw' + Math.floor(100 + Math.random() * 900));
      } else if (low === 'รหัสกลุ่ม' || low === 'id') {
        await lineReply(token, ev.replyToken, where);
      } else if (/^(ใครว่าง|อัปเดต|update|ว่าง)(\s+(gs|ys))?$/i.test(low)) {   // 📲 อัปเดตล่าสุด (reply ฟรี)
        const cfg = SHOPS[shopOfSource(env, src, low)];
        const snap = await fsGet(env, `snapshots/today_${cfg.key}`);
        const d = snap ? fromFs(snap.fields) : null;
        const now = bkkNow();
        const text = d && d.date === ymd(now) ? ((d.lineText && d.lineText.trim()) || fallbackText(cfg, d, now)) : 'ยังไม่มีอัปเดตวันนี้ค่ะ';
        await lineReply(token, ev.replyToken, text);
      }
    } catch (e) { console.error('webhook event', e); }
  }
  return new Response('ok');
}

// ─────────────────────────── LINE API ───────────────────────────
async function linePush(token, to, text) {
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
  return { ok: r.ok, status: r.status, body: await r.text() };
}
async function lineReply(token, replyToken, text) {
  if (!token || !replyToken) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }),
  });
}
async function verifySig(secret, raw, sig) {
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return b64 === sig;
  } catch { return false; }
}

// ─────────────────────────── Firestore REST ───────────────────────────
async function fsGet(env, path) {
  const r = await fetch(`${FS}/${path}?key=${env.FIREBASE_API_KEY}`);
  if (!r.ok) return null;
  return r.json();
}
async function fsPatch(env, path, obj, fieldPaths) {
  const mask = (fieldPaths || Object.keys(obj)).map(f => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
  const r = await fetch(`${FS}/${path}?key=${env.FIREBASE_API_KEY}&${mask}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFs(obj) }),
  });
  return r.ok;
}
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') { const f = {}; for (const k of Object.keys(v)) f[k] = toFs(v[k]); return { mapValue: { fields: f } }; }
  return { stringValue: String(v) };
}
function fromFs(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) out[k] = fromVal(fields[k]);
  return out;
}
function fromVal(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromVal);
  if ('mapValue' in v) return fromFs(v.mapValue.fields);
  if ('timestampValue' in v) return v.timestampValue;
  return null;
}

// ─────────────────────────── เวลาไทย ───────────────────────────
function bkkNow() { return new Date(Date.now() + 7 * 3600 * 1000); }   // ใช้ getUTC* กับตัวนี้ = เวลาไทย
function ymd(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
function hm(d) { return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }
function json(o) { return new Response(JSON.stringify(o, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
