require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  SETUP
 * ──────────────────────────────────────────────────────────────────────────────
 */

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.COINPAYMENTS_PUBLIC_KEY || !process.env.COINPAYMENTS_PRIVATE_KEY || !process.env.ADMIN_CHAT_ID) {
  console.error("FATAL ERROR: Missing required environment variables. Please check your .env file and ensure ADMIN_CHAT_ID is set.");
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const coinpayments = new CoinPayments({
  key: process.env.COINPAYMENTS_PUBLIC_KEY,
  secret: process.env.COINPAYMENTS_PRIVATE_KEY,
});

bot.setMyCommands([
  { command: 'start', description: '🚀 Start' },
  { command: 'help', description: '❓ Help' },
  { command: 'find', description: '🔍 Find order' },
  { command: 'referral', description: '🤝 Referral' },
  { command: 'language', description: '🌐 Language' },
  { command: 'admin', description: '🛠 Admin' },
]);

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  CONSTANTS
 * ──────────────────────────────────────────────────────────────────────────────
 */

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com';

const MIN_USD_EQ = 25;
const MAX_USD_EQ = 50000;

const COIN_NETWORK_MAP = {
  USDT: { TRC20: 'USDT.TRC20', ERC20: 'USDT.ERC20' },
  BTC:  { MAIN:  'BTC' },
  ETH:  { MAIN:  'ETH' }
};

const FIXED_USDT_USD = 1.12;
const FIXED_USDT_EUR = 0.98;
const FIXED_USDT_GBP = 0.86;

const REFERRAL_REWARD_USDT = 1.2;
const MIN_REFERRAL_WITHDRAWAL_USDT = 50;

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  IN-MEMORY (simple)
 * ──────────────────────────────────────────────────────────────────────────────
 */

let orderCounter = 1000;
const transactionRecords = {}; // #ORD -> transaction
const userStates = {};          // per-user state + settings
const referralData = {};        // referral balances etc.
const adminReplyMap = {};       // admin support replies

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  LIGHT I18N (EN default + DE/ZH/ES/RU/HI headings/buttons)
 * ──────────────────────────────────────────────────────────────────────────────
 */

const LANGS = [
  { code: 'en', label: '🇬🇧 English' },
  { code: 'de', label: '🇩🇪 Deutsch' },
  { code: 'zh', label: '🇨🇳 中文' },
  { code: 'es', label: '🇪🇸 Español' },
  { code: 'ru', label: '🇷🇺 Русский' },
  { code: 'hi', label: '🇮🇳 हिन्दी' },
];

const I18N = {
  en: {
    main_welcome: (name, dt) => `Hey *${name || 'there'}*! 👋

Welcome to your friendly crypto off-ramp.
Sell *BTC, ETH, or USDT* → receive *USD, EUR, or GBP* — fast and simple.

*It’s currently:* _${dt}_

Choose an option:`,
    btn_start_selling: '✅ Start selling',
    btn_about: 'ℹ️ About',
    btn_help: '📖 Guide',
    btn_find: '🔍 Find Transaction',
    btn_support: '💬 Contact Support',
    btn_language: '🌐 Language',
    btn_admin: '🛠 Admin',
    about_text: `🛡️ *About*

• Send only to your unique deposit address per order  
• Track with your *Order Number* (e.g., ORD1000123456)  
• Transparent quotes (BTC/ETH live, USDT fixed)  
• Human support if you need help`,
    guide_title: '📖 GUIDE (Quick)',
    guide_body: (min,max)=>`*1)* Tap *Start selling* → pick coin (BTC/ETH/USDT) → pick payout currency (USD/EUR/GBP)
*2)* Networks: USDT TRC20/ERC20; BTC/ETH mainnet
*3)* Enter amount → we estimate your payout (USDT fixed)
*4)* Choose payout method (Wise, Revolut, PayPal, Bank, etc.)
*5)* Confirm → get your deposit address
*6)* Send & keep your Order #
*Min:* $${min} • *Max:* $${max}`,
    find_prompt: '🔎 *Enter your order number* (e.g., ORD1000123456):',
    support_prompt: '💬 *Tell us what you need* in a single message.',
    menu: '🏠 Main Menu',
    back_menu: '⬅️ Back',
    rates_header: 'Rates (approx)',
    choose_coin: (rates)=>`What are you selling today? 😊\n\n${rates}`,
    coin_selected: (c)=>`✅ *${c}* selected.\n\nChoose payout currency:`,
    enter_amount_generic: (coin,net,min,max)=>`✅ ${coin}${net ? ' on '+net : ''}\n\nEnter the *amount of ${coin}* to sell.\n\n*Min:* $${min}\n*Max:* $${max}`,
    invalid_number: '❌ That doesn’t look like a valid number. Please enter a positive amount.',
    price_unavailable: (coin)=>`❌ Couldn’t fetch pricing for ${coin}. Please try again in a moment.`,
    out_of_range: (amt,coin,usd,min,max)=>`❌ Amount out of range.\nYour ${amt} ${coin} ≈ $${usd}.\nPlease enter $${min}–$${max}.`,
    approx_receive: (amt,coin,fiat,fiatAmt)=>`✅ *Amount:* ${amt} ${coin}\n\nYou’ll receive about *${fiatAmt} ${fiat}*.\n\nChoose payout method:`,
    payout_buttons: [
      ['Wise','Revolut'],
      ['PayPal','Bank Transfer'],
      ['Skrill/Neteller','Visa/Mastercard'],
      ['Payeer','Alipay'],
    ],
    choose_network: (c)=>`✅ *${c}* selected.\n\nPick network:`,
    bank_region: '✅ *Bank Transfer*\n\nChoose your bank’s region:',
    bank_eu_prompt: '✅ *EU Bank*\n\nReply:\n`Name:\nIBAN:\nSwift:`',
    bank_us_prompt: '✅ *US Bank*\n\nReply:\n`Account Holder:\nAccount #:\nRouting (ACH/ABA):`',
    wise_prompt: '✅ *Wise*\n\nYour Wise email or @tag:',
    revolut_prompt: '✅ *Revolut*\n\nYour @revolut tag:',
    paypal_prompt: '✅ *PayPal*\n\nYour PayPal email:',
    card_prompt: '✅ *Card*\n\nYour Visa/Mastercard number:',
    payeer_prompt: '✅ *Payeer*\n\nYour Payeer # (e.g., P12345678):',
    alipay_prompt: '✅ *Alipay*\n\nYour Alipay email:',
    skrill_or_neteller: '✅ *Skrill/Neteller*\n\nWhich one are you using?',
    payout_selected: (m)=>`✅ *${m}*\n\nPlease share your *${m}* email:`,
    review_summary_title: '📋 *REVIEW*',
    review_continue: '✅ Continue & Generate Address',
    review_edit: '✏️ Start Over',
    confirm_creating_addr: '🔐 Creating your deposit address…',
    address_ready: (order,txn,amount,coin,net,address,payout,details)=>`✅ *Deposit Address Ready!*\n\n*Order:* #${order}\n*Txn:* ${txn}\n\nSend exactly *${amount} ${coin}* (${net}) to:\n\`${address}\`\n\n*Payout:* ${payout}\n*Details:*\n\`${details}\`\n\n⚠️ Send only ${coin} on ${net}.`,
    refresh_rates: '🔄 Refresh rates',
    usd: 'USD', eur:'EUR', gbp:'GBP',
    pick_region_eu:'🇪🇺 European', pick_region_us:'🇺🇸 US',
    pick_skrill:'Skrill', pick_neteller:'Neteller',
    translator_title: '🌐 *Language*',
    choose_language: 'Choose your language:',
    language_set: (lbl)=>`✅ Language set to *${lbl}*.`,
    tx_found_title: '🔍 *Transaction Found*',
    tx_not_found: (ord)=>`❌ No transaction found with *${ord}*.`,
    try_again: '🔄 Try Again',
    start_over: 'No problem — send /start to begin again.',
    admin_only: '🚫 Admins only.',
    admin_dash: (u,t,p)=>`🛠 *Admin*\n• Users: *${u}*\n• Transactions: *${t}*\n• Pending: *${p}*`,
    admin_recent_btn: '🧾 Recent',
    admin_find_btn: '🔎 Find/Update Order',
    admin_back: '⬅️ Back',
    admin_recent_title: '🧾 *Recent (5)*',
    admin_find_prompt: '🔎 Send the order number (e.g., `ORD1000123456`).',
    admin_order_card: (t)=>`📦 *Order:* #${t.orderNumber}
*Status:* ${t.status}
*User:* \`${t.userId}\`
*Coin:* ${t.coin} (${t.network}) • *Amount:* ${t.amount}
*Payout:* ${t.fiat} via ${t.paymentMethod}
*Beneficiary:* ${t.payoutFirstName || ''} ${t.payoutLastName || ''}
*Details:* \`${t.paymentDetails}\`
*Txn ID:* ${t.coinpaymentsTxnId}
*Deposit:* \`${t.depositAddress}\`
*Date:* ${new Date(t.timestamp).toLocaleString()}`,
    admin_mark_paid: '✅ Mark Paid',
    admin_mark_completed: '🎉 Mark Completed',
    admin_mark_canceled: '🛑 Cancel',

    // NEW (names)
    payout_name_first_prompt: '✅ Beneficiary details\n\nPlease enter the *First Name* (as it appears on the payout account):',
    payout_name_last_prompt: 'Great — now enter the *Last Name*:',
  },
  de:{}, zh:{}, es:{}, ru:{}, hi:{},
};

// minimal label overrides (kept short)
Object.assign(I18N.de, { btn_start_selling:'✅ Verkauf starten', btn_help:'📖 Anleitung', btn_find:'🔍 Bestellung finden', btn_language:'🌐 Sprache', language_set:(l)=>`✅ Sprache: *${l}*.` });
Object.assign(I18N.zh, { btn_start_selling:'✅ 开始出售', btn_help:'📖 指南', btn_find:'🔍 查找订单', btn_language:'🌐 语言', language_set:(l)=>`✅ 语言: *${l}*。` });
Object.assign(I18N.es, { btn_start_selling:'✅ Empezar a vender', btn_help:'📖 Guía', btn_find:'🔍 Buscar pedido', btn_language:'🌐 Idioma', language_set:(l)=>`✅ Idioma: *${l}*.` });
Object.assign(I18N.ru, { btn_start_selling:'✅ Начать продажу', btn_help:'📖 Руководство', btn_find:'🔍 Найти заказ', btn_language:'🌐 Язык', language_set:(l)=>`✅ Язык: *${l}*.` });
Object.assign(I18N.hi, { btn_start_selling:'✅ बेचना शुरू करें', btn_help:'📖 गाइड', btn_find:'🔍 ऑर्डर ढूंढें', btn_language:'🌐 भाषा', language_set:(l)=>`✅ भाषा: *${l}*.` });

function ULang(chatId){ return (userStates[chatId]?.lang) || 'en'; }
function t(chatId, key, ...args) {
  const lang = ULang(chatId);
  const dict = I18N[lang] || I18N.en;
  const val = dict[key] ?? I18N.en[key];
  return (typeof val === 'function') ? val(...args) : (val || '');
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  RATES (live for BTC/ETH; fixed for USDT)
 * ──────────────────────────────────────────────────────────────────────────────
 */
let lastRates = null, lastRatesAt = 0;
const RATES_TTL_MS = 60 * 1000;

async function fetchLiveRates() {
  const now = Date.now();
  if (lastRates && (now - lastRatesAt) < RATES_TTL_MS) return lastRates;

  const raw = await coinpayments.rates({ short: 1 });
  const get = s => raw[s] && raw[s].rate_btc ? parseFloat(raw[s].rate_btc) : null;
  const rUSD = get('USD'), rEUR = get('EUR'), rGBP = get('GBP');
  if (!rUSD || !rEUR || !rGBP) throw new Error('Missing fiat anchors');

  const price = (symbol, fiatRateBTC) => {
    const v = get(symbol);
    return v ? (v / fiatRateBTC) : null;
  };

  lastRates = {
    USD: { BTC: price('BTC', rUSD), ETH: price('ETH', rUSD), USDT: FIXED_USDT_USD },
    EUR: { BTC: price('BTC', rEUR), ETH: price('ETH', rEUR), USDT: FIXED_USDT_EUR },
    GBP: { BTC: price('BTC', rGBP), ETH: price('ETH', rGBP), USDT: FIXED_USDT_GBP },
  };
  lastRatesAt = now;
  return lastRates;
}

async function calculateFiatLive(coin, amt, fiat) {
  if (coin === 'USDT') {
    if (fiat === 'USD') return amt * FIXED_USDT_USD;
    if (fiat === 'EUR') return amt * FIXED_USDT_EUR;
    if (fiat === 'GBP') return amt * FIXED_USDT_GBP;
  }
  const rates = await fetchLiveRates();
  const px = rates[fiat]?.[coin];
  return px ? amt * px : 0;
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  UTILITIES
 * ──────────────────────────────────────────────────────────────────────────────
 */
function getCurrentDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return `${date} - ${time}`;
}
function generateOrderNumber() {
  const timestamp = Date.now().toString().slice(-6);
  return `ORD${orderCounter++}${timestamp}`;
}
function storeTransactionRecord(orderNumber, transactionData) {
  transactionRecords[orderNumber] = {
    ...transactionData, orderNumber,
    timestamp: new Date().toISOString(), status: 'pending',
  };
}
function findTransactionByOrderNumber(orderNumber) {
  return transactionRecords[orderNumber];
}
function initializeReferralData(userId) {
  if (!referralData[userId]) {
    referralData[userId] = { referrerId: null, balance: 0, referredCount: 0, isReferralRewardClaimed: false };
  }
}
function rewardReferrer(referrerId, referredUserId) {
  if (referrerId && referralData[referrerId]) {
    referralData[referrerId].balance += REFERRAL_REWARD_USDT;
    referralData[referrerId].referredCount += 1;
    bot.sendMessage(referrerId, `🎉 *Referral Reward!* You earned *${REFERRAL_REWARD_USDT.toFixed(1)} USDT* from user \`${referredUserId}\`. New balance: *${referralData[referrerId].balance.toFixed(2)} USDT*.`, { parse_mode: 'Markdown' });
    return true;
  }
  return false;
}
function notifyAdminNewUser(userId, userInfo, referredBy = null) {
  const referralInfo = referredBy ? `\n*Referred by:* \`${referredBy}\`` : '';
  const msg = `🆕 *NEW USER*\n\n*User ID:* \`${userId}\`\n*User:* ${userInfo}\n*Join:* ${getCurrentDateTime()}${referralInfo}\n\nTotal users: ${Object.keys(referralData).length}`;
  bot.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: 'Markdown' });
}
function isAdmin(chatId) { return chatId.toString() === ADMIN_CHAT_ID.toString(); }

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  SIMPLE MENUS
 * ──────────────────────────────────────────────────────────────────────────────
 */
async function renderMainMenu(chatId) {
  const dt = getCurrentDateTime();
  const name = userStates[chatId]?.firstName || '';
  const text = I18N[ULang(chatId)].main_welcome(name, dt);
  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: t(chatId,'btn_start_selling'), callback_data: 'start_sell' }],
        [{ text: t(chatId,'btn_help'), callback_data: 'show_help' }, { text: t(chatId,'btn_about'), callback_data: 'show_about' }],
        [{ text: t(chatId,'btn_find'), callback_data: 'find_transaction' }, { text: t(chatId,'btn_language'), callback_data: 'language' }],
        [{ text: t(chatId,'btn_support'), callback_data: 'support_open' }],
        [{ text: t(chatId,'btn_admin'), callback_data: 'admin_menu' }],
      ]
    }
  });
}
async function renderAbout(chatId) {
  await bot.sendMessage(chatId, t(chatId,'about_text'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
}
async function renderHelp(chatId) {
  const body = I18N[ULang(chatId)].guide_body?.(MIN_USD_EQ, MAX_USD_EQ) || I18N.en.guide_body(MIN_USD_EQ, MAX_USD_EQ);
  await bot.sendMessage(chatId, `*${t(chatId,'guide_title')}*\n\n${body}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
}
async function renderFindTransactionPrompt(chatId) {
  userStates[chatId] = { ...(userStates[chatId] || {}), awaiting: 'order_number_search' };
  await bot.sendMessage(chatId, t(chatId,'find_prompt'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
}
async function renderSupportPrompt(chatId) {
  if (userStates[chatId]?.awaiting && userStates[chatId].awaiting !== 'support_message') {
    return bot.sendMessage(chatId, "⚠️ Finish your current step or send /start.", {
      reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
    });
  }
  userStates[chatId] = { ...(userStates[chatId] || {}), awaiting: 'support_message' };
  await bot.sendMessage(chatId, t(chatId,'support_prompt'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
}
async function renderLanguageMenu(chatId) {
  const rows = [
    LANGS.slice(0,3).map(l=>({ text:l.label, callback_data:`lang_${l.code}` })),
    LANGS.slice(3).map(l=>({ text:l.label, callback_data:`lang_${l.code}` })),
  ];
  await bot.sendMessage(chatId, `${t(chatId,'translator_title')}\n\n${t(chatId,'choose_language')}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [...rows, [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  ADMIN (simple)
 * ──────────────────────────────────────────────────────────────────────────────
 */
async function renderAdminMenu(chatId) {
  if (!isAdmin(chatId)) {
    return bot.sendMessage(chatId, t(chatId,'admin_only'), { parse_mode: 'Markdown' });
  }
  const totalUsers = Object.keys(referralData).length;
  const totalTx = Object.keys(transactionRecords).length;
  const pending = Object.values(transactionRecords).filter(t => t.status === 'pending').length;

  await bot.sendMessage(chatId, t(chatId,'admin_dash', totalUsers, totalTx, pending), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: t(chatId,'admin_recent_btn'), callback_data: 'admin_recent' }],
      [{ text: t(chatId,'admin_find_btn'), callback_data: 'admin_find' }],
      [{ text: t(chatId,'admin_back'), callback_data: 'menu' }],
    ] }
  });
}
function getRecentTransactions(limit = 5) {
  const list = Object.values(transactionRecords)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
  if (list.length === 0) return "_No transactions yet._";
  return list.map(t => `#${t.orderNumber} • ${t.coin}/${t.network} • ${t.amount} • ${t.fiat} • *${t.status}*\nID: \`${t.coinpaymentsTxnId}\` • ${new Date(t.timestamp).toLocaleString()}`).join('\n\n');
}
async function renderAdminRecent(chatId) {
  await bot.sendMessage(chatId, `${t(chatId,'admin_recent_title')}\n\n${getRecentTransactions(5)}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]] }
  });
}
async function renderAdminFindPrompt(chatId) {
  userStates[chatId] = { ...(userStates[chatId] || {}), awaiting: 'admin_find_order' };
  await bot.sendMessage(chatId, t(chatId,'admin_find_prompt'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]] }
  });
}
async function renderAdminOrderDetail(chatId, orderNumber) {
  const tnx = findTransactionByOrderNumber(orderNumber);
  if (!tnx) {
    return bot.sendMessage(chatId, `❌ Order *${orderNumber}* not found.`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_find_btn'), callback_data: 'admin_find' }],[{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]] }
    });
  }
  await bot.sendMessage(chatId, t(chatId,'admin_order_card', tnx), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: t(chatId,'admin_mark_paid'), callback_data: `admin_mark_paid:${tnx.orderNumber}` },
         { text: t(chatId,'admin_mark_completed'), callback_data: `admin_mark_completed:${tnx.orderNumber}` }],
        [{ text: t(chatId,'admin_mark_canceled'), callback_data: `admin_mark_canceled:${tnx.orderNumber}` }],
        [{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]
      ]
    }
  });
}
function updateOrderStatus(orderNumber, status) {
  const tnx = transactionRecords[orderNumber];
  if (!tnx) return false;
  tnx.status = status;
  return true;
}
async function notifyUserOrderUpdated(orderNumber) {
  const tnx = transactionRecords[orderNumber];
  if (!tnx) return;
  try {
    await bot.sendMessage(tnx.userId, `🔔 *Order Update*\n\n*Order:* #${tnx.orderNumber}\n*Status:* ${tnx.status}`, { parse_mode: 'Markdown' });
  } catch {}
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  START/COMMANDS
 * ──────────────────────────────────────────────────────────────────────────────
 */
bot.onText(/\/start\s?(\d+)?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const referredBy = match ? match[1] : null;
  const firstName = msg.from.first_name || '';
  const lastName = msg.from.last_name || '';
  const username = msg.from.username ? `@${msg.from.username}` : 'N/A';

  const isNewUser = !referralData[chatId];
  initializeReferralData(chatId);
  userStates[chatId] = { ...(userStates[chatId] || {}), firstName, lang: userStates[chatId]?.lang || 'en' };

  if (referredBy && referredBy !== chatId.toString()) {
    const referrerIdStr = referredBy.toString();
    if (referralData[referrerIdStr] && !referralData[chatId].referrerId) {
      referralData[chatId].referrerId = referrerIdStr;
      bot.sendMessage(chatId, `🤝 Referrer: \`${referrerIdStr}\`. They’ll be rewarded after your first transaction.`, { parse_mode: 'Markdown' });
    }
  }

  if (isNewUser) {
    const userInfo = `${firstName} ${lastName} (${username})`;
    notifyAdminNewUser(chatId, userInfo, referredBy);
  }

  await renderMainMenu(chatId);
});
bot.onText(/\/help/, async (msg) => renderHelp(msg.chat.id));
bot.onText(/\/find/, async (msg) => renderFindTransactionPrompt(msg.chat.id));
bot.onText(/\/support/, async (msg) => renderSupportPrompt(msg.chat.id));
bot.onText(/\/admin/, async (msg) => renderAdminMenu(msg.chat.id));
bot.onText(/\/language/, async (msg) => renderLanguageMenu(msg.chat.id));

bot.onText(/\/referral/, async (msg) => {
  const chatId = msg.chat.id;
  initializeReferralData(chatId);
  const { balance, referredCount } = referralData[chatId];

  let botUsername = 'Crypto_Seller_Bot';
  try { botUsername = (await bot.getMe()).username; } catch {}
  const referralLink = `https://t.me/${botUsername}?start=${chatId}`;

  const isReadyToWithdraw = balance >= MIN_REFERRAL_WITHDRAWAL_USDT;
  const missingAmount = MIN_REFERRAL_WITHDRAWAL_USDT - balance;

  const message = `
*🤝 Referral Program*

• *Your ID:* \`${chatId}\`
• *Your Link:* \`${referralLink}\`

• *Balance:* *${balance.toFixed(2)} USDT*
• *Successful Referrals:* *${referredCount}*
• *Reward per Referral:* *${REFERRAL_REWARD_USDT.toFixed(1)} USDT*

*Withdrawal Minimum:* ${MIN_REFERRAL_WITHDRAWAL_USDT} USDT
${isReadyToWithdraw ? "🎉 You're ready to withdraw (contact support)." : `Keep going — you need *${missingAmount.toFixed(2)} USDT* more to withdraw.`}
  `;
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  CALLBACKS
 * ──────────────────────────────────────────────────────────────────────────────
 */
bot.on('callback_query', async (cq) => {
  const chatId = cq.message.chat.id;
  const data = cq.data;

  if (!userStates[chatId]) userStates[chatId] = {};
  initializeReferralData(chatId);

  try {
    if (data === 'menu') return renderMainMenu(chatId);
    if (data === 'show_about') return renderAbout(chatId);
    if (data === 'show_help') return renderHelp(chatId);
    if (data === 'find_transaction') return renderFindTransactionPrompt(chatId);
    if (data === 'support_open') return renderSupportPrompt(chatId);

    if (data === 'language') return renderLanguageMenu(chatId);
    if (data.startsWith('lang_')) {
      const code = data.split('_')[1];
      if (LANGS.find(l=>l.code===code)) {
        userStates[chatId].lang = code;
        const label = LANGS.find(l=>l.code===code).label;
        await bot.sendMessage(chatId, t(chatId,'language_set', label), { parse_mode: 'Markdown' });
        return renderMainMenu(chatId);
      }
    }

    // Admin
    if (data === 'admin_menu') return renderAdminMenu(chatId);
    if (data === 'admin_recent') return renderAdminRecent(chatId);
    if (data === 'admin_find') return renderAdminFindPrompt(chatId);
    if (data.startsWith('admin_mark_')) {
      if (!isAdmin(chatId)) return;
      const [action, orderNumber] = data.split(':');
      let status = null;
      if (action === 'admin_mark_paid') status = 'paid';
      if (action === 'admin_mark_completed') status = 'completed';
      if (action === 'admin_mark_canceled') status = 'canceled';
      if (!status) return;
      const ok = updateOrderStatus(orderNumber, status);
      if (!ok) return bot.sendMessage(chatId, `❌ Could not update order *${orderNumber}*.`, { parse_mode: 'Markdown' });
      await notifyUserOrderUpdated(orderNumber);
      return renderAdminOrderDetail(chatId, orderNumber);
    }

    // Selling flow
    if (data === 'start_sell' || data === 'refresh_rates') {
      let pricesLine = '';
      try {
        const live = await fetchLiveRates();
        const pUSD = live.USD;
        const header = `*${t(chatId,'rates_header')}*`;
        pricesLine =
          `${header}\n` +
          `• 1 BTC ≈ $${(pUSD.BTC ?? 0).toFixed(2)}\n` +
          `• 1 ETH ≈ $${(pUSD.ETH ?? 0).toFixed(2)}\n` +
          `• 1 USDT = $${FIXED_USDT_USD.toFixed(2)} *(fixed)*\n` +
          `• 1 USDT = €${FIXED_USDT_EUR.toFixed(2)} *(fixed)*\n` +
          `• 1 USDT = £${FIXED_USDT_GBP.toFixed(2)} *(fixed)*`;
      } catch {
        pricesLine =
          `${t(chatId,'rates_header')}\n` +
          `• 1 USDT = $${FIXED_USDT_USD.toFixed(2)} *(fixed)*\n` +
          `• 1 USDT = €${FIXED_USDT_EUR.toFixed(2)} *(fixed)*\n` +
          `• 1 USDT = £${FIXED_USDT_GBP.toFixed(2)} *(fixed)*`;
      }

      await bot.sendMessage(chatId, t(chatId,'choose_coin', pricesLine), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: "₿ Bitcoin (BTC)", callback_data: 'coin_BTC' }, { text: "Ξ Ethereum (ETH)", callback_data: 'coin_ETH' }],
          [{ text: "💎 Tether (USDT)", callback_data: 'coin_USDT' }],
          [{ text: t(chatId,'refresh_rates'), callback_data: 'refresh_rates' }],
          [{ text: t(chatId,'back_menu'), callback_data: 'menu' }],
        ] }
      });
      return;
    }

    if (data.startsWith('coin_')) {
      const coin = data.split('_')[1];
      userStates[chatId].coin = coin;
      await bot.sendMessage(chatId, t(chatId,'coin_selected', coin), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: "🇺🇸 USD", callback_data: 'fiat_USD' }, { text: "🇪🇺 EUR", callback_data: 'fiat_EUR' }, { text: "🇬🇧 GBP", callback_data: 'fiat_GBP' }],
          [{ text: t(chatId,'back_menu'), callback_data: 'menu' }],
        ] }
      });
      return;
    }

    if (data.startsWith('fiat_')) {
      const currency = data.split('_')[1];
      userStates[chatId].fiat = currency;

      const c = userStates[chatId].coin || 'USDT';
      if (c === 'USDT') {
        return bot.sendMessage(chatId, t(chatId,'choose_network', c), {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: "TRC20 (Tron)", callback_data: 'net_TRC20' }],
            [{ text: "ERC20 (Ethereum)", callback_data: 'net_ERC20' }],
            [{ text: t(chatId,'back_menu'), callback_data: 'menu' }],
          ] }
        });
      } else {
        userStates[chatId].network = 'MAIN';
        userStates[chatId].awaiting = 'amount';
        return bot.sendMessage(chatId, t(chatId,'enter_amount_generic', c, 'MAIN', MIN_USD_EQ, MAX_USD_EQ), {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
        });
      }
    }

    if (data.startsWith('net_')) {
      const net = data.split('_')[1];
      userStates[chatId].network = net;
      userStates[chatId].awaiting = 'amount';
      const coin = userStates[chatId].coin || 'USDT';
      return bot.sendMessage(chatId, t(chatId,'enter_amount_generic', coin, net, MIN_USD_EQ, MAX_USD_EQ), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
    }

    // UPDATED: on payout method click, first collect beneficiary names
    if (data.startsWith('pay_')) {
      const method = data.split('_')[1]; // wise | revolut | paypal | bank | skrill | card | payeer | alipay
      userStates[chatId].paymentMethodChoice = method;
      userStates[chatId].awaiting = 'payout_first_name';
      return bot.sendMessage(chatId, t(chatId,'payout_name_first_prompt'), { parse_mode: 'Markdown' });
    }

    if (data.startsWith('payout_')) {
      // Happens after we asked Skrill/Neteller choice (post-name collection)
      const method = data.split('_')[1];
      const name = method.charAt(0).toUpperCase() + method.slice(1);
      userStates[chatId].paymentMethod = name;
      userStates[chatId].awaiting = 'skrill_neteller_details';
      return bot.sendMessage(chatId, t(chatId,'payout_selected', name), { parse_mode: 'Markdown' });
    }

    if (data.startsWith('bank_')) {
      const region = data.split('_')[1];
      userStates[chatId].paymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
      if (region === 'eu') {
        userStates[chatId].awaiting = 'bank_details_eu';
        return bot.sendMessage(chatId, t(chatId,'bank_eu_prompt'), { parse_mode: 'Markdown' });
      } else {
        userStates[chatId].awaiting = 'bank_details_us';
        return bot.sendMessage(chatId, t(chatId,'bank_us_prompt'), { parse_mode: 'Markdown' });
      }
    }

    if (data === 'confirm_transaction') {
      await bot.sendMessage(chatId, t(chatId,'confirm_creating_addr'), { parse_mode: 'Markdown' });
      return generateDepositAddress(chatId);
    }

    if (data === 'edit_transaction') {
      delete userStates[chatId];
      return bot.sendMessage(chatId, t(chatId,'start_over'), { parse_mode: 'Markdown' });
    }

  } finally {
    bot.answerCallbackQuery(cq.id).catch(()=>{});
  }
});

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  COINPAYMENTS ADDRESS
 * ──────────────────────────────────────────────────────────────────────────────
 */
async function generateDepositAddress(chatId) {
  const state = userStates[chatId];
  try {
    const coin = state.coin || 'USDT';
    const net = state.network || 'MAIN';

    let coinCurrency;
    if (coin === 'USDT') coinCurrency = COIN_NETWORK_MAP.USDT[net];
    else if (coin === 'BTC') coinCurrency = COIN_NETWORK_MAP.BTC.MAIN;
    else if (coin === 'ETH') coinCurrency = COIN_NETWORK_MAP.ETH.MAIN;
    if (!coinCurrency) throw new Error(`Unsupported coin/network: ${coin} ${net}`);

    const paymentMethodForCustom = state.paymentMethod || 'Unknown';
    const orderNumber = generateOrderNumber();
    const beneficiaryFullName = `${state.payoutFirstName || ''} ${state.payoutLastName || ''}`.trim();

    const transactionOptions = {
      currency1: coin,
      currency2: coinCurrency,
      amount: state.amount,
      buyer_email: BUYER_REFUND_EMAIL,
      custom: `Order: ${orderNumber} | ${coin}/${net} | Beneficiary: ${beneficiaryFullName} | Payout to ${paymentMethodForCustom}: ${state.paymentDetails}`,
      item_name: `Sell ${state.amount} ${coin} for ${state.fiat}`,
      ipn_url: 'YOUR_IPN_WEBHOOK_URL'
    };

    const result = await coinpayments.createTransaction(transactionOptions);

    storeTransactionRecord(orderNumber, {
      userId: chatId,
      amount: state.amount,
      fiat: state.fiat,
      network: state.network,
      coin,
      paymentMethod: paymentMethodForCustom,
      paymentDetails: state.paymentDetails,
      payoutFirstName: state.payoutFirstName || '',
      payoutLastName: state.payoutLastName || '',
      coinpaymentsTxnId: result.txn_id,
      depositAddress: result.address,
      timestamp: new Date().toISOString()
    });

    const referrerId = referralData[chatId]?.referrerId;
    if (referrerId && !referralData[chatId].isReferralRewardClaimed) {
      rewardReferrer(referrerId, chatId);
      referralData[chatId].isReferralRewardClaimed = true;
    }

    await bot.sendMessage(
      chatId,
      I18N[ULang(chatId)].address_ready(
        orderNumber, result.txn_id, result.amount, coin, net, result.address,
        paymentMethodForCustom, state.paymentDetails
      ) + `\n\n*Beneficiary:* ${beneficiaryFullName}`,
      { parse_mode: 'Markdown' }
    );
    delete userStates[chatId];

  } catch (error) {
    console.error("CoinPayments API Error:", error);
    await bot.sendMessage(chatId, "❌ Error creating deposit address. Please try again or contact /support.");
  }
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  MESSAGE HANDLER
 * ──────────────────────────────────────────────────────────────────────────────
 */
const nameOk = s => /^[\p{L}\p{M}'.\-\s]{2,}$/u.test((s||'').trim());

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const st = userStates[chatId] || {};
  initializeReferralData(chatId);

  // Admin reply to support thread
  if (msg.reply_to_message && chatId.toString() === ADMIN_CHAT_ID) {
    const forwardedMessageId = msg.reply_to_message.message_id;
    const originalUserChatId = adminReplyMap[forwardedMessageId];
    if (originalUserChatId) {
      try {
        await bot.sendMessage(originalUserChatId, `📢 *Support Reply*\n\n${text}`, { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, "✅ Reply sent.");
        delete adminReplyMap[forwardedMessageId];
      } catch {
        await bot.sendMessage(chatId, "❌ Couldn’t deliver reply. The user may have blocked the bot.");
      }
    }
    return;
  }

  // Ignore slash-commands (handled elsewhere)
  if (text.startsWith('/')) return;

  // Support
  if (st.awaiting === 'support_message') {
    const supportText = text;
    const userInfo = `User ID: ${msg.from.id}, Name: ${msg.from.first_name || ''} ${msg.from.last_name || ''}, Username: @${msg.from.username || 'N/A'}`;
    const forwarded = `*🚨 NEW SUPPORT REQUEST*\n\nFrom: ${userInfo}\n\n*Message:* \n${supportText}\n\n--- \n_Reply to this message to respond to the user._`;
    try {
      const sent = await bot.sendMessage(ADMIN_CHAT_ID, forwarded, { parse_mode: 'Markdown' });
      adminReplyMap[sent.message_id] = chatId;
      await bot.sendMessage(chatId, "✅ Thanks! Support will reply here shortly.");
      delete userStates[chatId];
    } catch {
      await bot.sendMessage(chatId, "❌ Sorry, we couldn’t reach support right now. Please try again later.");
    }
    return;
  }

  // Admin — find order (text)
  if (st.awaiting === 'admin_find_order' && isAdmin(chatId)) {
    userStates[chatId].awaiting = null;
    const orderNumber = text.trim().toUpperCase();
    return renderAdminOrderDetail(chatId, orderNumber);
  }

  // User — find order
  if (st.awaiting === 'order_number_search') {
    const ord = text.trim().toUpperCase();
    const tnx = findTransactionByOrderNumber(ord);
    if (tnx) {
      const info = `
${t(chatId,'tx_found_title')}

*Order:* #${tnx.orderNumber}
*Txn:* ${tnx.coinpaymentsTxnId}
*Coin:* ${tnx.coin}
*Amount:* ${tnx.amount} ${tnx.coin}
*Network:* ${tnx.network}
*Currency:* ${tnx.fiat}
*Payment:* ${tnx.paymentMethod}
*Beneficiary:* ${tnx.payoutFirstName || ''} ${tnx.payoutLastName || ''}
*Status:* ${tnx.status}
*Date:* ${new Date(tnx.timestamp).toLocaleString()}
*Deposit:* \`${tnx.depositAddress}\`
      `;
      await bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, t(chatId,'tx_not_found', ord), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'try_again'), callback_data: 'find_transaction' }]] }
      });
    }
    delete userStates[chatId];
    return;
  }

  // NEW — Beneficiary Name collection
  if (st.awaiting === 'payout_first_name') {
    const first = (text || '').trim();
    if (!nameOk(first)) return bot.sendMessage(chatId, '❌ Please enter a valid first name (letters, spaces, -.\').');
    userStates[chatId].payoutFirstName = first;
    userStates[chatId].awaiting = 'payout_last_name';
    return bot.sendMessage(chatId, t(chatId,'payout_name_last_prompt'), { parse_mode: 'Markdown' });
  }

  if (st.awaiting === 'payout_last_name') {
    const last = (text || '').trim();
    if (!nameOk(last)) return bot.sendMessage(chatId, '❌ Please enter a valid last name (letters, spaces, -.\').');
    userStates[chatId].payoutLastName = last;
    userStates[chatId].awaiting = null;

    const method = userStates[chatId].paymentMethodChoice;

    switch (method) {
      case 'wise':
        userStates[chatId].paymentMethod = 'Wise';
        userStates[chatId].awaiting = 'wise_details';
        return bot.sendMessage(chatId, t(chatId,'wise_prompt'), { parse_mode: 'Markdown' });

      case 'revolut':
        userStates[chatId].paymentMethod = 'Revolut';
        userStates[chatId].awaiting = 'revolut_details';
        return bot.sendMessage(chatId, t(chatId,'revolut_prompt'), { parse_mode: 'Markdown' });

      case 'paypal':
        userStates[chatId].paymentMethod = 'PayPal';
        userStates[chatId].awaiting = 'paypal_details';
        return bot.sendMessage(chatId, t(chatId,'paypal_prompt'), { parse_mode: 'Markdown' });

      case 'card':
        userStates[chatId].paymentMethod = 'Card';
        userStates[chatId].awaiting = 'card_details';
        return bot.sendMessage(chatId, t(chatId,'card_prompt'), { parse_mode: 'Markdown' });

      case 'payeer':
        userStates[chatId].paymentMethod = 'Payeer';
        userStates[chatId].awaiting = 'payeer_details';
        return bot.sendMessage(chatId, t(chatId,'payeer_prompt'), { parse_mode: 'Markdown' });

      case 'alipay':
        userStates[chatId].paymentMethod = 'Alipay';
        userStates[chatId].awaiting = 'alipay_details';
        return bot.sendMessage(chatId, t(chatId,'alipay_prompt'), { parse_mode: 'Markdown' });

      case 'skrill':
        // Ask user to pick between Skrill and Neteller, then proceed
        return bot.sendMessage(chatId, t(chatId,'skrill_or_neteller'), {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: t(chatId,'pick_skrill'), callback_data: 'payout_skrill' }],
            [{ text: t(chatId,'pick_neteller'), callback_data: 'payout_neteller' }],
            [{ text: t(chatId,'back_menu'), callback_data: 'menu' }],
          ] }
        });

      case 'bank':
        // Ask region now that we have names
        return bot.sendMessage(chatId, t(chatId,'bank_region'), {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: t(chatId,'pick_region_eu'), callback_data: 'bank_eu' }],
            [{ text: t(chatId,'pick_region_us'), callback_data: 'bank_us' }],
            [{ text: t(chatId,'back_menu'), callback_data: 'menu' }],
          ] }
        });

      default:
        return bot.sendMessage(chatId, '❌ Unknown payout method. Send /start to begin again.');
    }
  }

  // User — amount entry
  if (st.awaiting === 'amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, t(chatId,'invalid_number'));
    }
    const coin = st.coin || 'USDT';

    let usdValue = 0;
    try {
      if (coin === 'USDT') usdValue = amount * FIXED_USDT_USD;
      else {
        const liveUSD = (await fetchLiveRates()).USD;
        const px = liveUSD[coin];
        usdValue = px ? amount * px : 0;
      }
    } catch {}

    if (!usdValue) return bot.sendMessage(chatId, t(chatId,'price_unavailable', coin));
    if (usdValue < MIN_USD_EQ || usdValue > MAX_USD_EQ) {
      return bot.sendMessage(chatId, t(chatId,'out_of_range', amount, coin, usdValue.toFixed(2), MIN_USD_EQ, MAX_USD_EQ), { parse_mode: 'Markdown' });
    }

    userStates[chatId].amount = amount;

    const fiatToReceive = await calculateFiatLive(coin, amount, st.fiat || 'USD');
    await bot.sendMessage(chatId, t(chatId,'approx_receive', amount, coin, st.fiat, fiatToReceive.toFixed(2)), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "Wise", callback_data: 'pay_wise' }, { text: "Revolut", callback_data: 'pay_revolut' }],
          [{ text: "PayPal", callback_data: 'pay_paypal' }, { text: "Bank Transfer", callback_data: 'pay_bank' }],
          [{ text: "Skrill/Neteller", callback_data: 'pay_skrill' }, { text: "Visa/Mastercard", callback_data: 'pay_card' }],
          [{ text: "Payeer", callback_data: 'pay_payeer' }, { text: "Alipay", callback_data: 'pay_alipay' }],
          [{ text: t(chatId,'back_menu'), callback_data: 'menu' }],
        ]
      }
    });
    userStates[chatId].awaiting = null;
    return;
  }

  // Collect payout details (after names)
  if ([
    'wise_details','revolut_details','paypal_details','card_details',
    'payeer_details','alipay_details','skrill_neteller_details',
    'bank_details_eu','bank_details_us'
  ].includes(st.awaiting)) {
    userStates[chatId].paymentDetails = text;
    userStates[chatId].awaiting = null;

    const previewOrder = generateOrderNumber(); // preview only; actual generated on address creation
    const fiatToReceive = await calculateFiatLive(userStates[chatId].coin || 'USDT', userStates[chatId].amount, userStates[chatId].fiat);

    await bot.sendMessage(chatId, `${t(chatId,'review_summary_title')}

*Order # (preview):* #${previewOrder}

*Selling:* ${userStates[chatId].amount} ${userStates[chatId].coin || 'USDT'}
*Network:* ${userStates[chatId].network}
*Currency to Receive:* ${userStates[chatId].fiat}
*Amount to Receive (current):* ${fiatToReceive.toFixed(2)} ${userStates[chatId].fiat}
*Payment Method:* ${userStates[chatId].paymentMethod}
*Beneficiary Name:* ${userStates[chatId].payoutFirstName} ${userStates[chatId].payoutLastName}
*Payment Details:*
\`${userStates[chatId].paymentDetails}\``, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: t(chatId,'review_continue'), callback_data: 'confirm_transaction' }],
        [{ text: t(chatId,'review_edit'), callback_data: 'edit_transaction' }],
        [{ text: t(chatId,'back_menu'), callback_data: 'menu' }],
      ] }
    });
    return;
  }
});

console.log("Simple bot is running…");
