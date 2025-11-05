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

const SUPPORTED_COINS = ['USDT', 'BTC', 'ETH'];
const COIN_NETWORK_MAP = {
  USDT: { TRC20: 'USDT.TRC20', ERC20: 'USDT.ERC20' },
  BTC:  { MAIN:  'BTC' },
  ETH:  { MAIN:  'ETH' }
};

const FIXED_USDT_USD = 1.12;
const FIXED_USDT_EUR = 0.98;
const FIXED_USDT_GBP = 0.86;

const REFERRAL_REWARD_USDT = 1.2;
const MIN_REFERRAL_WITHDRAWAL_USDT = 50; // used only for referral section

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  IN-MEMORY STORAGE (replace with DB for production)
 * ──────────────────────────────────────────────────────────────────────────────
 */

const lastMessageIds = {};
let orderCounter = 1000;
const transactionRecords = {}; // #ORD -> transaction

const userStates = {};          // per-user state + settings (including lang)
const referralData = {};        // referral balances etc.
const adminReplyMap = {};       // admin support replies

// Digital Store (catalog only now)
const store = {
  nextProductId: 1,
  products: {}, // pid -> { id, name, priceUSDT, payloads:[], createdAt }
};

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  LIGHT I18N (EN default + DE, ZH, ES, RU, HI)
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
    btn_store: '🛍 Digital Store',
    btn_about: 'ℹ️ About & Safety',
    btn_help: '📖 GUIDE / FAQ',
    btn_find: '🔍 Find Transaction',
    btn_support: '💬 Contact Support',
    btn_admin: '🛠 Admin Panel',
    btn_language: '🌐 Language',
    about_text: `🛡️ *About & Safety*

• *Non-Custodial Flow:* You only send funds to a dedicated address generated for your order.  
• *Order Tracking:* Every transaction has a unique order number (e.g., ORD1000123456).  
• *Secure Processor:* We rely on reputable payment rails and industry-standard crypto tooling.  
• *Human Support:* Real people available via */support* if anything feels unclear.  
• *Transparent Quotes:* Live estimates with a dedicated *Refresh rates* button.

_Pro tip:_ Always verify the *coin* and *network* before sending. If unsure, ask us first!`,
    guide_title: '📖 GUIDE / FAQ',
    guide_body: (min,max)=>`*1) Start*  
Tap *Start selling* → pick coin (BTC/ETH/USDT) → choose payout currency (USD/EUR/GBP).

*2) Network*  
USDT: TRC20 or ERC20; BTC/ETH: mainnet.  
*Wrong network can result in loss of funds.*

*3) Amount*  
Enter the amount. We show a live estimate (USDT uses fixed rates below).  
*Min:* $${min} | *Max:* $${max}.

*4) Payout Method*  
Wise, Revolut, PayPal, Bank, Skrill/Neteller, Card, Payeer, Alipay.

*5) Review & Confirm*  
We summarize everything. If all good, we generate your unique deposit address.

*6) Send & Track*  
Send the exact amount. Keep your *Order Number* to check status.`,
    find_prompt: '🔎 *Find your order*\n\nPlease enter your order number (e.g., ORD1000123456):',
    support_prompt: '💬 *Tell us what you need*\n\nType your question or issue below in one message. A human will reply here soon.',
    menu: '🏠 Main Menu',
    back: '⬅️ Back',
    store_title: (count)=>`🛍 *Digital Store*\n\nBrowse digital items.\n\n*Products:* ${count}`,
    store_browse: '📦 Browse Products',
    store_empty: '_No products yet._',
    products_title: '📦 *Products*',
    product_not_found: '❌ Product not found.',
    product_view: (p)=>`🧩 *${p.name}*\n\nPrice: *${p.priceUSDT} USDT*\nStock: ${p.payloads.length}`,
    rates_header: 'Rates (approx)',
    choose_coin: (rates)=>`What are you selling today? 😊\n\n${rates}`,
    coin_selected: (c)=>`✅ Great — *${c}* selected.\n\nWhich currency would you like to receive?`,
    enter_amount_btc: (min,max)=>`✅ BTC (Bitcoin mainnet).\n\nPlease enter the *amount of BTC* to sell.\n\n*Minimum:* $${min}\n*Maximum:* $${max}`,
    enter_amount_eth: (min,max)=>`✅ ETH (Ethereum mainnet).\n\nPlease enter the *amount of ETH* to sell.\n\n*Minimum:* $${min}\n*Maximum:* $${max}`,
    enter_amount_usdt: (net,min,max,c)=>`✅ ${c} on *${net}*.\n\nPlease enter the amount of *${c}* you want to sell.\n\n*Minimum:* $${min}\n*Maximum:* $${max}`,
    invalid_number: '❌ That doesn’t look like a valid number. Please enter a positive amount.',
    price_unavailable: (coin)=>`❌ Couldn’t fetch pricing for ${coin}. Please try again in a moment.`,
    out_of_range: (amt,coin,usd,min,max)=>`❌ Amount out of range.\nYour ${amt} ${coin} ≈ $${usd}.\nPlease enter an amount worth between $${min} and $${max}.`,
    approx_receive: (amt,coin,fiat,fiatAmt)=>`✅ *Amount confirmed:* ${amt} ${coin}\n\nYou’ll receive approximately *${fiatAmt} ${fiat}*.\n\nPlease choose your payout method:`,
    payout_buttons: [
      ['Wise','Revolut'],
      ['PayPal','Bank Transfer'],
      ['Skrill/Neteller','Visa/Mastercard'],
      ['Payeer','Alipay'],
    ],
    choose_network: (c)=>`✅ *${c}* selected.\n\nPlease pick your ${c} network:`,
    bank_region: '✅ *Bank Transfer Selected*\n\nPlease choose your bank’s region:',
    bank_eu_prompt: '✅ *European Bank Transfer*\n\nReply in one message:\n\n`First and Last Name:\nIBAN:\nSwift Code:`',
    bank_us_prompt: '✅ *US Bank Transfer*\n\nReply in one message:\n\n`Account Holder Name:\nAccount Number:\nRouting Number (ACH or ABA):`',
    wise_prompt: '✅ *Wise Selected*\n\nPlease share your *Wise email* or *@wisetag*:',
    revolut_prompt: '✅ *Revolut Selected*\n\nPlease share your *Revolut tag* (e.g., @username):',
    paypal_prompt: '✅ *PayPal Selected*\n\nPlease share your *PayPal email address*:',
    card_prompt: '✅ *Card Payment Selected*\n\nPlease share your *Visa or Mastercard number*:',
    payeer_prompt: '✅ *Payeer Selected*\n\nPlease share your *Payeer Number* (e.g., P12345678):',
    alipay_prompt: '✅ *Alipay Selected*\n\nPlease share your *Alipay email*:',
    skrill_or_neteller: '✅ *Skrill/Neteller Selected*\n\nWhich one are you using?',
    payout_selected: (method)=>`✅ *${method} Selected*\n\nPlease share your *${method} email*:`,
    review_summary_title: '📋 *TRANSACTION SUMMARY*',
    review_continue: '✅ Continue & Generate Address',
    review_edit: '✏️ Edit Payment Details',
    confirm_creating_addr: '🔐 Thanks! Creating a secure deposit address for you…',
    address_ready: (order,txn,amount,coin,net,address,payout,details)=>`✅ *Deposit Address Ready!*\n\n*Order Number:* #${order}\n*Transaction ID:* ${txn}\n\nPlease send exactly *${amount} ${coin}* (${net}) to:\n\n\`${address}\`\n\n⏳ *Waiting for network confirmations…*\n\n*Payout Method:* ${payout}\n*Payout Details:* \n\`${details}\`\n\n⚠️ *Important:* Send only ${coin} on the ${net} network to this address. Other assets or networks may result in loss of funds.\n\n💡 *Tip:* Save your order number (#${order}) to check status with \`/find\`.`,
    rates_unavailable: '_Live BTC/ETH unavailable right now._',
    refresh_rates: '🔄 Refresh rates',
    usd: 'USD', eur:'EUR', gbp:'GBP',
    pick_region_eu:'🇪🇺 European Bank', pick_region_us:'🇺🇸 US Bank',
    pick_skrill:'Skrill', pick_neteller:'Neteller',
    back_menu: '🏠 Main Menu',
    translator_title: '🌐 *Language*',
    choose_language: 'Choose your interface language:',
    language_set: (lbl)=>`✅ Language set to *${lbl}*.`,
    tx_found_title: '🔍 *Transaction Found*',
    tx_not_found: (ord)=>`❌ No transaction found with order number *${ord}*.`,
    try_again: '🔄 Try Again',
    start_over: 'No problem — let’s restart. Send /start when you’re ready.',
    admin_only: '🚫 This section is for admins only.',
    // Admin
    admin_dash: (u,t,p)=>`🛠 *Admin Panel*\n\n• Users: *${u}*\n• Transactions: *${t}*\n• Pending: *${p}*`,
    admin_refresh: '📊 Refresh Stats',
    admin_recent_btn: '🧾 Recent Transactions',
    admin_find_btn: '🔎 Find / Update Order',
    admin_broadcast_btn: '📣 Broadcast Message',
    admin_store_btn: '🛍 Store: Manage',
    admin_back: '⬅️ Back',
    admin_recent_title: '🧾 *Recent Transactions (last 5)*',
    admin_find_prompt: '🔎 *Admin: Find Order*\n\nSend the order number (e.g., `ORD1000123456`).',
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
    // Store admin
    store_manager_title: (lines)=>`🛍 *Store Manager*\n\n${lines}`,
    store_add: '➕ Add Product',
    store_stock: '📦 Add Stock (Payloads)',
    store_remove: '🗑 Remove Product',
    store_add_prompt: '➕ *Add Product*\n\nSend:\n`Name: Example Item\nPriceUSDT: 9.99`',
    store_stock_prompt: '📦 *Add Stock*\n\nSend:\n`ProductID: 1\nPayloads:\nCODE-1\nCODE-2\nhttps://download.link/file.zip`',
    store_remove_prompt: '🗑 *Remove Product*\n\nSend: `ProductID: <id>`',
    parse_error: '❌ Parse error. Please follow the template.',
    product_added: (id,name,price)=>`✅ Added product #${id}: *${name}* — ${price} USDT`,
    stock_added: (n,pid)=>`✅ Added *${n}* payload(s) to product #${pid}.`,
    product_removed: (pid)=>`🗑 Removed product #${pid}.`,
  },
  // Brief translations (only main flows/buttons/messages). You can refine texts later.
  de: {
    .../** shallow copy en then override minimal strings */{},
  },
  zh: {},
  es: {},
  ru: {},
  hi: {},
};

// To keep the code compact, we fallback to English if a key is missing.
// Provide minimal overrides for headings/buttons in target languages:
Object.assign(I18N.de, {
  main_welcome: (n,dt)=>`Hallo *${n||'du'}*! 👋\n\nVerkaufe *BTC, ETH oder USDT* → erhalte *USD, EUR oder GBP* — schnell & einfach.\n\n*Jetzt:* _${dt}_\n\nWähle eine Option:`,
  btn_start_selling: '✅ Verkauf starten',
  btn_store: '🛍 Digitaler Shop',
  btn_about: 'ℹ️ Info & Sicherheit',
  btn_help: '📖 Anleitung / FAQ',
  btn_find: '🔍 Bestellung finden',
  btn_support: '💬 Support kontaktieren',
  btn_admin: '🛠 Admin-Panel',
  btn_language: '🌐 Sprache',
  choose_language: 'Wähle deine Sprache:',
  language_set: (lbl)=>`✅ Sprache gesetzt: *${lbl}*.`,
  store_title: (c)=>`🛍 *Digitaler Shop*\n\nDigitale Artikel durchsuchen.\n\n*Produkte:* ${c}`,
  store_browse: '📦 Produkte ansehen',
  products_title: '📦 *Produkte*',
  product_not_found: '❌ Produkt nicht gefunden.',
  back_menu: '🏠 Hauptmenü',
});
Object.assign(I18N.zh, {
  main_welcome: (n,dt)=>`你好 *${n||'朋友'}*! 👋\n\n出售 *BTC/ETH/USDT* → 收取 *USD/EUR/GBP*，快速又简单。\n\n*当前时间：* _${dt}_\n\n请选择：`,
  btn_start_selling: '✅ 开始出售',
  btn_store: '🛍 数字商店',
  btn_about: 'ℹ️ 关于与安全',
  btn_help: '📖 指南 / 常见问题',
  btn_find: '🔍 查找订单',
  btn_support: '💬 联系客服',
  btn_admin: '🛠 管理面板',
  btn_language: '🌐 语言',
  choose_language: '请选择界面语言：',
  language_set: (lbl)=>`✅ 已切换语言为 *${lbl}*。`,
  store_title: (c)=>`🛍 *数字商店*\n\n浏览数字商品。\n\n*商品数：* ${c}`,
  store_browse: '📦 浏览商品',
  products_title: '📦 *商品*',
  product_not_found: '❌ 未找到该商品。',
  back_menu: '🏠 主菜单',
});
Object.assign(I18N.es, {
  main_welcome: (n,dt)=>`¡Hola *${n||'amigo/a'}*! 👋\n\nVende *BTC, ETH o USDT* → recibe *USD, EUR o GBP* — rápido y sencillo.\n\n*Ahora:* _${dt}_\n\nElige una opción:`,
  btn_start_selling: '✅ Empezar a vender',
  btn_store: '🛍 Tienda digital',
  btn_about: 'ℹ️ Acerca & Seguridad',
  btn_help: '📖 Guía / FAQ',
  btn_find: '🔍 Buscar pedido',
  btn_support: '💬 Contactar soporte',
  btn_admin: '🛠 Panel de admin',
  btn_language: '🌐 Idioma',
  choose_language: 'Elige tu idioma:',
  language_set: (lbl)=>`✅ Idioma cambiado a *${lbl}*.`,
  store_title: (c)=>`🛍 *Tienda Digital*\n\nExplora artículos digitales.\n\n*Productos:* ${c}`,
  store_browse: '📦 Ver productos',
  products_title: '📦 *Productos*',
  product_not_found: '❌ Producto no encontrado.',
  back_menu: '🏠 Menú principal',
});
Object.assign(I18N.ru, {
  main_welcome: (n,dt)=>`Привет, *${n||'друг'}*! 👋\n\nПродай *BTC/ETH/USDT* → получи *USD/EUR/GBP* — быстро и просто.\n\n*Сейчас:* _${dt}_\n\nВыбери действие:`,
  btn_start_selling: '✅ Начать продажу',
  btn_store: '🛍 Цифровой магазин',
  btn_about: 'ℹ️ О проекте и безопасность',
  btn_help: '📖 Руководство / FAQ',
  btn_find: '🔍 Найти заказ',
  btn_support: '💬 Связаться с поддержкой',
  btn_admin: '🛠 Панель админа',
  btn_language: '🌐 Язык',
  choose_language: 'Выберите язык интерфейса:',
  language_set: (lbl)=>`✅ Язык переключён на *${lbl}*.`,
  store_title: (c)=>`🛍 *Цифровой магазин*\n\nКаталог цифровых товаров.\n\n*Товаров:* ${c}`,
  store_browse: '📦 Каталог',
  products_title: '📦 *Товары*',
  product_not_found: '❌ Товар не найден.',
  back_menu: '🏠 Главное меню',
});
Object.assign(I18N.hi, {
  main_welcome: (n,dt)=>`नमस्ते *${n||'मित्र'}*! 👋\n\n*BTC/ETH/USDT* बेचें → *USD/EUR/GBP* प्राप्त करें — तेज़ और आसान।\n\n*समय:* _${dt}_\n\nएक विकल्प चुनें:`,
  btn_start_selling: '✅ बेचना शुरू करें',
  btn_store: '🛍 डिजिटल स्टोर',
  btn_about: 'ℹ️ जानकारी व सुरक्षा',
  btn_help: '📖 गाइड / FAQ',
  btn_find: '🔍 ऑर्डर ढूंढें',
  btn_support: '💬 सपोर्ट से संपर्क',
  btn_admin: '🛠 एडमिन पैनल',
  btn_language: '🌐 भाषा',
  choose_language: 'अपनी भाषा चुनें:',
  language_set: (lbl)=>`✅ भाषा बदली गई: *${lbl}*.`,
  store_title: (c)=>`🛍 *डिजिटल स्टोर*\n\nडिजिटल आइटम ब्राउज़ करें।\n\n*उपलब्ध उत्पाद:* ${c}`,
  store_browse: '📦 उत्पाद देखें',
  products_title: '📦 *उत्पाद*',
  product_not_found: '❌ उत्पाद नहीं मिला।',
  back_menu: '🏠 मुख्य मेनू',
});

// helper: get user's lang (defaults to en)
function ULang(chatId){ return (userStates[chatId]?.lang) || 'en'; }
// translate helper
function t(chatId, key, ...args) {
  const lang = ULang(chatId);
  const dict = I18N[lang] || I18N.en;
  const val = dict[key] ?? I18N.en[key];
  return (typeof val === 'function') ? val(...args) : (val || '');
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  RATES
 * ──────────────────────────────────────────────────────────────────────────────
 */

let lastRates = null;
let lastRatesAt = 0;
const RATES_TTL_MS = 60 * 1000;

async function fetchLiveRates() {
  const now = Date.now();
  if (lastRates && (now - lastRatesAt) < RATES_TTL_MS) return lastRates;

  const raw = await coinpayments.rates({ short: 1 });
  const get = s => raw[s] && raw[s].rate_btc ? parseFloat(raw[s].rate_btc) : null;

  const rUSD = get('USD');
  const rEUR = get('EUR');
  const rGBP = get('GBP');
  if (!rUSD || !rEUR || !rGBP) throw new Error('Missing fiat anchors from CoinPayments rates');

  const price = (symbol, fiatRateBTC) => {
    const v = get(symbol);
    return v ? (v / fiatRateBTC) : null;
  };

  const result = {
    USD: { BTC: price('BTC', rUSD), ETH: price('ETH', rUSD), USDT: FIXED_USDT_USD },
    EUR: { BTC: price('BTC', rEUR), ETH: price('ETH', rEUR), USDT: FIXED_USDT_EUR },
    GBP: { BTC: price('BTC', rGBP), ETH: price('ETH', rGBP), USDT: FIXED_USDT_GBP },
  };

  lastRates = result;
  lastRatesAt = now;
  return result;
}

async function calculateFiatLive(coinSymbol, coinAmount, fiatCurrency) {
  if (coinSymbol === 'USDT') {
    if (fiatCurrency === 'USD') return coinAmount * FIXED_USDT_USD;
    if (fiatCurrency === 'EUR') return coinAmount * FIXED_USDT_EUR;
    if (fiatCurrency === 'GBP') return coinAmount * FIXED_USDT_GBP;
  }
  const rates = await fetchLiveRates();
  const px = rates[fiatCurrency]?.[coinSymbol];
  if (!px) return 0;
  return coinAmount * px;
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
    ...transactionData,
    orderNumber,
    timestamp: new Date().toISOString(),
    status: 'pending',
  };
}

function findTransactionByOrderNumber(orderNumber) {
  return transactionRecords[orderNumber];
}

function initializeReferralData(userId) {
  if (!referralData[userId]) {
    referralData[userId] = {
      referrerId: null,
      balance: 0,
      referredCount: 0,
      isReferralRewardClaimed: false,
    };
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
  const notificationMessage = `
🆕 *NEW USER JOINED*

*User ID:* \`${userId}\`
*User Info:* ${userInfo}
*Join Time:* ${getCurrentDateTime()}${referralInfo}

Total users: ${Object.keys(referralData).length}
  `;
  bot.sendMessage(ADMIN_CHAT_ID, notificationMessage, { parse_mode: 'Markdown' });
}

async function sendOrEditMessage(chatId, text, options = {}) {
  try {
    if (lastMessageIds[chatId]) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: lastMessageIds[chatId],
        parse_mode: 'Markdown',
        ...options
      });
    } else {
      const sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...options });
      lastMessageIds[chatId] = sent.message_id;
    }
  } catch (error) {
    if (error.response && error.response.statusCode === 400) {
      const sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...options });
      lastMessageIds[chatId] = sent.message_id;
    } else {
      throw error;
    }
  }
}

function clearLastMessage(chatId) { delete lastMessageIds[chatId]; }

async function showLoadingMessage(chatId, duration = 1200) {
  const loadingMessage = await bot.sendMessage(chatId, "⏳ One moment… updating things for you.");
  return new Promise((resolve) => {
    setTimeout(async () => {
      try { await bot.deleteMessage(chatId, loadingMessage.message_id); } catch {}
      resolve();
    }, duration);
  });
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  MENUS / RENDERERS
 * ──────────────────────────────────────────────────────────────────────────────
 */

async function renderMainMenu(chatId) {
  const dt = getCurrentDateTime();
  const name = userStates[chatId]?.firstName || '';
  await sendOrEditMessage(chatId,
    t(chatId,'main_welcome', name, dt),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: t(chatId,'btn_start_selling'), callback_data: 'start_sell' }],
          [{ text: t(chatId,'btn_store'), callback_data: 'store_menu' }, { text: t(chatId,'btn_language'), callback_data: 'language' }],
          [{ text: t(chatId,'btn_about'), callback_data: 'show_about' }, { text: t(chatId,'btn_help'), callback_data: 'show_help' }],
          [{ text: t(chatId,'btn_find'), callback_data: 'find_transaction' }],
          [{ text: t(chatId,'btn_support'), callback_data: 'support_open' }],
          [{ text: t(chatId,'btn_admin'), callback_data: 'admin_menu' }]
        ]
      }
    }
  );
}

async function renderAbout(chatId) {
  await sendOrEditMessage(chatId, t(chatId,'about_text'), {
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
}

async function renderHelp(chatId) {
  const text = `*${t(chatId,'guide_title')}*\n\n${I18N[ULang(chatId)].guide_body?.(MIN_USD_EQ, MAX_USD_EQ) || I18N.en.guide_body(MIN_USD_EQ, MAX_USD_EQ)}\n\n${t(chatId,'about_text')}`;
  await sendOrEditMessage(chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
}

async function renderFindTransactionPrompt(chatId) {
  userStates[chatId] = { ...(userStates[chatId] || {}), awaiting: 'order_number_search' };
  await sendOrEditMessage(chatId, t(chatId,'find_prompt'), {
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
}

async function renderSupportPrompt(chatId) {
  if (userStates[chatId]?.awaiting) {
    await sendOrEditMessage(chatId, "⚠️ You’re in the middle of a transaction. Please finish or /start a new one, then contact support.", {
      reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
    });
    return;
  }
  userStates[chatId] = { ...(userStates[chatId] || {}), awaiting: 'support_message' };
  await sendOrEditMessage(chatId, t(chatId,'support_prompt'), {
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
  });
}

async function renderLanguageMenu(chatId) {
  await sendOrEditMessage(chatId, `${t(chatId,'translator_title')}\n\n${t(chatId,'choose_language')}`, {
    reply_markup: {
      inline_keyboard: [
        LANGS.map(l => ({ text: l.label, code: l.code }))
              .filter(l => l.code !== ULang(chatId))
              .slice(0,3) // split into rows of up to 3
              .map(l=>[{ text: LANGS.find(x=>x.code===l.code).label, callback_data: `lang_${l.code}`}]),
        LANGS.slice(3).map(l=>[{ text: l.label, callback_data: `lang_${l.code}`}]),
        [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
      ]
    }
  });
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  STORE (catalog only)
 * ──────────────────────────────────────────────────────────────────────────────
 */

function listProductsLines() {
  const ids = Object.keys(store.products);
  if (ids.length === 0) return I18N.en.store_empty;
  return ids.map(pid => {
    const p = store.products[pid];
    const stock = p.payloads.length;
    return `#${p.id} — *${p.name}* • ${p.priceUSDT} USDT • Stock: ${stock}`;
  }).join('\n');
}

async function renderStoreMenu(chatId) {
  const count = Object.keys(store.products).length;
  await sendOrEditMessage(chatId, t(chatId,'store_title', count), {
    reply_markup: {
      inline_keyboard: [
        [{ text: t(chatId,'store_browse'), callback_data: 'store_browse' }],
        [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
      ]
    }
  });
}

async function renderStoreBrowse(chatId) {
  const text = `${t(chatId,'products_title')}\n\n${listProductsLines()}`;
  const rows = Object.keys(store.products).map(pid => {
    const p = store.products[pid];
    return [{ text: `${p.name} — ${p.priceUSDT} USDT`, callback_data: `store_view_${p.id}` }];
  });
  await sendOrEditMessage(chatId, text, {
    reply_markup: { inline_keyboard: [...rows, [{ text: t(chatId,'back_menu'), callback_data: 'store_menu' }]] }
  });
}

async function renderStoreProduct(chatId, pid) {
  const p = store.products[pid];
  if (!p) {
    return sendOrEditMessage(chatId, t(chatId,'product_not_found'), {
      reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'store_browse' }]] }
    });
  }
  await sendOrEditMessage(chatId, t(chatId,'product_view', p), {
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'store_browse' }]] }
  });
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  ADMIN PANEL (unchanged features)
 * ──────────────────────────────────────────────────────────────────────────────
 */

function isAdmin(chatId) { return chatId.toString() === ADMIN_CHAT_ID.toString(); }

async function renderAdminMenu(chatId) {
  if (!isAdmin(chatId)) {
    await sendOrEditMessage(chatId, t(chatId,'admin_only'), {
      reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
    });
    return;
  }
  const totalUsers = Object.keys(referralData).length;
  const totalTx = Object.keys(transactionRecords).length;
  const pending = Object.values(transactionRecords).filter(t => t.status === 'pending').length;

  await sendOrEditMessage(chatId, t(chatId,'admin_dash', totalUsers, totalTx, pending), {
    reply_markup: {
      inline_keyboard: [
        [{ text: t(chatId,'admin_refresh'), callback_data: 'admin_stats' }],
        [{ text: t(chatId,'admin_recent_btn'), callback_data: 'admin_recent' }],
        [{ text: t(chatId,'admin_find_btn'), callback_data: 'admin_find' }],
        [{ text: t(chatId,'admin_store_btn'), callback_data: 'admin_store' }],
        [{ text: t(chatId,'admin_broadcast_btn'), callback_data: 'admin_broadcast' }],
        [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
      ]
    }
  });
}

function getRecentTransactions(limit = 5) {
  const list = Object.values(transactionRecords)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
  if (list.length === 0) return "_No transactions yet._";
  return list.map(t => {
    return `#${t.orderNumber} • ${t.coin}/${t.network} • ${t.amount} • ${t.fiat} • *${t.status}*\n` +
           `ID: \`${t.coinpaymentsTxnId}\` • ${new Date(t.timestamp).toLocaleString()}`;
  }).join('\n\n');
}

async function renderAdminRecent(chatId) {
  await sendOrEditMessage(chatId, `${t(chatId,'admin_recent_title')}\n\n${getRecentTransactions(5)}`, {
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]] }
  });
}

async function renderAdminFindPrompt(chatId) {
  userStates[chatId] = { ...(userStates[chatId] || {}), awaiting: 'admin_find_order' };
  await sendOrEditMessage(chatId, t(chatId,'admin_find_prompt'), {
    reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]] }
  });
}

async function renderAdminOrderDetail(chatId, orderNumber) {
  const tnx = findTransactionByOrderNumber(orderNumber);
  if (!tnx) {
    await sendOrEditMessage(chatId, `❌ Order *${orderNumber}* not found.`, {
      reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_find_btn'), callback_data: 'admin_find' }],[{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]] }
    });
    return;
  }
  await sendOrEditMessage(chatId, t(chatId,'admin_order_card', tnx), {
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
  clearLastMessage(chatId);

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

  await sendOrEditMessage(chatId, message, {
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
    // Navigation
    if (data === 'menu') return await renderMainMenu(chatId);
    if (data === 'show_about') return await renderAbout(chatId);
    if (data === 'show_help') return await renderHelp(chatId);
    if (data === 'find_transaction') return await renderFindTransactionPrompt(chatId);
    if (data === 'support_open') return await renderSupportPrompt(chatId);

    // Language
    if (data === 'language') return await renderLanguageMenu(chatId);
    if (data.startsWith('lang_')) {
      const code = data.split('_')[1];
      if (LANGS.find(l=>l.code===code)) {
        userStates[chatId].lang = code;
        const label = LANGS.find(l=>l.code===code).label;
        await sendOrEditMessage(chatId, t(chatId,'language_set', label), {
          reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
        });
      }
      return;
    }

    // Store (catalog only)
    if (data === 'store_menu') return await renderStoreMenu(chatId);
    if (data === 'store_browse') return await renderStoreBrowse(chatId);
    if (data.startsWith('store_view_')) {
      const pid = parseInt(data.split('_')[2]);
      return await renderStoreProduct(chatId, pid);
    }

    // Admin
    if (data === 'admin_menu' || data === 'admin_stats') return await renderAdminMenu(chatId);
    if (data === 'admin_recent') return await renderAdminRecent(chatId);
    if (data === 'admin_find') return await renderAdminFindPrompt(chatId);
    if (data.startsWith('admin_mark_')) {
      if (!isAdmin(chatId)) return;
      const [action, orderNumber] = data.split(':');
      let status = null;
      if (action === 'admin_mark_paid') status = 'paid';
      if (action === 'admin_mark_completed') status = 'completed';
      if (action === 'admin_mark_canceled') status = 'canceled';
      if (!status) return;
      const ok = updateOrderStatus(orderNumber, status);
      if (!ok) {
        return await sendOrEditMessage(chatId, `❌ Could not update order *${orderNumber}*.`, {
          reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]] }
        });
      }
      await notifyUserOrderUpdated(orderNumber);
      return await renderAdminOrderDetail(chatId, orderNumber);
    }

    // Admin Store manage
    if (data === 'admin_store') {
      const lines = listProductsLines();
      return await sendOrEditMessage(chatId, t(chatId,'store_manager_title', lines), {
        reply_markup: { inline_keyboard: [
          [{ text: t(chatId,'store_add'), callback_data: 'admin_store_add' }],
          [{ text: t(chatId,'store_stock'), callback_data: 'admin_store_stock' }],
          [{ text: t(chatId,'store_remove'), callback_data: 'admin_store_remove' }],
          [{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]
        ] }
      });
    }
    if (data === 'admin_store_add') {
      userStates[chatId].awaiting = 'admin_store_add';
      return await sendOrEditMessage(chatId, t(chatId,'store_add_prompt'), {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_back'), callback_data: 'admin_store' }]] }
      });
    }
    if (data === 'admin_store_stock') {
      userStates[chatId].awaiting = 'admin_store_stock';
      return await sendOrEditMessage(chatId, t(chatId,'store_stock_prompt'), {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_back'), callback_data: 'admin_store' }]] }
      });
    }
    if (data === 'admin_store_remove') {
      userStates[chatId].awaiting = 'admin_store_remove';
      return await sendOrEditMessage(chatId, t(chatId,'store_remove_prompt'), {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_back'), callback_data: 'admin_store' }]] }
      });
    }

    // Selling flow (unchanged)
    if (data === 'start_sell' || data === 'refresh_rates') {
      await showLoadingMessage(chatId);
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
      } catch (e) {
        pricesLine =
          `${t(chatId,'rates_unavailable')}\n` +
          `• 1 USDT = $${FIXED_USDT_USD.toFixed(2)} *(fixed)*\n` +
          `• 1 USDT = €${FIXED_USDT_EUR.toFixed(2)} *(fixed)*\n` +
          `• 1 USDT = £${FIXED_USDT_GBP.toFixed(2)} *(fixed)*`;
      }

      return sendOrEditMessage(chatId, t(chatId,'choose_coin', pricesLine), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "₿ Bitcoin (BTC)", callback_data: 'coin_BTC' },
             { text: "Ξ Ethereum (ETH)", callback_data: 'coin_ETH' }],
            [{ text: "💎 Tether (USDT)", callback_data: 'coin_USDT' }],
            [{ text: t(chatId,'refresh_rates'), callback_data: 'refresh_rates' }],
            [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
          ]
        }
      });
    }

    if (data === 'cancel') {
      delete userStates[chatId];
      return await sendOrEditMessage(chatId, t(chatId,'start_over'), {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
    }

    if (data.startsWith('coin_')) {
      const coin = data.split('_')[1];
      userStates[chatId].coin = coin;
      return sendOrEditMessage(chatId, t(chatId,'coin_selected', coin), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🇺🇸 USD", callback_data: 'fiat_USD' },
             { text: "🇪🇺 EUR", callback_data: 'fiat_EUR' },
             { text: "🇬🇧 GBP", callback_data: 'fiat_GBP' }],
            [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
          ]
        }
      });
    }

    if (data.startsWith('fiat_')) {
      await showLoadingMessage(chatId);
      const currency = data.split('_')[1];
      userStates[chatId].fiat = currency;

      const c = userStates[chatId].coin || 'USDT';
      if (c === 'USDT') {
        return sendOrEditMessage(chatId, t(chatId,'choose_network', c), {
          reply_markup: {
            inline_keyboard: [
              [{ text: "TRC20 (Tron)", callback_data: 'net_TRC20' }],
              [{ text: "ERC20 (Ethereum)", callback_data: 'net_ERC20' }],
              [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
            ]
          }
        });
      } else if (c === 'BTC') {
        userStates[chatId].network = 'MAIN';
        userStates[chatId].awaiting = 'amount';
        return sendOrEditMessage(chatId, t(chatId,'enter_amount_btc', MIN_USD_EQ, MAX_USD_EQ), {
          reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
        });
      } else if (c === 'ETH') {
        userStates[chatId].network = 'MAIN';
        userStates[chatId].awaiting = 'amount';
        return sendOrEditMessage(chatId, t(chatId,'enter_amount_eth', MIN_USD_EQ, MAX_USD_EQ), {
          reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
        });
      }
    }

    if (data.startsWith('net_')) {
      await showLoadingMessage(chatId);
      const net = data.split('_')[1];
      userStates[chatId].network = net;
      userStates[chatId].awaiting = 'amount';
      const coin = userStates[chatId].coin || 'USDT';
      return sendOrEditMessage(chatId, t(chatId,'enter_amount_usdt', userStates[chatId].network, MIN_USD_EQ, MAX_USD_EQ, coin), {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
    }

    if (data.startsWith('pay_')) {
      await showLoadingMessage(chatId);
      const method = data.split('_')[1];
      let prompt = '';

      if (method !== 'bank' && method !== 'skrill') {
        userStates[chatId].paymentMethod = method;
      }

      switch (method) {
        case 'wise':    prompt = t(chatId,'wise_prompt');    userStates[chatId].awaiting = 'wise_details'; break;
        case 'revolut': prompt = t(chatId,'revolut_prompt'); userStates[chatId].awaiting = 'revolut_details'; break;
        case 'paypal':  prompt = t(chatId,'paypal_prompt');  userStates[chatId].awaiting = 'paypal_details'; break;
        case 'bank':
          return sendOrEditMessage(chatId, t(chatId,'bank_region'), {
            reply_markup: { inline_keyboard: [
              [{ text: t(chatId,'pick_region_eu'), callback_data: 'bank_eu' }],
              [{ text: t(chatId,'pick_region_us'), callback_data: 'bank_us' }],
              [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
            ] }
          });
        case 'skrill':
          return sendOrEditMessage(chatId, t(chatId,'skrill_or_neteller'), {
            reply_markup: { inline_keyboard: [
              [{ text: t(chatId,'pick_skrill'), callback_data: 'payout_skrill' }],
              [{ text: t(chatId,'pick_neteller'), callback_data: 'payout_neteller' }],
              [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
            ] }
          });
        case 'card':    prompt = t(chatId,'card_prompt');    userStates[chatId].awaiting = 'card_details'; break;
        case 'payeer':  prompt = t(chatId,'payeer_prompt');  userStates[chatId].awaiting = 'payeer_details'; break;
        case 'alipay':  prompt = t(chatId,'alipay_prompt');  userStates[chatId].awaiting = 'alipay_details'; break;
      }
      if (prompt) {
        return sendOrEditMessage(chatId, prompt, { reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] } });
      }
    }

    if (data.startsWith('payout_')) {
      await showLoadingMessage(chatId);
      const method = data.split('_')[1];
      const name = method.charAt(0).toUpperCase() + method.slice(1);
      userStates[chatId].paymentMethod = name;
      userStates[chatId].awaiting = 'skrill_neteller_details';
      return sendOrEditMessage(chatId, t(chatId,'payout_selected', name), {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
    }

    if (data.startsWith('bank_')) {
      await showLoadingMessage(chatId);
      const region = data.split('_')[1];
      userStates[chatId].paymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
      if (region === 'eu') {
        userStates[chatId].awaiting = 'bank_details_eu';
        return sendOrEditMessage(chatId, t(chatId,'bank_eu_prompt'), { reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] } });
      } else {
        userStates[chatId].awaiting = 'bank_details_us';
        return sendOrEditMessage(chatId, t(chatId,'bank_us_prompt'), { reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] } });
      }
    }

    if (data === 'confirm_transaction') {
      await showLoadingMessage(chatId);
      userStates[chatId].awaiting = null;
      await sendOrEditMessage(chatId, t(chatId,'confirm_creating_addr'), {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
      return generateDepositAddress(chatId);
    }

    if (data === 'edit_transaction') {
      await showLoadingMessage(chatId);
      delete userStates[chatId];
      return sendOrEditMessage(chatId, t(chatId,'start_over'), {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
    }

  } finally {
    bot.answerCallbackQuery(cq.id);
  }
});

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  COINPAYMENTS DEPOSIT ADDRESS (selling flow)
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
      coinpaymentsTxnId: result.txn_id,
      depositAddress: result.address,
      timestamp: new Date().toISOString()
    });

    const referrerId = referralData[chatId]?.referrerId;
    if (referrerId && !referralData[chatId].isReferralRewardClaimed) {
      rewardReferrer(referrerId, chatId);
      referralData[chatId].isReferralRewardClaimed = true;
    }

    await sendOrEditMessage(chatId,
      t(chatId,'address_ready',
        orderNumber, result.txn_id, result.amount, coin, net, result.address,
        paymentMethodForCustom, state.paymentDetails
      ),
      { reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] } }
    );
    delete userStates[chatId];

  } catch (error) {
    console.error("CoinPayments API Error:", error);
    await sendOrEditMessage(chatId, "❌ Error creating deposit address. Please try again or contact /support.", {
      reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
    });
  }
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  MESSAGE HANDLER
 * ──────────────────────────────────────────────────────────────────────────────
 */

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
        await bot.sendMessage(chatId, "✅ Reply sent to user.");
        delete adminReplyMap[forwardedMessageId];
      } catch (e) {
        await bot.sendMessage(chatId, "❌ Couldn’t deliver reply. The user may have blocked the bot.");
      }
    } else {
      bot.sendMessage(chatId, "Hmm, I can’t match that reply to an active support ticket.");
    }
    return;
  }

  // Ignore commands (handled elsewhere)
  if (text.startsWith('/')) return;

  // Support message from user
  if (st.awaiting === 'support_message') {
    const supportText = text;
    const userInfo = `User ID: ${msg.from.id}, Name: ${msg.from.first_name || ''} ${msg.from.last_name || ''}, Username: @${msg.from.username || 'N/A'}`;
    const forwarded = `*🚨 NEW SUPPORT REQUEST*\n\nFrom: ${userInfo}\n\n*Message:* \n${supportText}\n\n--- \n_Reply to this message to respond to the user._`;
    try {
      const sent = await bot.sendMessage(ADMIN_CHAT_ID, forwarded, { parse_mode: 'Markdown' });
      adminReplyMap[sent.message_id] = chatId;
      await sendOrEditMessage(chatId, "✅ Thanks! Your message is with support. We’ll reply here shortly.", {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
      delete userStates[chatId];
    } catch {
      await sendOrEditMessage(chatId, "❌ Sorry, we couldn’t reach support right now. Please try again later.", {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
    }
    return;
  }

  // Admin — broadcast message text
  if (st.awaiting === 'admin_broadcast_message' && isAdmin(chatId)) {
    const recipients = Object.keys(referralData);
    let success = 0, fail = 0;
    for (const uid of recipients) {
      try { await bot.sendMessage(uid, `📣 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' }); success++; } catch { fail++; }
    }
    userStates[chatId].awaiting = null;
    return await sendOrEditMessage(chatId, `✅ Broadcast complete.\nSent: *${success}* | Failed: *${fail}*`, {
      reply_markup: { inline_keyboard: [[{ text: t(chatId,'admin_back'), callback_data: 'admin_menu' }]] }
    });
  }

  // Admin — find order (text input)
  if (st.awaiting === 'admin_find_order' && isAdmin(chatId)) {
    userStates[chatId].awaiting = null;
    const orderNumber = text.trim().toUpperCase();
    return await renderAdminOrderDetail(chatId, orderNumber);
  }

  // User — find order
  if (st.awaiting === 'order_number_search') {
    const ord = text.trim().toUpperCase();
    const tnx = findTransactionByOrderNumber(ord);
    if (tnx) {
      const info = `
${t(chatId,'tx_found_title')}

*Order Number:* #${tnx.orderNumber}
*Transaction ID:* ${tnx.coinpaymentsTxnId}
*Coin:* ${tnx.coin || 'USDT'}
*Amount:* ${tnx.amount} ${tnx.coin || 'USDT'}
*Network:* ${tnx.network}
*Currency:* ${tnx.fiat}
*Payment Method:* ${tnx.paymentMethod}
*Status:* ${tnx.status}
*Date:* ${new Date(tnx.timestamp).toLocaleString()}
*Deposit Address:* \`${tnx.depositAddress}\`
      `;
      await sendOrEditMessage(chatId, info, {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
    } else {
      await sendOrEditMessage(chatId, t(chatId,'tx_not_found', ord), {
        reply_markup: { inline_keyboard: [[{ text: t(chatId,'try_again'), callback_data: 'find_transaction' }],[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] }
      });
    }
    delete userStates[chatId];
    return;
  }

  // User — selling flow inputs
  if (st.awaiting === 'amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return sendOrEditMessage(chatId, t(chatId,'invalid_number'), { reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] } });
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

    if (!usdValue) {
      return sendOrEditMessage(chatId, t(chatId,'price_unavailable', coin), { reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] } });
    }
    if (usdValue < MIN_USD_EQ || usdValue > MAX_USD_EQ) {
      return sendOrEditMessage(chatId, t(chatId,'out_of_range', amount, coin, usdValue.toFixed(2), MIN_USD_EQ, MAX_USD_EQ), { reply_markup: { inline_keyboard: [[{ text: t(chatId,'back_menu'), callback_data: 'menu' }]] } });
    }

    userStates[chatId].amount = amount;

    const fiatToReceive = await calculateFiatLive(coin, amount, st.fiat || 'USD');
    const confirmationMessage = t(chatId,'approx_receive', amount, coin, st.fiat, fiatToReceive.toFixed(2));

    sendOrEditMessage(chatId, confirmationMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Wise", callback_data: 'pay_wise' }, { text: "Revolut", callback_data: 'pay_revolut' }],
          [{ text: "PayPal", callback_data: 'pay_paypal' }, { text: "Bank Transfer", callback_data: 'pay_bank' }],
          [{ text: "Skrill/Neteller", callback_data: 'pay_skrill' }, { text: "Visa/Mastercard", callback_data: 'pay_card' }],
          [{ text: "Payeer", callback_data: 'pay_payeer' }, { text: "Alipay", callback_data: 'pay_alipay' }],
          [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
        ]
      }
    });
    userStates[chatId].awaiting = null;
    return;
  }

  if ([
    'wise_details', 'revolut_details', 'paypal_details', 'card_details',
    'payeer_details', 'alipay_details', 'skrill_neteller_details',
    'bank_details_eu', 'bank_details_us'
  ].includes(st.awaiting)) {
    userStates[chatId].paymentDetails = text;
    userStates[chatId].awaiting = null;

    const orderNumber = generateOrderNumber();

    const fiatToReceive = await calculateFiatLive(userStates[chatId].coin || 'USDT', userStates[chatId].amount, userStates[chatId].fiat);
    const review = `${t(chatId,'review_summary_title')}

*Order Number:* #${orderNumber}

*Selling:* ${userStates[chatId].amount} ${userStates[chatId].coin || 'USDT'}
*Network:* ${userStates[chatId].network}
*Currency to Receive:* ${userStates[chatId].fiat}
*Amount to Receive (current):* ${fiatToReceive.toFixed(2)} ${userStates[chatId].fiat}
*Payment Method:* ${userStates[chatId].paymentMethod}
*Payment Details:* 
\`${userStates[chatId].paymentDetails}\``;

    return sendOrEditMessage(chatId, review, {
      reply_markup: { inline_keyboard: [
        [{ text: t(chatId,'review_continue'), callback_data: 'confirm_transaction' }],
        [{ text: t(chatId,'review_edit'), callback_data: 'edit_transaction' }],
        [{ text: t(chatId,'back_menu'), callback_data: 'menu' }]
      ] }
    });
  }
});

console.log("Bot is running…");
