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

// Optional (recommended later)
const BOT_PUBLIC_URL = process.env.BOT_PUBLIC_URL || 'https://YOUR_DOMAIN'; // for IPN/webhook
const IPN_SECRET = process.env.IPN_SECRET || 'CHANGE_ME';

bot.setMyCommands([
  { command: 'start', description: '🚀 Start' },
  { command: 'help', description: '❓ Help' },
  { command: 'find', description: '🔍 Find order' },
  { command: 'referral', description: '🤝 Referral' },
  { command: 'language', description: '🌐 Language' },
  { command: 'admin', description: '🛠 Admin' },
  { command: 'p2p', description: '🧑‍🤝‍🧑 P2P Market' },
  { command: 'offers', description: '🗂 Browse P2P Offers' },
  { command: 'trades', description: '📑 My P2P Trades' },
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

const SUPPORTED_COINS = ['USDT','BTC','ETH'];
const SUPPORTED_FIAT  = ['USD','EUR','GBP'];
const P2P_PAYMENT_METHODS = ['Wise','Revolut','PayPal','Bank (EU)','Bank (US)','Skrill','Neteller','Card','Payeer','Alipay'];

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  IN-MEMORY (simple)
 * ──────────────────────────────────────────────────────────────────────────────
 */

let orderCounter = 1000;
const transactionRecords = {}; // #ORD -> off-ramp transactions (your original flow)
const userStates = {};          // per-user state + settings
const referralData = {};        // referral balances etc.
const adminReplyMap = {};       // admin support replies

// P2P
let offerSeq = 1, tradeSeq = 1;
const p2pOffers = {};  // offerId -> offer
const p2pTrades = {};  // tradeId -> trade
const reputation = {}; // userId -> {stars: number (avg), completed: number}

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
*Details:* \`${t.paymentDetails}\`
*Txn ID:* ${t.coinpaymentsTxnId}
*Deposit:* \`${t.depositAddress}\`
*Date:* ${new Date(t.timestamp).toLocaleString()}`,
    admin_mark_paid: '✅ Mark Paid',
    admin_mark_completed: '🎉 Mark Completed',
    admin_mark_canceled: '🛑 Cancel',

    // P2P
    p2p_title: '🧑‍🤝‍🧑 *P2P Marketplace*',
    p2p_menu_hint: 'Create & browse offers, start trades with escrow address, and build reputation.',
    p2p_browse: '🗂 Browse Offers',
    p2p_create: '➕ Create Offer',
    p2p_mine: '🧾 My Offers',
    p2p_trades: '📑 My Trades',
    p2p_back: '⬅️ Back',
    p2p_offer_created: (id)=>`✅ Offer *#${id}* created and is now *active*.`,
    p2p_offer_archived: (id)=>`🗄 Offer *#${id}* archived.`,
    p2p_offer_relisted: (id)=>`📢 Offer *#${id}* re-listed.`,
    p2p_no_offers: '_No offers match your filters._',
    p2p_no_mine: '_You have no active offers._',
    p2p_no_trades: '_You have no trades yet._',
    p2p_offer_card: (o,ownerRep)=>`📌 *Offer #${o.id}* — ${o.side === 'BUY' ? 'Buys' : 'Sells'} *${o.coin}* for *${o.fiat}*
• Owner: \`${o.ownerId}\` ${ownerRep}
• Network: ${o.network}
• Price: ${o.pricing.type === 'fixed' ? `${o.pricing.value} ${o.fiat}/${o.coin}` : `market ±${o.pricing.margin}%`}
• Limits: ${o.minUsd}-${o.maxUsd} ${o.fiat}
• Methods: ${o.methods.join(', ')}
• Terms: ${o.terms || '_none_'}
• Status: ${o.active ? '🟢 active' : '⚪ archived'}`,
    p2p_view_offer: '👀 View',
    p2p_start_trade: '🤝 Start Trade',
    p2p_archive: '🗄 Archive',
    p2p_relist: '📢 Relist',
    p2p_cancel_trade: '🛑 Cancel',
    p2p_paid_fiat: '💵 Mark “Fiat Paid”',
    p2p_confirm_received: '✅ Confirm Received',
    p2p_open_dispute: '⚠️ Dispute',
    p2p_release_escrow: '🔓 Release Escrow',
    p2p_trade_card: (t)=>`🔐 *Trade #${t.id}* — Offer #${t.offerId}
• ${t.side === 'BUY' ? 'Buyer' : 'Seller'}: \`${t.buyerId}\` / \`${t.sellerId}\`
• Asset: ${t.coin} (${t.network})
• Amount: ${t.amountCoin} ${t.coin}
• Fiat: ${t.fiat} at ${t.pricePerCoin} ${t.fiat}/${t.coin}
• Status: *${t.status}*
${t.depositAddress ? `• Escrow Address: \`${t.depositAddress}\`` : '' }
${t.dispute ? `• Dispute: ${t.dispute}` : '' }`,
    p2p_trade_next: '➡️ Next',
    p2p_trade_prev: '⬅️ Prev',
    p2p_need_amount: 'Enter amount of coin you want to trade (e.g., 0.5):',
    p2p_bad_amount: '❌ Invalid amount.',
    p2p_out_of_limits: (min,max,fiat)=>`❌ Trade outside limits. Allowed: ${min}-${max} ${fiat}.`,
    p2p_generating_addr: '🔐 Generating escrow deposit address…',
    p2p_addr_ready: (addr,amt,coin)=>`✅ Escrow address ready.\nSend *${amt} ${coin}* to:\n\`${addr}\`\n\nWhen the *fiat is paid*, press “💵 Mark Fiat Paid”.`,
    p2p_mark_paid_note: 'Got it. Waiting for counterparty to confirm receipt.',
    p2p_confirm_note: 'Thanks. Admin will release escrow after checks.',
    p2p_dispute_note: 'Dispute opened. Admin will review.',
    p2p_canceled: 'Trade canceled.',
    p2p_admin_trade_tools: '🛠 *Admin — Trade Tools*',
    p2p_admin_mark_escrow_rcv: '✅ Mark Escrow Received',
    p2p_admin_release: '🔓 Release to Seller',
    p2p_admin_cancel: '🛑 Cancel Trade',
    p2p_admin_note: 'Use these once you verify on CoinPayments dashboard.',
    p2p_left_star: (n)=>`⭐ Thanks! You rated ${n} star(s).`,
  },
  de:{}, zh:{}, es:{}, ru:{}, hi:{},
};

// minimal label overrides
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

async function pricePerCoin(coin, fiat, pricing) {
  // pricing: {type:'fixed'| 'margin', value: number} or {type:'margin', margin: +/-%}
  if (pricing.type === 'fixed') return pricing.value;
  const rates = await fetchLiveRates();
  const base = rates[fiat]?.[coin] || 0;
  const margin = pricing.margin || 0;
  return +(base * (1 + margin/100)).toFixed(2);
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

// Reputation helpers
function getRepBadge(userId) {
  const r = reputation[userId];
  if (!r) return '(new)';
  const stars = '⭐'.repeat(Math.round(r.stars || 0)) || '⭐';
  return `${stars} (${r.completed || 0})`;
}
function updateRep(afterTradeUserId, stars) {
  const r = reputation[afterTradeUserId] || {stars:0, completed:0};
  const total = (r.stars * r.completed) + stars;
  const completed = r.completed + 1;
  reputation[afterTradeUserId] = { stars: +(total/completed).toFixed(2), completed };
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  SIMPLE MENUS (your original)
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
        [{ text: '🧑‍🤝‍🧑 P2P Market', callback_data: 'p2p_menu' }],
        [{ text: t(chatId,'btn_help'), callback_data: 'show_help' }, { text: t(chatId,'btn_about'), callback_data: 'show_about' }],
        [{ text: t(chatId,'btn_find'), callback_data: 'find_transaction' }, { text: t(chatId,'btn_language'), callback_data: 'language' }],
        [{ text: t(chatId,'btn_support'), callback_data: 'support_open' }],
        [{ text: t(chatId,'btn_admin'), callback_data: 'admin_menu' }],
      ]
    }
  });
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  ADMIN (your original)
 * ──────────────────────────────────────────────────────────────────────────────
 */
// ... (unchanged admin flows from your original; kept below in callbacks)

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  P2P MARKET — Core
 * ──────────────────────────────────────────────────────────────────────────────
 */

function newOfferId(){ return offerSeq++; }
function newTradeId(){ return tradeSeq++; }

function buildOffer(ownerId, payload) {
  const id = newOfferId();
  const offer = {
    id,
    ownerId,
    side: payload.side, // 'BUY' (buys crypto, pays fiat) or 'SELL' (sells crypto, receives fiat)
    coin: payload.coin,
    network: payload.network,
    fiat: payload.fiat,
    pricing: payload.pricing, // {type:'fixed', value} or {type:'margin', margin}
    minUsd: payload.minUsd,
    maxUsd: payload.maxUsd,
    methods: payload.methods,
    terms: payload.terms || '',
    active: true,
    createdAt: Date.now()
  };
  p2pOffers[id] = offer;
  return offer;
}

function listOffers(filter = {}) {
  return Object.values(p2pOffers).filter(o=>{
    if (!o.active) return false;
    if (filter.side && o.side !== filter.side) return false;
    if (filter.coin && o.coin !== filter.coin) return false;
    if (filter.fiat && o.fiat !== filter.fiat) return false;
    return true;
  }).sort((a,b)=>b.createdAt - a.createdAt);
}

function offerCardText(chatId, o) {
  const rep = getRepBadge(o.ownerId);
  return t(chatId, 'p2p_offer_card', o, rep);
}

async function renderP2PMenu(chatId) {
  await bot.sendMessage(chatId, `${t(chatId,'p2p_title')}\n\n${t(chatId,'p2p_menu_hint')}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: t(chatId,'p2p_browse'), callback_data: 'p2p_browse' }],
      [{ text: t(chatId,'p2p_create'), callback_data: 'p2p_create' }],
      [{ text: t(chatId,'p2p_mine'), callback_data: 'p2p_mine' }],
      [{ text: t(chatId,'p2p_trades'), callback_data: 'p2p_trades' }],
      [{ text: t(chatId,'p2p_back'), callback_data: 'menu' }],
    ] }
  });
}

async function renderOffersList(chatId, filter = {}) {
  const list = listOffers(filter);
  if (list.length === 0) {
    return bot.sendMessage(chatId, t(chatId,'p2p_no_offers'), { parse_mode: 'Markdown' });
  }
  for (const o of list.slice(0, 10)) {
    await bot.sendMessage(chatId, offerCardText(chatId,o), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: t(chatId,'p2p_view_offer'), callback_data: `offer_view:${o.id}` },
         { text: t(chatId,'p2p_start_trade'), callback_data: `offer_start:${o.id}` }],
        ...(o.ownerId === chatId ? [[
          { text: t(chatId,'p2p_archive'), callback_data: `offer_archive:${o.id}` },
          { text: t(chatId,'p2p_relist'), callback_data: `offer_relist:${o.id}` },
        ]] : [])
      ] }
    });
  }
}

async function renderMyOffers(chatId) {
  const mine = Object.values(p2pOffers).filter(o=>o.ownerId===chatId);
  if (mine.length === 0) return bot.sendMessage(chatId, t(chatId,'p2p_no_mine'), { parse_mode: 'Markdown' });
  for (const o of mine) {
    await bot.sendMessage(chatId, offerCardText(chatId,o), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: t(chatId,'p2p_view_offer'), callback_data: `offer_view:${o.id}` }],
        [{ text: o.active ? t(chatId,'p2p_archive') : t(chatId,'p2p_relist'), callback_data: o.active?`offer_archive:${o.id}`:`offer_relist:${o.id}` }],
      ] }
    });
  }
}

function buildTradeFromOffer(offer, starterUserId, amountCoin, pricePer, fiatTotal) {
  const id = newTradeId();
  const side = (offer.side === 'BUY')
    ? 'SELLER_IS_STARTER' // starter is selling coin, buyer is offer owner
    : 'BUYER_IS_STARTER'; // starter is buying coin, seller is offer owner

  const trade = {
    id,
    offerId: offer.id,
    side: (offer.side === 'BUY') ? 'SELL' : 'BUY', // perspective of starter
    buyerId: (offer.side === 'BUY') ? offer.ownerId : starterUserId,
    sellerId: (offer.side === 'BUY') ? starterUserId : offer.ownerId,
    coin: offer.coin,
    network: offer.network,
    fiat: offer.fiat,
    pricePerCoin: pricePer,
    amountCoin,
    fiatTotal,
    methods: offer.methods,
    terms: offer.terms,
    depositAddress: null,
    coinpaymentsTxnId: null,
    status: 'await_deposit', // await deposit to escrow address
    createdAt: Date.now(),
    dispute: null,
  };
  p2pTrades[id] = trade;
  return trade;
}

function tradeCardText(chatId, tr) {
  return t(chatId,'p2p_trade_card', tr);
}

async function renderTrade(chatId, tradeId, asAdmin=false) {
  const tr = p2pTrades[tradeId];
  if (!tr) return;
  const buttons = [];

  // User buttons
  if (!asAdmin) {
    if (tr.status === 'await_deposit' && chatId === tr.buyerId) {
      // buyer waits to receive escrow? (In our P2P, starter sends coin to escrow)
    }
    if (tr.status === 'await_deposit' && chatId === tr.sellerId) {
      // seller is the one who will receive after fiat confirmation
    }
    if (tr.depositAddress) {
      if (chatId === tr.buyerId) buttons.push([{ text: t(chatId,'p2p_paid_fiat'), callback_data: `trade_paid:${tr.id}` }]);
      if (chatId === tr.sellerId) buttons.push([{ text: t(chatId,'p2p_confirm_received'), callback_data: `trade_confirm:${tr.id}` }]);
    }
    buttons.push([{ text: t(chatId,'p2p_open_dispute'), callback_data: `trade_dispute:${tr.id}` },
                  { text: t(chatId,'p2p_cancel_trade'), callback_data: `trade_cancel:${tr.id}` }]);
  }

  // Admin tools
  if (asAdmin) {
    buttons.push([{ text: t(chatId,'p2p_admin_mark_escrow_rcv'), callback_data: `admin_trade_escrow:${tr.id}` }]);
    buttons.push([{ text: t(chatId,'p2p_admin_release'), callback_data: `admin_trade_release:${tr.id}` },
                  { text: t(chatId,'p2p_admin_cancel'), callback_data: `admin_trade_cancel:${tr.id}` }]);
  }

  await bot.sendMessage(chatId, tradeCardText(chatId,tr), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function createEscrowAddressForTrade(chatId, tr) {
  // For escrow, we generate a CoinPayments transaction address with exact amount
  try {
    await bot.sendMessage(chatId, t(chatId,'p2p_generating_addr'), { parse_mode: 'Markdown' });

    let currency2;
    if (tr.coin === 'USDT') currency2 = COIN_NETWORK_MAP.USDT[tr.network];
    else if (tr.coin === 'BTC') currency2 = COIN_NETWORK_MAP.BTC.MAIN;
    else if (tr.coin === 'ETH') currency2 = COIN_NETWORK_MAP.ETH.MAIN;

    const res = await coinpayments.createTransaction({
      currency1: tr.coin,
      currency2,
      amount: tr.amountCoin,
      buyer_email: BUYER_REFUND_EMAIL,
      custom: `P2P Trade #${tr.id} | Offer #${tr.offerId} | ${tr.coin}/${tr.network}`,
      item_name: `P2P Escrow for Trade #${tr.id}`,
      ipn_url: `${BOT_PUBLIC_URL}/coinpayments/ipn` // wire later if you want auto-detect
    });

    tr.coinpaymentsTxnId = res.txn_id;
    tr.depositAddress   = res.address;

    await bot.sendMessage(tr.buyerId, t(chatId,'p2p_addr_ready', tr.depositAddress, tr.amountCoin, tr.coin), { parse_mode: 'Markdown' });
    if (tr.sellerId !== tr.buyerId) {
      await bot.sendMessage(tr.sellerId, `🔐 Trade #${tr.id}: Escrow address created.\nBuyer will deposit *${tr.amountCoin} ${tr.coin}* to escrow.`, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    console.error('Escrow address error:', e);
    await bot.sendMessage(chatId, '❌ Failed to create escrow address. Try later.');
  }
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

// P2P shortcuts
bot.onText(/\/p2p/, async (msg)=> renderP2PMenu(msg.chat.id));
bot.onText(/\/offers/, async (msg)=> renderOffersList(msg.chat.id, {}));
bot.onText(/\/trades/, async (msg)=> {
  const mine = Object.values(p2pTrades).filter(tr=> tr.buyerId===msg.chat.id || tr.sellerId===msg.chat.id);
  if (mine.length === 0) return bot.sendMessage(msg.chat.id, t(msg.chat.id,'p2p_no_trades'), { parse_mode: 'Markdown' });
  for (const tr of mine.sort((a,b)=>b.createdAt-a.createdAt).slice(0,10)) await renderTrade(msg.chat.id, tr.id);
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
    // General
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

    // Admin (original)
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

    // Selling flow (original)
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

    if (data.startsWith('pay_')) {
      const method = data.split('_')[1];
      let prompt = '';
      if (method !== 'bank' && method !== 'skrill') userStates[chatId].paymentMethod = method;
      switch (method) {
        case 'wise':    prompt = t(chatId,'wise_prompt');    userStates[chatId].awaiting = 'wise_details'; break;
        case 'revolut': prompt = t(chatId,'revolut_prompt'); userStates[chatId].awaiting = 'revolut_details'; break;
        case 'paypal':  prompt = t(chatId,'paypal_prompt');  userStates[chatId].awaiting = 'paypal_details'; break;
        case 'bank':
          return bot.sendMessage(chatId, t(chatId,'bank_region'), {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: t(chatId,'pick_region_eu'), callback_data: 'bank_eu' }],
              [{ text: t(chatId,'pick_region_us'), callback_data: 'bank_us' }],
              [{ text: t(chatId,'back_menu'), callback_data: 'menu' }],
            ] }
          });
        case 'skrill':
          return bot.sendMessage(chatId, t(chatId,'skrill_or_neteller'), {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: t(chatId,'pick_skrill'), callback_data: 'payout_skrill' }],
              [{ text: t(chatId,'pick_neteller'), callback_data: 'payout_neteller' }],
              [{ text: t(chatId,'back_menu'), callback_data: 'menu' }],
            ] }
          });
        case 'card':    prompt = t(chatId,'card_prompt');    userStates[chatId].awaiting = 'card_details'; break;
        case 'payeer':  prompt = t(chatId,'payeer_prompt');  userStates[chatId].awaiting = 'payeer_details'; break;
        case 'alipay':  prompt = t(chatId,'alipay_prompt');  userStates[chatId].awaiting = 'alipay_details'; break;
      }
      if (prompt) return bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('payout_')) {
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

    /**
     * ──────────────────────────────────────────────────────────────────────────
     *  P2P CALLBACKS
     * ──────────────────────────────────────────────────────────────────────────
     */
    if (data === 'p2p_menu') return renderP2PMenu(chatId);
    if (data === 'p2p_browse') {
      // Let user pick quick filters
      userStates[chatId].awaiting = 'p2p_filter';
      return bot.sendMessage(chatId, 'Filter offers (optional). Send like:\n`side:BUY coin:USDT fiat:USD`\nOr send `skip`.', { parse_mode: 'Markdown' });
    }
    if (data === 'p2p_create') {
      // Start offer wizard
      userStates[chatId].p2pOffer = { step: 1, draft: { methods: [] }};
      return bot.sendMessage(chatId,
        '➕ Creating offer.\n1) Send side: `BUY` (you buy crypto, pay fiat) or `SELL` (you sell crypto, receive fiat).',
        { parse_mode: 'Markdown' });
    }
    if (data === 'p2p_mine') return renderMyOffers(chatId);
    if (data === 'p2p_trades') {
      const mine = Object.values(p2pTrades).filter(tr=> tr.buyerId===chatId || tr.sellerId===chatId);
      if (mine.length === 0) return bot.sendMessage(chatId, t(chatId,'p2p_no_trades'), { parse_mode: 'Markdown' });
      for (const tr of mine.sort((a,b)=>b.createdAt-a.createdAt).slice(0,10)) await renderTrade(chatId, tr.id);
      return;
    }

    if (data.startsWith('offer_view:')) {
      const id = +data.split(':')[1];
      const o = p2pOffers[id];
      if (!o) return;
      return bot.sendMessage(chatId, offerCardText(chatId,o), { parse_mode: 'Markdown' });
    }

    if (data.startsWith('offer_start:')) {
      const id = +data.split(':')[1];
      const o = p2pOffers[id];
      if (!o || !o.active) return;
      // Collect amount of coin
      userStates[chatId].awaiting = `p2p_amount:${id}`;
      return bot.sendMessage(chatId, t(chatId,'p2p_need_amount'), { parse_mode: 'Markdown' });
    }

    if (data.startsWith('offer_archive:')) {
      const id = +data.split(':')[1];
      const o = p2pOffers[id];
      if (!o || o.ownerId!==chatId) return;
      o.active = false;
      return bot.sendMessage(chatId, t(chatId,'p2p_offer_archived', id), { parse_mode: 'Markdown' });
    }

    if (data.startsWith('offer_relist:')) {
      const id = +data.split(':')[1];
      const o = p2pOffers[id];
      if (!o || o.ownerId!==chatId) return;
      o.active = true;
      return bot.sendMessage(chatId, t(chatId,'p2p_offer_relisted', id), { parse_mode: 'Markdown' });
    }

    if (data.startsWith('trade_paid:')) {
      const id = +data.split(':')[1];
      const tr = p2pTrades[id];
      if (!tr || chatId !== tr.buyerId) return;
      tr.status = 'fiat_marked_paid';
      await bot.sendMessage(chatId, t(chatId,'p2p_mark_paid_note'));
      await bot.sendMessage(tr.sellerId, `💵 Trade #${tr.id}: Buyer marked *Fiat Paid*. Please verify and then press “${t(chatId,'p2p_confirm_received')}”.`);
      await renderTrade(ADMIN_CHAT_ID, tr.id, true);
      return;
    }

    if (data.startsWith('trade_confirm:')) {
      const id = +data.split(':')[1];
      const tr = p2pTrades[id];
      if (!tr || chatId !== tr.sellerId) return;
      tr.status = 'seller_confirmed';
      await bot.sendMessage(chatId, t(chatId,'p2p_confirm_note'));
      await bot.sendMessage(tr.buyerId, `✅ Trade #${tr.id}: Seller confirmed fiat receipt.\nWaiting for admin release.`);
      // Notify admin to release
      await renderTrade(ADMIN_CHAT_ID, tr.id, true);
      return;
    }

    if (data.startsWith('trade_dispute:')) {
      const id = +data.split(':')[1];
      const tr = p2pTrades[id];
      if (!tr) return;
      tr.dispute = `Opened by ${chatId} at ${new Date().toLocaleString()}`;
      tr.status = 'disputed';
      await bot.sendMessage(chatId, t(chatId,'p2p_dispute_note'));
      await renderTrade(ADMIN_CHAT_ID, tr.id, true);
      return;
    }

    if (data.startsWith('trade_cancel:')) {
      const id = +data.split(':')[1];
      const tr = p2pTrades[id];
      if (!tr) return;
      tr.status = 'canceled';
      await bot.sendMessage(chatId, t(chatId,'p2p_canceled'));
      await bot.sendMessage(tr.buyerId, `🔔 Trade #${tr.id} canceled.`);
      await bot.sendMessage(tr.sellerId, `🔔 Trade #${tr.id} canceled.`);
      return;
    }

    // ADMIN P2P
    if (data.startsWith('admin_trade_')) {
      if (!isAdmin(chatId)) return;
      const [act, idStr] = data.split(':'); // e.g., admin_trade_release:12
      const id = +idStr;
      const tr = p2pTrades[id];
      if (!tr) return;

      if (act === 'admin_trade_escrow') {
        tr.status = 'escrow_received';
        await bot.sendMessage(ADMIN_CHAT_ID, '✅ Marked escrow received.');
        await renderTrade(ADMIN_CHAT_ID, tr.id, true);
        return;
      }
      if (act === 'admin_trade_release') {
        // Here you can call coinpayments.createWithdrawal(...) to send coin to seller wallet
        // For demo, we just mark released.
        tr.status = 'released';
        await bot.sendMessage(tr.sellerId, `🎉 Trade #${tr.id}: Escrow released.`, { parse_mode: 'Markdown' });
        await bot.sendMessage(tr.buyerId,  `🎉 Trade #${tr.id}: Completed.`);

        // Simple 1–5 rating prompt (inline stars)
        await bot.sendMessage(tr.buyerId, 'Please rate the counterparty (1-5):\n⭐️⭐️⭐️⭐️⭐️', {
          reply_markup: { inline_keyboard: [[
            { text:'1', callback_data:`rate:${tr.sellerId}:1` },
            { text:'2', callback_data:`rate:${tr.sellerId}:2` },
            { text:'3', callback_data:`rate:${tr.sellerId}:3` },
            { text:'4', callback_data:`rate:${tr.sellerId}:4` },
            { text:'5', callback_data:`rate:${tr.sellerId}:5` },
          ]] }
        });

        await renderTrade(ADMIN_CHAT_ID, tr.id, true);
        return;
      }
      if (act === 'admin_trade_cancel') {
        tr.status = 'canceled';
        await bot.sendMessage(tr.buyerId, '❌ Trade canceled by admin.');
        await bot.sendMessage(tr.sellerId, '❌ Trade canceled by admin.');
        await renderTrade(ADMIN_CHAT_ID, tr.id, true);
        return;
      }
    }

    if (data.startsWith('rate:')) {
      const [, uid, starsStr] = data.split(':');
      const stars = Math.max(1, Math.min(5, parseInt(starsStr,10) || 5));
      updateRep(uid, stars);
      await bot.sendMessage(chatId, t(chatId,'p2p_left_star', stars));
    }

  } finally {
    bot.answerCallbackQuery(cq.id).catch(()=>{});
  }
});

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  COINPAYMENTS ADDRESS (original off-ramp)
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

    const transactionOptions = {
      currency1: coin,
      currency2: coinCurrency,
      amount: state.amount,
      buyer_email: BUYER_REFUND_EMAIL,
      custom: `Order: ${orderNumber} | ${coin}/${net} | Payout to ${paymentMethodForCustom}: ${state.paymentDetails}`,
      item_name: `Sell ${state.amount} ${coin} for ${state.fiat}`,
      ipn_url: `${BOT_PUBLIC_URL}/coinpayments/ipn`
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
      ),
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
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
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

  // Ignore slash-commands
  if (text.startsWith('/')) return;

  // Support (original)
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

  // Admin — find order (original)
  if (st.awaiting === 'admin_find_order' && isAdmin(chatId)) {
    userStates[chatId].awaiting = null;
    const orderNumber = text.toUpperCase();
    return renderAdminOrderDetail(chatId, orderNumber);
  }

  // User — find order (original)
  if (st.awaiting === 'order_number_search') {
    const ord = text.toUpperCase();
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

  // User — amount entry (original)
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

  // Collect payout details (original)
  if ([
    'wise_details','revolut_details','paypal_details','card_details',
    'payeer_details','alipay_details','skrill_neteller_details',
    'bank_details_eu','bank_details_us'
  ].includes(st.awaiting)) {
    userStates[chatId].paymentDetails = text;
    userStates[chatId].awaiting = null;

    const previewOrder = generateOrderNumber();
    const fiatToReceive = await calculateFiatLive(userStates[chatId].coin || 'USDT', userStates[chatId].amount, userStates[chatId].fiat);

    await bot.sendMessage(chatId, `${t(chatId,'review_summary_title')}

*Order # (preview):* #${previewOrder}

*Selling:* ${userStates[chatId].amount} ${userStates[chatId].coin || 'USDT'}
*Network:* ${userStates[chatId].network}
*Currency to Receive:* ${userStates[chatId].fiat}
*Amount to Receive (current):* ${fiatToReceive.toFixed(2)} ${userStates[chatId].fiat}
*Payment Method:* ${userStates[chatId].paymentMethod}
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

  /**
   * ────────────────────────────────────────────────────────────────────────────
   *  P2P — Wizard inputs & amount capture
   * ────────────────────────────────────────────────────────────────────────────
   */
  // Browse filter text
  if (st.awaiting === 'p2p_filter') {
    userStates[chatId].awaiting = null;
    const filter = {};
    if (text.toLowerCase() !== 'skip') {
      const parts = text.split(/\s+/);
      for (const p of parts) {
        const [k,v] = p.split(':');
        if (!k || !v) continue;
        if (k==='side' && (v==='BUY'||v==='SELL')) filter.side = v;
        if (k==='coin' && SUPPORTED_COINS.includes(v)) filter.coin = v;
        if (k==='fiat' && SUPPORTED_FIAT.includes(v)) filter.fiat = v;
      }
    }
    return renderOffersList(chatId, filter);
  }

  // Create offer wizard
  if (st.p2pOffer) {
    const s = st.p2pOffer;
    if (s.step === 1) {
      const side = text.toUpperCase();
      if (!['BUY','SELL'].includes(side)) return bot.sendMessage(chatId, 'Send `BUY` or `SELL`.', { parse_mode: 'Markdown' });
      s.draft.side = side; s.step = 2;
      return bot.sendMessage(chatId, '2) Coin? `USDT` | `BTC` | `ETH`', { parse_mode: 'Markdown' });
    }
    if (s.step === 2) {
      const coin = text.toUpperCase();
      if (!SUPPORTED_COINS.includes(coin)) return bot.sendMessage(chatId, 'Pick one of: `USDT`, `BTC`, `ETH`.', { parse_mode: 'Markdown' });
      s.draft.coin = coin; s.step = 3;
      return bot.sendMessage(chatId, coin==='USDT' ? '3) Network? `TRC20` or `ERC20`' : '3) Network? `MAIN`', { parse_mode: 'Markdown' });
    }
    if (s.step === 3) {
      const net = text.toUpperCase();
      if (s.draft.coin==='USDT' && !['TRC20','ERC20'].includes(net)) return bot.sendMessage(chatId, 'Send `TRC20` or `ERC20`.', { parse_mode: 'Markdown' });
      if (s.draft.coin!=='USDT' && net!=='MAIN') return bot.sendMessage(chatId, 'Send `MAIN`.', { parse_mode: 'Markdown' });
      s.draft.network = net; s.step = 4;
      return bot.sendMessage(chatId, '4) Fiat? `USD` | `EUR` | `GBP`', { parse_mode: 'Markdown' });
    }
    if (s.step === 4) {
      const fiat = text.toUpperCase();
      if (!SUPPORTED_FIAT.includes(fiat)) return bot.sendMessage(chatId, 'Pick `USD`, `EUR`, or `GBP`.', { parse_mode: 'Markdown' });
      s.draft.fiat = fiat; s.step = 5;
      return bot.sendMessage(chatId, '5) Pricing: send either:\n• `fixed: <pricePerCoin>`\n• `margin: <percent>` (e.g., `margin: +1.5`)', { parse_mode: 'Markdown' });
    }
    if (s.step === 5) {
      const m = text.toLowerCase();
      if (m.startsWith('fixed:')) {
        const val = parseFloat(m.split(':')[1]);
        if (!val || val<=0) return bot.sendMessage(chatId, 'Invalid fixed price.');
        s.draft.pricing = {type:'fixed', value: +val.toFixed(2)}; s.step = 6;
      } else if (m.startsWith('margin:')) {
        const val = parseFloat(m.split(':')[1]);
        if (isNaN(val)) return bot.sendMessage(chatId, 'Invalid margin (e.g., +1.5 or -0.8).');
        s.draft.pricing = {type:'margin', margin: +val}; s.step = 6;
      } else {
        return bot.sendMessage(chatId, 'Send `fixed: <num>` or `margin: <num>`.');
      }
      return bot.sendMessage(chatId, '6) Limits: send `min max` in fiat (e.g., `100 1000`).');
    }
    if (s.step === 6) {
      const [min,max] = text.split(/\s+/).map(Number);
      if (!min || !max || min<=0 || max<=0 || min>max) return bot.sendMessage(chatId, 'Invalid limits.');
      s.draft.minUsd = min; s.draft.maxUsd = max; s.step = 7;
      return bot.sendMessage(chatId, `7) Methods (comma separated). Options: ${P2P_PAYMENT_METHODS.join(', ')}`);
    }
    if (s.step === 7) {
      const methods = text.split(',').map(v=>v.trim()).filter(v=>P2P_PAYMENT_METHODS.includes(v));
      if (methods.length===0) return bot.sendMessage(chatId, 'Pick at least one valid method.');
      s.draft.methods = methods; s.step = 8;
      return bot.sendMessage(chatId, '8) Terms/notes (optional). Send text or `skip`.');
    }
    if (s.step === 8) {
      s.draft.terms = (text.toLowerCase()==='skip') ? '' : text;
      const offer = buildOffer(chatId, s.draft);
      delete st.p2pOffer;
      return bot.sendMessage(chatId, t(chatId,'p2p_offer_created', offer.id), { parse_mode:'Markdown' });
    }
  }

  // Amount for a chosen offer
  if (st.awaiting && st.awaiting.startsWith('p2p_amount:')) {
    const offerId = +st.awaiting.split(':')[1];
    const o = p2pOffers[offerId];
    userStates[chatId].awaiting = null;
    if (!o || !o.active) return bot.sendMessage(chatId, 'Offer no longer available.');

    const amt = parseFloat(text);
    if (!amt || amt<=0) return bot.sendMessage(chatId, t(chatId,'p2p_bad_amount'));

    // compute fiat total
    const price = await pricePerCoin(o.coin, o.fiat, o.pricing);
    const fiatTotal = +(price * amt).toFixed(2);
    if (fiatTotal < o.minUsd || fiatTotal > o.maxUsd) {
      return bot.sendMessage(chatId, t(chatId,'p2p_out_of_limits', o.minUsd, o.maxUsd, o.fiat));
    }

    const tr = buildTradeFromOffer(o, chatId, amt, price, fiatTotal);
    // Create escrow address for buyer (the coin-sender — the starter when offer side = BUY)
    await createEscrowAddressForTrade(chatId, tr);
    await renderTrade(chatId, tr.id);
    if (tr.sellerId !== chatId) await renderTrade(tr.sellerId, tr.id);
    return;
  }
});

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  (Optional) Express webhook to auto-handle CoinPayments IPN
 * ──────────────────────────────────────────────────────────────────────────────
 * Plug this into an Express server if/when you’re ready. Validate HMAC with IPN_SECRET.
 *
 * app.post('/coinpayments/ipn', bodyParser.urlencoded({extended:false}), (req,res)=>{
 *   const { txn_id, status, custom } = req.body;
 *   // find trade by txn_id or parse `custom` (Trade #)
 *   // if status >= 100 mark escrow_received
 *   res.end('OK');
 * });
 */

console.log("P2P-enabled bot is running…");
