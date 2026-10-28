const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const fs = require('fs');

// ================== SOZLAMALAR (shu yerga yozing) ==================
const BOT_TOKEN = '8801184230:AAEQ0Co561fb8tWTKW1yqgLAMYwfovwAyi4';   // BotFather bergan token
const ADMIN_IDS = [5152426699];                     // admin Telegram ID (bir nechta bo'lsa: [111, 222])
const TEST_REJIMI = true;  // true = admin panelda test tugmalari bor. Sinab bo'lgach false qiling.
const GROUP_ID = 0;        // ijarachilar guruhi ID si (masalan -1001234567890). 0 = guruh o'chiq
const GROUP_LINK = '';     // guruhga taklif havolasi (masalan https://t.me/+AbCdEf...). Bo'sh bo'lsa ko'rsatilmaydi
// ===================================================================

const DB_FILE = './data.json';
const TZ = 'Asia/Tashkent';
const BINOLAR = ['A', 'B', 'C', 'D']; // keyin nomini shu yerda o'zgartirasiz

if (!BOT_TOKEN || BOT_TOKEN.includes('BU_YERGA')) {
  console.error('index.js ning boshiga BOT_TOKEN ni yozing!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
let BOT_USERNAME = '';
bot.telegram.getMe().then(me => { BOT_USERNAME = me.username; }).catch(() => {});

// ---------- Ma'lumot saqlash (oddiy JSON fayl) ----------
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    d.tenants = d.tenants || {};
    d.payments = d.payments || {};
    return d;
  } catch { return { tenants: {}, payments: {} }; }
}
function save(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }

let db = load();
const steps = {};       // ro'yxatdan o'tish bosqichi (xotirada)
const adminState = {};  // admin hozir nima kutayotgani (xotirada)

// ---------- 5 xonali ID ----------
function genKod() {
  const used = new Set(Object.values(db.tenants).map(t => String(t.kod)));
  let k;
  do { k = String(Math.floor(10000 + Math.random() * 90000)); } while (used.has(k));
  return k;
}
function ensureCodes() { // eski ijarachilarga ham ID berib chiqadi
  let changed = false;
  for (const t of Object.values(db.tenants)) {
    if (!t.kod) { t.kod = genKod(); changed = true; }
  }
  if (changed) save(db);
}
ensureCodes();

// ---------- Username yangilash va blok holatini kuzatish ----------
bot.use(async (ctx, next) => {
  const from = ctx.from;
  if (from && ctx.chat && ctx.chat.type === 'private') {
    const d = load();
    const t = d.tenants[from.id];
    if (t) {
      let changed = false;
      if (ctx.updateType === 'my_chat_member') {
        // foydalanuvchi botni bloklasa / blokdan chiqarsa shu zahoti bilamiz
        const st = ctx.myChatMember.new_chat_member.status;
        if (st === 'kicked') { t.blocked = true; t.blockedAt = new Date().toISOString(); changed = true; }
        else if (t.blocked) { delete t.blocked; delete t.blockedAt; changed = true; }
        if (changed) { save(d); db = d; }
        return; // boshqa ishlov kerak emas
      }
      if ((t.username || null) !== (from.username || null)) { t.username = from.username || null; changed = true; }
      if (t.blocked) { delete t.blocked; delete t.blockedAt; changed = true; } // yozdi — demak bot ochiq
      if (changed) { save(d); db = d; }
    }
  }
  return next();
});

// ---------- Yordamchi ----------
const OYLAR = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul',
  'Avgust', 'Sentabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
const todayTashkent = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const monthKey = () => todayTashkent().slice(0, 7);          // YYYY-MM
const payKey = (id, m = monthKey()) => `${id}_${m}`;
const fmt = (n) => Number(n).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
const monthName = (m) => `${OYLAR[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const esc = (s) => String(s ?? '—')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nowTashkent = () =>
  new Date().toLocaleString('ru-RU', { timeZone: TZ, hour12: false });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isAdmin = (id) => ADMIN_IDS.includes(id);

const allTenants = () => Object.values(db.tenants).sort((a, b) =>
  String(a.bino || '~').localeCompare(String(b.bino || '~')) ||
  String(a.firma).localeCompare(String(b.firma)));
const findByKod = (kod) =>
  Object.values(db.tenants).find(t => String(t.kod) === String(kod).trim());
const statusOf = (t, m = monthKey()) => db.payments[payKey(t.id, m)];
const STATUS_TXT = { accepted: "✅ to'lagan", pending: '⏳ tekshiruvda', rejected: '❌ rad etilgan' };
const statusTxt = (t) => STATUS_TXT[statusOf(t)] || "🔴 to'lamagan";

const payBtn = (id) =>
  Markup.inlineKeyboard([[Markup.button.callback("✅ To'lov qildim", `pay:${id}`)]]);

// uzun matnni bo'lib yuborish (Telegram limiti 4096)
async function sendLongTo(chatId, text) {
  const send = (c) => bot.telegram.sendMessage(chatId, c,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  let chunk = '';
  for (const line of text.split('\n')) {
    if ((chunk + '\n' + line).length > 3800) {
      await send(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) await send(chunk);
}
const sendLong = (ctx, text) => sendLongTo(ctx.chat.id, text);

// Admin uchun chiroyli karta
function adminCard(t, month, title, statusLine) {
  return [
    `${title}`,
    `━━━━━━━━━━━━━━━━━━`,
    `🆔 <b>ID:</b> ${esc(t.kod)}`,
    `🏢 <b>Bino:</b> ${esc(t.bino)}`,
    `🏷 <b>Firma:</b> ${esc(t.firma)}`,
    `👤 <b>Ijarachi:</b> ${esc(t.ism)}`,
    `📞 <b>Telefon:</b> ${esc(t.tel)}`,
    `💰 <b>Summa:</b> ${fmt(t.summa)} so'm`,
    `📅 <b>Oy:</b> ${monthName(month)}`,
    `━━━━━━━━━━━━━━━━━━`,
    `${statusLine}`,
    `<a href="tg://user?id=${t.id}">👉 Telegramda ochish</a>`,
  ].join('\n');
}

function tenantInfo(t) {
  return `🆔 ID: ${t.kod}\n🏢 Bino: ${t.bino || '—'}\n🏷 Firma: ${t.firma}\n👤 ${t.ism}\n📞 ${t.tel}\n💰 ${fmt(t.summa)} so'm`;
}

// Bog'lanish havolasi: username bo'lsa @username, bo'lmasa ID orqali
function contactHtml(t) {
  if (t.username) {
    return `<a href="https://t.me/${esc(t.username)}">@${esc(t.username)}</a>`;
  }
  return `<a href="tg://user?id=${t.id}">ID orqali ochish</a> (username yo'q)`;
}

const UNREACH_FOOTER = "Bu odamlar botni bloklagan yoki akkauntini o'chirgan, bot ularga yoza olmaydi. " +
  "Yuqoridagi havola yoki telefon raqam orqali o'zingiz murojaat qiling.";

function unreachableText(list, title = '📵 <b>XABAR YETIB BORMAGANLAR</b>', footer = UNREACH_FOOTER) {
  let text = `${title} (${list.length} ta)\n━━━━━━━━━━━━━━━━━━\n`;
  for (const t of list) {
    text += `\n🆔 <code>${t.kod}</code> • 🏢 ${esc(t.bino)} • ${esc(t.firma)}\n` +
      `   👤 ${esc(t.ism)}\n   💬 ${contactHtml(t)}\n   📞 ${esc(t.tel)}\n   💰 ${fmt(t.summa)} so'm • ${statusTxt(t)}\n`;
  }
  text += `\n━━━━━━━━━━━━━━━━━━\n${footer}`;
  return text;
}

// ====================== ADMIN PANEL ======================
const B = {
  LIST: "📋 Ro'yxat",
  UNPAID: "🔴 To'lamaganlar",
  STATS: '📊 Statistika',
  FIND: '🔍 Qidirish',
  DEL: "🗑 O'chirish",
  PAID: "✅ Qo'lda to'landi",
  AMOUNT: "💰 Summani o'zgartirish",
  CAST: '📢 Xabar yuborish',
  UNREACH: '📵 Yetib bormaganlar',
  NOGROUP: "👥 Guruhda yo'qlar",
  TEST: '🧪 Test eslatma',
  RESET: "♻️ To'lovlarni tozalash",
};

function panelKeyboard() {
  const rows = [
    [B.LIST, B.UNPAID],
    [B.STATS, B.FIND],
    [B.DEL, B.PAID],
    [B.AMOUNT, B.CAST],
    [B.UNREACH],
  ];
  if (GROUP_ID) rows[rows.length - 1].push(B.NOGROUP);
  if (TEST_REJIMI) rows.push([B.TEST, B.RESET]);
  return Markup.keyboard(rows).resize(); // pastda doim ko'rinib turadi
}

const ADMIN_BUTTONS = Object.entries(B)
  .filter(([k]) => (TEST_REJIMI || (k !== 'TEST' && k !== 'RESET')) && (GROUP_ID || k !== 'NOGROUP'))
  .map(([, v]) => v);

function listText() {
  const list = allTenants();
  if (!list.length) return "Hali hech kim yo'q.";
  let text = `📋 <b>${monthName(monthKey())}</b> — jami ${list.length} ta ijarachi\n`;
  for (const b of BINOLAR) {
    const rows = list.filter(t => t.bino === b);
    if (!rows.length) continue;
    text += `\n🏢 <b>${b} bino</b>\n`;
    for (const t of rows) {
      text += `🆔 <code>${t.kod}</code> • ${esc(t.firma)} — ${esc(t.ism)} — ${fmt(t.summa)} so'm — ${statusTxt(t)}\n`;
    }
  }
  const others = list.filter(t => !BINOLAR.includes(t.bino));
  if (others.length) {
    text += `\n🏢 <b>Bino tanlanmagan</b>\n`;
    for (const t of others) {
      text += `🆔 <code>${t.kod}</code> • ${esc(t.firma)} — ${esc(t.ism)} — ${statusTxt(t)}\n`;
    }
  }
  return text;
}

function unpaidText() {
  const list = allTenants().filter(t => statusOf(t) !== 'accepted');
  if (!list.length) return `🎉 ${monthName(monthKey())} oyi uchun hamma to'lagan!`;
  let text = `🔴 <b>To'lamaganlar — ${monthName(monthKey())}</b> (${list.length} ta)\n`;
  for (const t of list) {
    text += `\n🆔 <code>${t.kod}</code> • 🏢 ${esc(t.bino)} • ${esc(t.firma)}\n   👤 ${esc(t.ism)} • 📞 ${esc(t.tel)}\n   💰 ${fmt(t.summa)} so'm • ${statusTxt(t)}\n`;
  }
  return text;
}

function statsText() {
  const list = allTenants();
  const sum = (arr) => arr.reduce((s, t) => s + Number(t.summa || 0), 0);
  let text = `📊 <b>Statistika — ${monthName(monthKey())}</b>\n━━━━━━━━━━━━━━━━━━\n`;
  const groups = [...BINOLAR, null];
  for (const b of groups) {
    const rows = list.filter(t => b ? t.bino === b : !BINOLAR.includes(t.bino));
    if (!rows.length) continue;
    const paid = rows.filter(t => statusOf(t) === 'accepted');
    const pend = rows.filter(t => statusOf(t) === 'pending');
    const unpaid = rows.length - paid.length - pend.length;
    text += `\n🏢 <b>${b ? b + ' bino' : 'Bino tanlanmagan'}</b>\n` +
      `👥 Ijarachi: ${rows.length}\n✅ To'lagan: ${paid.length}\n⏳ Tekshiruvda: ${pend.length}\n🔴 To'lamagan: ${unpaid}\n` +
      `💰 ${fmt(sum(paid))} / ${fmt(sum(rows))} so'm\n`;
  }
  const paidAll = list.filter(t => statusOf(t) === 'accepted');
  text += `\n━━━━━━━━━━━━━━━━━━\n<b>JAMI</b>\n👥 ${list.length} ta ijarachi\n✅ To'lagan: ${paidAll.length}\n💰 Yig'ilgan: ${fmt(sum(paidAll))} so'm\n📌 Kutilgan: ${fmt(sum(list))} so'm\n🔻 Qolgan: ${fmt(sum(list) - sum(paidAll))} so'm`;
  return text;
}

function tenantCard(t) {
  return [
    `🔎 <b>IJARACHI MA'LUMOTI</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🆔 <b>ID:</b> ${esc(t.kod)}`,
    `🏢 <b>Bino:</b> ${esc(t.bino)}`,
    `🏷 <b>Firma:</b> ${esc(t.firma)}`,
    `👤 <b>Ijarachi:</b> ${esc(t.ism)}`,
    `📞 <b>Telefon:</b> ${esc(t.tel)}`,
    `💰 <b>Summa:</b> ${fmt(t.summa)} so'm`,
    `🔗 <b>Username:</b> ${t.username ? '@' + esc(t.username) : "yo'q"}`,
    ...(t.blocked ? ['📵 <b>Bot:</b> bloklangan, xabar yetib bormaydi'] : []),
    `📅 <b>${monthName(monthKey())}:</b> ${statusTxt(t)}`,
    `🗓 <b>Ro'yxatdan o'tgan:</b> ${t.createdAt ? new Date(t.createdAt).toLocaleDateString('ru-RU', { timeZone: TZ }) : '—'}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<a href="tg://user?id=${t.id}">👉 Telegramda ochish</a>`,
  ].join('\n');
}

async function handleAdminButton(ctx, text) {
  const id = ctx.from.id;
  db = load();
  switch (text) {
    case B.LIST: return sendLong(ctx, listText());
    case B.UNPAID: return sendLong(ctx, unpaidText());
    case B.STATS: return ctx.reply(statsText(), { parse_mode: 'HTML' });
    case B.NOGROUP: {
      const out = [];
      for (const t of allTenants()) {
        if ((await isInGroup(t.id)) === false) out.push(t);
        await sleep(50);
      }
      if (!out.length) return ctx.reply('✅ Hamma ijarachi guruhda.');
      return sendLong(ctx, unreachableText(out, "👥 <b>GURUHDA YO'QLAR</b>",
        "Bu odamlar guruhga qo'shilmagan, shuning uchun guruhdagi @ eslatma ularga bormaydi. " +
        "Guruh havolasini ularga o'zingiz yuboring."));
    }
    case B.UNREACH: {
      const list = allTenants().filter(t => t.blocked);
      if (!list.length) return ctx.reply('✅ Hamma ijarachiga xabar yetib boryapti.');
      return sendLong(ctx, unreachableText(list));
    }
    case B.FIND:
      adminState[id] = { action: 'find' };
      return ctx.reply('🔍 Ijarachining 5 xonali ID sini yozing:');
    case B.DEL:
      adminState[id] = { action: 'del' };
      return ctx.reply("🗑 O'chiriladigan ijarachining 5 xonali ID sini yozing.\n⚠️ ID yozilishi bilan darhol o'chiriladi va unga xabar boradi.");
    case B.PAID:
      adminState[id] = { action: 'paid' };
      return ctx.reply("✅ Bu oy to'lovi qo'lda qabul qilinadigan ijarachining 5 xonali ID sini yozing:");
    case B.AMOUNT:
      adminState[id] = { action: 'amount_id' };
      return ctx.reply("💰 Summasi o'zgartiriladigan ijarachining 5 xonali ID sini yozing:");
    case B.CAST:
      adminState[id] = { action: 'cast' };
      return ctx.reply('📢 Hamma ijarachilarga yuboriladigan xabar matnini yozing:');
    case B.TEST:
      return ctx.reply(
        '🧪 <b>Test eslatma</b>\n\nQaysi kun xabarini sinaymiz?',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('1-sana', 'tday:1'),
            Markup.button.callback('3-sana', 'tday:3'),
            Markup.button.callback('5-sana', 'tday:5'),
          ]]),
        }
      );
    case B.RESET:
      return ctx.reply(
        `♻️ ${monthName(monthKey())} oyidagi barcha to'lov holatlari tozalansinmi?\n(Test tugagach shuni bosib hammasini boshidan boshlash mumkin.)`,
        Markup.inlineKeyboard([[
          Markup.button.callback('✅ Ha, tozalash', 'reset_ok'),
          Markup.button.callback("❌ Yo'q", 'reset_no'),
        ]])
      );
  }
}

async function handleAdminInput(ctx, st, text) {
  const id = ctx.from.id;
  db = load();

  // Xabar yuborish — avval matn, keyin tasdiq
  if (st.action === 'cast') {
    adminState[id] = { action: 'cast_confirm', text };
    return ctx.reply(
      `📢 <b>Quyidagi xabar ${Object.keys(db.tenants).length} ta ijarachiga yuboriladi:</b>\n\n${esc(text)}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('✅ Yuborish', 'cast_ok'),
          Markup.button.callback('❌ Bekor', 'cast_no'),
        ]]),
      }
    );
  }

  // Yangi summa kiritish
  if (st.action === 'amount_val') {
    const summa = Number(text.replace(/[^\d]/g, ''));
    if (!summa) return ctx.reply('Faqat raqam yozing, masalan: 3500000');
    const t = findByKod(st.kod);
    if (!t) { delete adminState[id]; return ctx.reply('Ijarachi topilmadi.'); }
    const old = t.summa;
    t.summa = summa;
    save(db);
    delete adminState[id];
    await ctx.reply(`✅ ${esc(t.firma)} (ID ${t.kod}) summasi o'zgartirildi:\n${fmt(old)} → ${fmt(summa)} so'm`);
    bot.telegram.sendMessage(
      t.id,
      `ℹ️ Firmangiz uchun kelishilgan ijara summasi o'zgartirildi.\nYangi summa: ${fmt(summa)} so'm`
    ).catch(() => {});
    return;
  }

  // Qolgan amallar ID so'raydi
  if (!/^\d{5}$/.test(text)) {
    return ctx.reply('❌ ID 5 ta raqamdan iborat bo\'lishi kerak. Qayta yozing (yoki boshqa tugmani bosing).');
  }
  const t = findByKod(text);
  if (!t) return ctx.reply('❌ Bunday ID topilmadi. Qayta yozing (yoki boshqa tugmani bosing).');

  if (st.action === 'find') {
    delete adminState[id];
    return ctx.reply(tenantCard(t), { parse_mode: 'HTML' });
  }

  if (st.action === 'del') {
    delete db.tenants[t.id];
    for (const k of Object.keys(db.payments)) {
      if (k.startsWith(`${t.id}_`)) delete db.payments[k];
    }
    delete steps[t.id];
    save(db);
    delete adminState[id];
    await ctx.reply(
      `🗑 <b>O'CHIRILDI</b>\n━━━━━━━━━━━━━━━━━━\n🆔 ${esc(t.kod)}\n🏢 Bino: ${esc(t.bino)}\n🏷 Firma: ${esc(t.firma)}\n👤 ${esc(t.ism)}\n━━━━━━━━━━━━━━━━━━\nIjarachiga xabar yuborildi.`,
      { parse_mode: 'HTML' }
    );
    bot.telegram.sendMessage(
      t.id,
      "❌ Sizni admin ro'yxatdan o'chirib tashladi.\n\nBundan keyin eslatmalar kelmaydi. Qayta ro'yxatdan o'tish uchun /start ni bosing.",
      Markup.removeKeyboard()
    ).catch(() => {});
    return;
  }

  if (st.action === 'paid') {
    db.payments[payKey(t.id)] = 'accepted';
    save(db);
    delete adminState[id];
    await ctx.reply(
      adminCard(t, monthKey(), `✅ <b>QO'LDA QABUL QILINDI</b>  •  🏢 ${esc(t.bino)} bino`, `✅ <b>Holat:</b> to'langan deb belgilandi\n🕒 ${nowTashkent()}`),
      { parse_mode: 'HTML' }
    );
    bot.telegram.sendMessage(
      t.id,
      `✅ To'lovingiz admin tomonidan qabul qilindi. Rahmat, ${t.ism}! Bu oy uchun boshqa eslatma yuborilmaydi.`
    ).catch(() => {});
    return;
  }

  if (st.action === 'amount_id') {
    adminState[id] = { action: 'amount_val', kod: t.kod };
    return ctx.reply(`🏷 ${t.firma} (${t.ism})\nHozirgi summa: ${fmt(t.summa)} so'm\n\nYangi summani yozing (faqat raqam):`);
  }

  if (st.action === 'test_one') {
    delete adminState[id];
    delete db.payments[payKey(t.id)]; // test uchun bu oylik holatni tozalaydi
    save(db);
    const r = await sendReminderTo(t, st.day, '🧪 TEST\n\n');
    db = load();
    markDelivery(t.id, r);
    save(db);
    if (GROUP_ID) await reportGroup(ctx.from.id, await groupRemind(st.day, [t], true));
    if (r.ok) return ctx.reply(`🧪 ${st.day}-sana xabari ${t.firma} (${t.ism}) ga yuborildi.`);
    return ctx.reply(
      `⚠️ Yetib bormadi.\n\n${unreachableText([db.tenants[t.id] || t], '📵 <b>YETIB BORMADI</b>')}`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  }
}

// Admin: /admin yoki /panel
bot.command(['admin', 'panel'], (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  delete adminState[ctx.from.id];
  ctx.reply('🛠 Admin panel', panelKeyboard());
});

// ====================== RO'YXATDAN O'TISH ======================
function startRegistration(ctx) {
  const id = ctx.from.id;
  db = load();
  if (db.tenants[id]) {
    return ctx.reply(
      `Siz allaqachon ro'yxatdan o'tgansiz:\n\n${tenantInfo(db.tenants[id])}\n\nMa'lumotni o'zgartirish uchun /qayta ni bosing.${groupInviteLine()}`
    );
  }
  steps[id] = { step: 'ism' };
  ctx.reply('Assalomu alaykum! Ism va familiyangizni yozing:');
}

bot.start((ctx) => {
  if (ctx.chat.type !== 'private') return;
  const id = ctx.from.id;
  delete adminState[id];
  if (isAdmin(id)) {
    return ctx.reply(
      "🛠 Admin panel ochildi.\n\nO'zingizni ijarachi sifatida qo'shib sinash uchun: /ijarachi",
      panelKeyboard()
    );
  }
  startRegistration(ctx);
});

bot.command('ijarachi', startRegistration);

bot.command('qayta', (ctx) => {
  steps[ctx.from.id] = { step: 'ism' };
  ctx.reply('Ism va familiyangizni yozing:', Markup.removeKeyboard());
});

// Bino tanlash (tugmalar)
bot.action(/^bino:([A-Z])$/, async (ctx) => {
  const id = ctx.from.id;
  const s = steps[id];
  if (!s || s.step !== 'bino') return ctx.answerCbQuery('Avval /start bosing');
  s.bino = ctx.match[1];
  s.step = 'summa';
  await ctx.answerCbQuery(`${s.bino} bino tanlandi`);
  await ctx.editMessageText(`🏢 Tanlangan bino: ${s.bino}`).catch(() => {});
  await ctx.reply('Kelishilgan oylik ijara summasini yozing (faqat raqam, masalan: 3000000):');
});

// Admin matnlari (tugmalar va kiritishlar) — umumiy handlerdan OLDIN
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return;
  const id = ctx.from.id;
  if (!isAdmin(id)) return next();
  const text = ctx.message.text.trim();
  if (ADMIN_BUTTONS.includes(text)) {
    delete adminState[id];
    return handleAdminButton(ctx, text);
  }
  const st = adminState[id];
  if (st && !text.startsWith('/')) return handleAdminInput(ctx, st, text);
  return next();
});

bot.on('message', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const id = ctx.from.id;
  const s = steps[id];
  if (!s) return;

  const text = ctx.message.text && ctx.message.text.trim();

  if (s.step === 'ism') {
    if (!text) return ctx.reply('Iltimos, matn yozing.');
    s.ism = text;
    s.step = 'tel';
    return ctx.reply(
      'Telefon raqamingizni yozing yoki pastdagi tugma orqali kontaktni ulashing:',
      Markup.keyboard([[Markup.button.contactRequest('📞 Kontaktni ulashish')]])
        .oneTime().resize()
    );
  }

  if (s.step === 'tel') {
    const tel = ctx.message.contact ? ctx.message.contact.phone_number : text;
    if (!tel) return ctx.reply('Telefon raqam yuboring.');
    s.tel = tel;
    s.step = 'firma';
    return ctx.reply('Firmangiz nomini yozing:', Markup.removeKeyboard());
  }

  if (s.step === 'firma') {
    if (!text) return ctx.reply('Iltimos, matn yozing.');
    s.firma = text;
    s.step = 'bino';
    return ctx.reply(
      '🏢 Qaysi binoda joylashgansiz? Tanlang:',
      Markup.inlineKeyboard([BINOLAR.map(b => Markup.button.callback(`${b} bino`, `bino:${b}`))])
    );
  }

  if (s.step === 'bino') {
    return ctx.reply('Iltimos, yuqoridagi tugmalardan binoni tanlang 👆');
  }

  if (s.step === 'summa') {
    const summa = Number((text || '').replace(/[^\d]/g, ''));
    if (!summa) return ctx.reply('Faqat raqam yozing, masalan: 3000000');
    db = load();
    const old = db.tenants[id];
    const t = {
      id, kod: (old && old.kod) || genKod(),
      ism: s.ism, tel: s.tel, firma: s.firma, bino: s.bino, summa,
      username: ctx.from.username || null,
      createdAt: (old && old.createdAt) || new Date().toISOString(),
    };
    db.tenants[id] = t;
    save(db);
    delete steps[id];
    await ctx.reply(
      `✅ Ma'lumotlaringiz saqlandi:\n\n${tenantInfo(t)}\n\nHar oyning 1, 3 va 5-sanalarida to'lov haqida eslatma yuboriladi.${groupInviteLine()}`,
      isAdmin(id) ? panelKeyboard() : undefined
    );
    for (const a of ADMIN_IDS) {
      bot.telegram.sendMessage(
        a,
        adminCard(t, monthKey(), '🆕 <b>YANGI IJARACHI</b>', "📝 Ro'yxatdan o'tdi"),
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }
});

// ====================== GURUHDA @ BILAN ESLATMA ======================
// Bot chatini sukut qilganlarga ham bildirishnoma borishi uchun:
// guruhda @username bilan belgilanadi (guruh sukutda bo'lsa ham @ belgilash bildirishnoma beradi).
const mentionHtml = (t) => t.username
  ? `@${esc(t.username)}`
  : `<a href="tg://user?id=${t.id}">${esc(t.ism)}</a>`;

async function isInGroup(uid) {
  if (!GROUP_ID) return null;
  try {
    const m = await bot.telegram.getChatMember(GROUP_ID, uid);
    if (['creator', 'administrator', 'member'].includes(m.status)) return true;
    if (m.status === 'restricted') return m.is_member !== false;
    return false; // left / kicked
  } catch (e) {
    return null; // noma'lum (bot guruhda admin emas va hokazo)
  }
}

const GROUP_HEAD = {
  1: '📅 <b>Yangi oy boshlandi!</b> Ijara to\'lovi vaqti keldi.',
  3: '⏰ <b>Ijara to\'lovini eslatamiz.</b>',
  5: '🚨 <b>Bugun ijara to\'lashning OXIRGI kuni!</b>',
};

// targets — to'lov qilishi kerak bo'lgan ijarachilar. Guruhda yo'qlar notIn ga tushadi.
async function groupRemind(day, targets, test = false) {
  const res = { sent: 0, notIn: [], error: null };
  if (!GROUP_ID || !targets.length) return res;
  const inList = [];
  for (const t of targets) {
    const r = await isInGroup(t.id);
    if (r === false) res.notIn.push(t); else inList.push(t);
    await sleep(50);
  }
  const kb = BOT_USERNAME
    ? Markup.inlineKeyboard([[Markup.button.url('🤖 Botni ochish', `https://t.me/${BOT_USERNAME}`)]])
    : {};
  for (let i = 0; i < inList.length; i += 25) {
    const part = inList.slice(i, i + 25);
    const text = `${test ? '🧪 <b>TEST</b>\n' : ''}${GROUP_HEAD[day] || GROUP_HEAD[3]}\n\n` +
      part.map(t => `• ${mentionHtml(t)}`).join('\n') +
      `\n\n👇 Tafsilot va to'lov tugmasi botda`;
    try {
      await bot.telegram.sendMessage(GROUP_ID, text, { parse_mode: 'HTML', ...kb });
      res.sent += part.length;
    } catch (e) {
      res.error = e.message;
      console.log('Guruhga yuborib bo\'lmadi:', e.message);
    }
    await sleep(300);
  }
  return res;
}

async function reportGroup(chatId, g) {
  if (!GROUP_ID) return;
  if (g.error) {
    await bot.telegram.sendMessage(chatId, `⚠️ Guruhga yozib bo'lmadi: ${g.error}\nBot guruhda admin ekanini va GROUP_ID to'g'riligini tekshiring.`).catch(() => {});
  } else {
    await bot.telegram.sendMessage(chatId, `👥 Guruhda belgilandi: ${g.sent} ta, guruhda yo'q: ${g.notIn.length} ta`).catch(() => {});
  }
  if (g.notIn.length) {
    await sendLongTo(chatId, unreachableText(g.notIn, "👥 <b>GURUHDA YO'QLAR</b>",
      "Bu odamlar guruhga qo'shilmagan, shuning uchun guruhdagi @ eslatma ularga bormadi. " +
      "Guruh havolasini ularga o'zingiz yuboring.")).catch(() => {});
  }
}

const groupInviteLine = () => GROUP_LINK
  ? `\n\n👥 Eslatmalarni o'tkazib yubormaslik uchun guruhga qo'shiling:\n${GROUP_LINK}`
  : '';

// Guruh ID sini bilish uchun: botni guruhga qo'shib, admin shu yerda /guruhid yozadi
bot.command('guruhid', (ctx) => {
  if (!isAdmin(ctx.from.id) || ctx.chat.type === 'private') return;
  ctx.reply(`Guruh ID: ${ctx.chat.id}`);
});

// ====================== ESLATMALAR ======================
// Xabar boshiga @username qo'yiladi (username bo'lmasa — oddiy)
function messageFor(day, t) {
  const head = t.username ? `@${t.username}\n` : '';
  return head + bodyFor(day, t);
}

function bodyFor(day, t) {
  const joy = `"${t.firma}"${t.bino ? ` (${t.bino} bino)` : ''}`;
  if (day === 1)
    return `Yangi oy boshlandi.\nHurmatli ${t.ism}, sizning ${joy} firmangiz uchun to'lanishi kerak bo'lgan ijara puli: ${fmt(t.summa)} so'm.`;
  if (day === 3)
    return `Hurmatli ${t.ism}, ${joy} firmangiz uchun ${fmt(t.summa)} so'm to'lov qilishingiz kerak.`;
  return `Hurmatli ${t.ism}, ${joy} firmangiz uchun to'lov qilishning OXIRGI sanasi bugun. To'lov summasi: ${fmt(t.summa)} so'm.\n\nTo'lov qilgan bo'lsangiz, pastdagi tugmani bosing 👇`;
}

async function sendReminderTo(t, day, prefix = '') {
  try {
    await bot.telegram.sendMessage(t.id, prefix + messageFor(day, t), payBtn(t.id));
    return { ok: true };
  } catch (e) {
    const code = e.response && e.response.error_code;
    console.log("Yuborib bo'lmadi:", t.id, code, e.message);
    return { ok: false, code };
  }
}

// yetib bordi/bormadi holatini ijarachiga yozib qo'yadi
function markDelivery(tid, r) {
  const t = db.tenants[tid];
  if (!t) return;
  if (r.ok) {
    delete t.blocked; delete t.blockedAt;
  } else if (r.code === 403 || r.code === 400) { // bloklagan / akkaunt o'chgan / chat topilmadi
    t.blocked = true;
    t.blockedAt = new Date().toISOString();
  }
}

// test=true bo'lsa: holatga qaramay hammaga yuboradi va holatlarni tozalaydi
async function sendReminders(day, { test = false } = {}) {
  db = load();
  const targets = [];
  for (const t of Object.values(db.tenants)) {
    if (test) {
      delete db.payments[payKey(t.id)];
      targets.push(t);
    } else {
      const st = db.payments[payKey(t.id)];
      if (st === 'accepted' || st === 'pending') continue; // qabul qilingan/tekshirilayotgan
      targets.push(t);
    }
  }
  if (test) save(db);

  const results = [];
  for (const t of targets) {
    const r = await sendReminderTo(t, day, test ? '🧪 TEST\n\n' : '');
    results.push({ id: t.id, r });
    await sleep(100); // Telegram limiti uchun
  }

  // yuborish paytida boshqa o'zgarishlar bo'lgan bo'lishi mumkin — yangidan o'qib yozamiz
  db = load();
  for (const x of results) markDelivery(x.id, x.r);
  save(db);

  const failed = results.filter(x => !x.r.ok).map(x => db.tenants[x.id]).filter(Boolean);
  return { ok: results.length - failed.length, fail: failed.length, failed, targets };
}

// Haqiqiy jadval: har oyning 1, 3, 5-sanasi, soat 09:00 (Toshkent)
cron.schedule('0 9 1,3,5 * *', async () => {
  const day = Number(todayTashkent().slice(8, 10));
  const r = await sendReminders(day);
  const g = await groupRemind(day, r.targets);
  for (const a of ADMIN_IDS) {
    bot.telegram.sendMessage(a, `🔔 ${day}-sana eslatmasi: ${r.ok} ta yetib bordi, ${r.fail} ta yetmadi`).catch(() => {});
    if (r.failed.length) await sendLongTo(a, unreachableText(r.failed)).catch(() => {});
    await reportGroup(a, g);
  }
}, { timezone: TZ });

// ====================== TEST TUGMALARI (inline) ======================
const adminOnly = (ctx) => {
  if (isAdmin(ctx.from.id)) return true;
  ctx.answerCbQuery('Siz admin emassiz');
  return false;
};

bot.action(/^tday:(\d)$/, async (ctx) => {
  if (!adminOnly(ctx) || !TEST_REJIMI) return;
  const day = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🧪 <b>${day}-sana xabari</b>\n\nKimga yuboramiz?\n\n⚠️ Test yuborilganda shu odamlarning bu oylik to'lov holati tozalanadi, shunda "To'lov qildim" tugmasini qayta sinash mumkin.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👥 Hammaga', `tto:all:${day}`)],
        [Markup.button.callback('👤 Bitta odamga (ID bilan)', `tto:one:${day}`)],
      ]),
    }
  ).catch(() => {});
});

bot.action(/^tto:(all|one):(\d)$/, async (ctx) => {
  if (!adminOnly(ctx) || !TEST_REJIMI) return;
  const mode = ctx.match[1];
  const day = Number(ctx.match[2]);
  await ctx.answerCbQuery();
  if (mode === 'one') {
    adminState[ctx.from.id] = { action: 'test_one', day };
    return ctx.editMessageText(`🧪 ${day}-sana xabari.\n\nIjarachining 5 xonali ID sini yozing:`).catch(() => {});
  }
  await ctx.editMessageText(`🧪 ${day}-sana xabari hammaga yuborilmoqda...`).catch(() => {});
  const r = await sendReminders(day, { test: true });
  await ctx.editMessageText(`🧪 ${day}-sana test xabari yuborildi.\n✅ Yetdi: ${r.ok}\n⚠️ Yetmadi: ${r.fail}`).catch(() => {});
  if (r.failed.length) await sendLongTo(ctx.from.id, unreachableText(r.failed)).catch(() => {});
  await reportGroup(ctx.from.id, await groupRemind(day, r.targets, true));
});

bot.action('reset_ok', async (ctx) => {
  if (!adminOnly(ctx) || !TEST_REJIMI) return;
  db = load();
  const m = monthKey();
  let n = 0;
  for (const k of Object.keys(db.payments)) {
    if (k.endsWith(`_${m}`)) { delete db.payments[k]; n++; }
  }
  save(db);
  await ctx.answerCbQuery('Tozalandi');
  await ctx.editMessageText(`♻️ ${monthName(m)} oyi to'lov holatlari tozalandi (${n} ta).`).catch(() => {});
});
bot.action('reset_no', async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery('Bekor qilindi');
  await ctx.editMessageText('Bekor qilindi.').catch(() => {});
});

// ====================== XABAR YUBORISH (tasdiq) ======================
bot.action('cast_ok', async (ctx) => {
  if (!adminOnly(ctx)) return;
  const st = adminState[ctx.from.id];
  if (!st || st.action !== 'cast_confirm') return ctx.answerCbQuery('Eskirgan so\'rov');
  delete adminState[ctx.from.id];
  db = load();
  await ctx.answerCbQuery('Yuborilmoqda...');
  await ctx.editMessageText('📢 Yuborilmoqda...').catch(() => {});
  let ok = 0, fail = 0;
  for (const t of Object.values(db.tenants)) {
    try { await bot.telegram.sendMessage(t.id, `📢 Admindan xabar:\n\n${st.text}`); ok++; }
    catch { fail++; }
    await sleep(100);
  }
  await ctx.editMessageText(`📢 Xabar yuborildi.\n✅ Yetdi: ${ok}\n⚠️ Xato: ${fail}`).catch(() => {});
});
bot.action('cast_no', async (ctx) => {
  if (!adminOnly(ctx)) return;
  delete adminState[ctx.from.id];
  await ctx.answerCbQuery('Bekor qilindi');
  await ctx.editMessageText('Bekor qilindi.').catch(() => {});
});

// ====================== "TO'LOV QILDIM" ======================
bot.action(/^pay:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  db = load();
  const t = db.tenants[id];
  if (!t) return ctx.answerCbQuery("Ma'lumot topilmadi");

  const month = monthKey();
  const key = payKey(id, month);
  if (db.payments[key] === 'accepted') return ctx.answerCbQuery('Allaqachon qabul qilingan');
  if (db.payments[key] === 'pending') return ctx.answerCbQuery('Admin tekshirmoqda, kuting');

  db.payments[key] = 'pending';
  save(db);

  await ctx.answerCbQuery('Adminga yuborildi');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply("⏳ So'rovingiz adminga yuborildi. Javobni kuting.");

  const card = adminCard(
    t, month,
    `💳 <b>TO'LOV SO'ROVI</b>  •  🏢 ${esc(t.bino)} bino`,
    `🕒 ${nowTashkent()}\n⏳ <b>Holat:</b> tekshirish kutilmoqda`
  );
  const kb = Markup.inlineKeyboard([[
    Markup.button.callback('✅ Qabul qilish', `ok:${id}:${month}`),
    Markup.button.callback('❌ Rad etish', `no:${id}:${month}`),
  ]]);
  for (const a of ADMIN_IDS) {
    bot.telegram.sendMessage(a, card, { parse_mode: 'HTML', ...kb }).catch(() => {});
  }
});

// ---------- Admin: qabul / rad ----------
async function adminDecision(ctx, accepted) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Siz admin emassiz');
  const id = Number(ctx.match[1]);
  const month = ctx.match[2];
  db = load();
  const t = db.tenants[id];
  if (!t) {
    await ctx.answerCbQuery('Ijarachi topilmadi (o\'chirilgan)');
    return ctx.editMessageReplyMarkup(undefined).catch(() => {});
  }

  const key = payKey(id, month);
  if (db.payments[key] !== 'pending') {
    await ctx.answerCbQuery("Bu so'rov allaqachon ko'rib chiqilgan");
    return ctx.editMessageReplyMarkup(undefined).catch(() => {});
  }

  db.payments[key] = accepted ? 'accepted' : 'rejected';
  save(db);

  const title = accepted
    ? `✅ <b>TO'LOV QABUL QILINDI</b>  •  🏢 ${esc(t.bino)} bino`
    : `❌ <b>TO'LOV RAD ETILDI</b>  •  🏢 ${esc(t.bino)} bino`;
  const status = `${accepted ? '✅ <b>Qabul qilindi</b>' : '❌ <b>Rad etildi</b>'} — ${esc(ctx.from.first_name)}\n🕒 ${nowTashkent()}`;
  await ctx.editMessageText(adminCard(t, month, title, status), { parse_mode: 'HTML' })
    .catch(() => {});
  await ctx.answerCbQuery(accepted ? 'Qabul qilindi' : 'Rad etildi');

  if (accepted) {
    bot.telegram.sendMessage(
      id,
      `✅ To'lovingiz qabul qilindi. Rahmat, ${t.ism}! Bu oy uchun boshqa eslatma yuborilmaydi.`
    ).catch(() => {});
  } else {
    bot.telegram.sendMessage(
      id,
      `❌ To'lovingiz rad etildi. Iltimos, admin bilan bog'laning.\n\nTo'lov qilgan bo'lsangiz, qayta tekshirtirish uchun pastdagi tugmani bosing.`,
      payBtn(id)
    ).catch(() => {});
  }
}

bot.action(/^ok:(\d+):(\d{4}-\d{2})$/, (ctx) => adminDecision(ctx, true));
bot.action(/^no:(\d+):(\d{4}-\d{2})$/, (ctx) => adminDecision(ctx, false));

// ---------- Ishga tushirish ----------
bot.catch((err) => console.error('Bot xatosi:', err));
bot.launch(() => console.log('Bot ishga tushdi'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
