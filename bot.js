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
  { command: 'start', description: '🚀 Start a new transaction' },
  { command: 'referral', description: '🤝 Referral status & link' },
  { command: 'find', description: '🔍 Find transaction by order number' },
  { command: 'help', description: '❓ FAQ' },
  { command: 'support', description: '💬 Contact support' },
  { command: 'admin', description: '🛠 Admin panel (admin only)' },
]);

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  CONSTANTS
 * ──────────────────────────────────────────────────────────────────────────────
 */

const MERCHANT_ID = '431eb6f352649dfdcde42b2ba8d5b6d8';
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const MIN_USD_EQ = 25;
const MAX_USD_EQ = 50000;

const SUPPORT_CONTACT = '@DeanAbdullah';

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
const MIN_REFERRAL_WITHDRAWAL_USDT = 50;

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  IN-MEMORY STORAGE (replace with DB for production)
 * ──────────────────────────────────────────────────────────────────────────────
 */

const lastMessageIds = {};
let orderCounter = 1000;
const transactionRecords = {}; // #ORD -> transaction

const userStates = {};
const referralData = {};
const adminReplyMap = {};

// Wallets
const wallets = {}; // userId -> { balance: number, history: [ {type, amount, ts, note} ] }
function getWallet(uid) {
  if (!wallets[uid]) wallets[uid] = { balance: 0, history: [] };
  return wallets[uid];
}
function walletCredit(uid, amount, note='credit') {
  const w = getWallet(uid);
  w.balance += amount;
  w.history.push({ type: 'credit', amount, ts: new Date().toISOString(), note });
}
function walletDebit(uid, amount, note='debit') {
  const w = getWallet(uid);
  w.balance -= amount;
  w.history.push({ type: 'debit', amount, ts: new Date().toISOString(), note });
}

// Withdrawal requests (admin approval)
let nextWithdrawalId = 1;
const pendingWithdrawals = {}; // wid -> { id, userId, amount, method, details, status, ts }

// Digital Store
const store = {
  nextProductId: 1,
  products: {}, // pid -> { id, name, priceUSDT, payloads:[], createdAt }
  orders: []    // { orderId, userId, productId, priceUSDT, deliveredPayload, ts }
};

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

function getCurrentDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return `${date} - ${time}`;
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

async function formatPaymentDetailsLive(userState, orderNumber = null) {
  const { amount, fiat, network, paymentMethod, paymentDetails, coin } = userState;
  const fiatToReceive = await calculateFiatLive(coin || 'USDT', amount, fiat);
  const orderInfo = orderNumber ? `*Order Number:* #${orderNumber}\n\n` : '';
  return `
📋 *TRANSACTION SUMMARY*

${orderInfo}*Selling:* ${amount} ${coin || 'USDT'}
*Network:* ${network}
*Currency to Receive:* ${fiat}
*Amount to Receive (current):* ${fiatToReceive.toFixed(2)} ${fiat}
*Payment Method:* ${paymentMethod}
*Payment Details:* 
\`${paymentDetails}\`
`;
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
 *  TEXT / ABOUT
 * ──────────────────────────────────────────────────────────────────────────────
 */

const ABOUT_TEXT = `
🛡️ *About & Safety*

• *Non-Custodial Flow:* You only send funds to a dedicated address generated for your order.  
• *Order Tracking:* Every transaction has a unique order number (e.g., ORD1000123456).  
• *Secure Processor:* We rely on reputable payment rails and industry-standard crypto tooling.  
• *Human Support:* Real people available via */support* if anything feels unclear.  
• *Transparent Quotes:* Live estimates with a dedicated *Refresh rates* button.

_Pro tip:_ Always verify the *coin* and *network* before sending. If unsure, ask us first!
`;

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  TRANSLATOR (Germany/DE, Russian/RU, China/ZH, Spain/ES, India/HI)
 * ──────────────────────────────────────────────────────────────────────────────
 */

// Stub translator — replace with real API for production
async function translateText(text, target) {
  // TODO: integrate Google/DeepL/etc. For now, fake it so UI is complete.
  return `[${target.toUpperCase()}] ${text}`;
}

const LANGS = [
  { code: 'de', label: '🇩🇪 German' },
  { code: 'ru', label: '🇷🇺 Russian' },
  { code: 'zh', label: '🇨🇳 Chinese' },
  { code: 'es', label: '🇪🇸 Spanish' },
  { code: 'hi', label: '🇮🇳 Hindi' },
];

async function renderTranslatorMenu(chatId) {
  await sendOrEditMessage(chatId, `🌐 *Translator*\n\nChoose target language:`, {
    reply_markup: {
      inline_keyboard: [
        ...LANGS.map(l => [{ text: l.label, callback_data: `trg_${l.code}` }]),
        [{ text: "🏠 Main Menu", callback_data: 'menu' }]
      ]
    }
  });
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  WALLET (Deposit request -> Admin credit; Withdraw -> Admin approve)
 * ──────────────────────────────────────────────────────────────────────────────
 */

async function renderWalletMenu(chatId) {
  const w = getWallet(chatId);
  const bal = w.balance.toFixed(2);
  await sendOrEditMessage(chatId, `👛 *Wallet*\n\n*Balance:* *${bal} USDT*\n\nWhat would you like to do?`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Request Deposit", callback_data: 'wallet_deposit' }, { text: "➖ Withdraw", callback_data: 'wallet_withdraw' }],
        [{ text: "🧾 History", callback_data: 'wallet_history' }],
        [{ text: "🏠 Main Menu", callback_data: 'menu' }]
      ]
    }
  });
}

async function renderWalletHistory(chatId) {
  const w = getWallet(chatId);
  if (w.history.length === 0) {
    return sendOrEditMessage(chatId, `🧾 *Wallet History*\n\nNo entries yet.`, {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'wallet_menu' }]] }
    });
  }
  const lines = w.history.slice(-10).reverse().map(h => {
    const sign = h.type === 'credit' ? '+' : '-';
    return `• ${new Date(h.ts).toLocaleString()} — ${sign}${h.amount} USDT — _${h.note}_`;
  }).join('\n');
  await sendOrEditMessage(chatId, `🧾 *Wallet History (last 10)*\n\n${lines}`, {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'wallet_menu' }]] }
  });
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  DIGITAL STORE
 * ──────────────────────────────────────────────────────────────────────────────
 */

async function renderStoreMenu(chatId) {
  const count = Object.keys(store.products).length;
  await sendOrEditMessage(chatId, `🛍 *Digital Store*\n\nBrowse and purchase digital items with your wallet balance.\n\n*Products:* ${count}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📦 Browse Products", callback_data: 'store_browse' }],
        [{ text: "👛 Open Wallet", callback_data: 'wallet_menu' }],
        [{ text: "🏠 Main Menu", callback_data: 'menu' }]
      ]
    }
  });
}

function listProducts() {
  const ids = Object.keys(store.products);
  if (ids.length === 0) return "_No products yet._";
  return ids.map(pid => {
    const p = store.products[pid];
    const stock = p.payloads.length;
    return `#${p.id} — *${p.name}* • ${p.priceUSDT} USDT • Stock: ${stock}`;
  }).join('\n');
}

async function renderStoreBrowse(chatId) {
  const text = `📦 *Products*\n\n${listProducts()}`;
  const rows = Object.keys(store.products).map(pid => {
    const p = store.products[pid];
    return [{ text: `${p.name} — ${p.priceUSDT} USDT`, callback_data: `store_view_${p.id}` }];
  });
  await sendOrEditMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        ...rows,
        [{ text: "⬅️ Back", callback_data: 'store_menu' }]
      ]
    }
  });
}

async function renderStoreProduct(chatId, pid) {
  const p = store.products[pid];
  if (!p) {
    return sendOrEditMessage(chatId, `❌ Product not found.`, {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'store_browse' }]] }
    });
  }
  const stock = p.payloads.length;
  await sendOrEditMessage(chatId, `🧩 *${p.name}*\n\nPrice: *${p.priceUSDT} USDT*\nStock: ${stock}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛒 Buy", callback_data: `store_buy_${p.id}` }, { text: "⬅️ Back", callback_data: 'store_browse' }]
      ]
    }
  });
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  ADMIN HELPERS
 * ──────────────────────────────────────────────────────────────────────────────
 */

function isAdmin(chatId) { return chatId.toString() === ADMIN_CHAT_ID.toString(); }

async function renderAdminMenu(chatId) {
  if (!isAdmin(chatId)) {
    await sendOrEditMessage(chatId, "🚫 This section is for admins only.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
    });
    return;
  }
  const totalUsers = Object.keys(referralData).length;
  const totalTx = Object.keys(transactionRecords).length;
  const pending = Object.values(transactionRecords).filter(t => t.status === 'pending').length;

  const dash = `🛠 *Admin Panel*\n\n• Users: *${totalUsers}*\n• Transactions: *${totalTx}*\n• Pending: *${pending}*`;
  await sendOrEditMessage(chatId, dash, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Refresh Stats", callback_data: 'admin_stats' }],
        [{ text: "🧾 Recent Transactions", callback_data: 'admin_recent' }],
        [{ text: "🔎 Find / Update Order", callback_data: 'admin_find' }],
        [{ text: "👛 Wallet: Pending Withdrawals", callback_data: 'admin_w_list' }],
        [{ text: "👛 Wallet: Credit User", callback_data: 'admin_w_credit' }],
        [{ text: "🛍 Store: Manage", callback_data: 'admin_store' }],
        [{ text: "📣 Broadcast Message", callback_data: 'admin_broadcast' }],
        [{ text: "🏠 Main Menu", callback_data: 'menu' }]
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
  const text = `🧾 *Recent Transactions (last 5)*\n\n${getRecentTransactions(5)}`;
  await sendOrEditMessage(chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_menu' }]] }
  });
}

async function renderAdminFindPrompt(chatId) {
  userStates[chatId] = { ...(userStates[chatId] || {}), awaiting: 'admin_find_order' };
  await sendOrEditMessage(chatId, "🔎 *Admin: Find Order*\n\nSend the order number (e.g., `ORD1000123456`).", {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_menu' }]] }
  });
}

async function renderAdminOrderDetail(chatId, orderNumber) {
  const t = findTransactionByOrderNumber(orderNumber);
  if (!t) {
    await sendOrEditMessage(chatId, `❌ Order *${orderNumber}* not found.`, {
      reply_markup: { inline_keyboard: [[{ text: "🔎 Try another", callback_data: 'admin_find' }], [{ text: "⬅️ Back", callback_data: 'admin_menu' }]] }
    });
    return;
  }
  const info = `📦 *Order:* #${t.orderNumber}\n` +
               `*Status:* ${t.status}\n` +
               `*User:* \`${t.userId}\`\n` +
               `*Coin:* ${t.coin} (${t.network}) • *Amount:* ${t.amount}\n` +
               `*Payout:* ${t.fiat} via ${t.paymentMethod}\n` +
               `*Details:* \`${t.paymentDetails}\`\n` +
               `*Txn ID:* ${t.coinpaymentsTxnId}\n` +
               `*Deposit:* \`${t.depositAddress}\`\n` +
               `*Date:* ${new Date(t.timestamp).toLocaleString()}`;
  await sendOrEditMessage(chatId, info, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Mark Paid", callback_data: `admin_mark_paid:${t.orderNumber}` },
         { text: "🎉 Mark Completed", callback_data: `admin_mark_completed:${t.orderNumber}` }],
        [{ text: "🛑 Cancel", callback_data: `admin_mark_canceled:${t.orderNumber}` }],
        [{ text: "⬅️ Back", callback_data: 'admin_menu' }]
      ]
    }
  });
}

function updateOrderStatus(orderNumber, status) {
  const t = transactionRecords[orderNumber];
  if (!t) return false;
  t.status = status;
  return true;
}

async function notifyUserOrderUpdated(orderNumber) {
  const t = transactionRecords[orderNumber];
  if (!t) return;
  try {
    await bot.sendMessage(t.userId, `🔔 *Order Update*\n\n*Order:* #${t.orderNumber}\n*Status:* ${t.status}`, { parse_mode: 'Markdown' });
  } catch {}
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  MAIN MENUS (USER)
 * ──────────────────────────────────────────────────────────────────────────────
 */

async function renderMainMenu(chatId) {
  const dateTime = getCurrentDateTime();
  const name = userStates[chatId]?.firstName || '';
  await sendOrEditMessage(chatId,
`Hey *${name || 'there'}*! 👋

Welcome to your friendly crypto off-ramp.
Sell *BTC, ETH, or USDT* → receive *USD, EUR, or GBP* — fast and simple.

*It’s currently:* _${dateTime}_

Choose an option:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Start selling", callback_data: 'start_sell' }],
        [{ text: "👛 Wallet", callback_data: 'wallet_menu' }, { text: "🛍 Digital Store", callback_data: 'store_menu' }],
        [{ text: "🌐 Translator", callback_data: 'translator' }],
        [{ text: "ℹ️ About & Safety", callback_data: 'show_about' }, { text: "📖 GUIDE / FAQ", callback_data: 'show_help' }],
        [{ text: "🔍 Find Transaction", callback_data: 'find_transaction' }],
        [{ text: "💬 Contact Support", callback_data: 'support_open' }],
        [{ text: "🛠 Admin Panel", callback_data: 'admin_menu' }]
      ]
    }
  });
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
  userStates[chatId] = { ...(userStates[chatId] || {}), firstName };
  clearLastMessage(chatId);

  if (referredBy && referredBy !== chatId.toString()) {
    const referrerIdStr = referredBy.toString();
    if (referralData[referrerIdStr] && !referralData[chatId].referrerId) {
      referralData[chatId].referrerId = referrerIdStr;
      bot.sendMessage(chatId, `🤝 Sweet — you joined with a referral from \`${referrerIdStr}\`! Once you complete your first transaction, they’ll get a reward.`, { parse_mode: 'Markdown' });
    }
  }

  if (isNewUser) {
    const userInfo = `${firstName} ${lastName} (${username})`;
    notifyAdminNewUser(chatId, userInfo, referredBy);
  }

  await renderMainMenu(chatId);
});

bot.onText(/\/help/, async (msg) => sendOrEditMessage(msg.chat.id, ABOUT_TEXT, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } }));
bot.onText(/\/find/, async (msg) => {
  userStates[msg.chat.id] = { ...(userStates[msg.chat.id] || {}), awaiting: 'order_number_search' };
  await sendOrEditMessage(msg.chat.id, "🔎 *Find your order*\n\nPlease enter your order number (e.g., ORD1000123456):", {
    reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
  });
});
bot.onText(/\/support/, async (msg) => {
  const chatId = msg.chat.id;
  if (userStates[chatId]?.awaiting) {
    await sendOrEditMessage(chatId, "⚠️ You’re in the middle of a transaction. Please finish or /start a new one, then contact support.");
    return;
  }
  userStates[chatId] = { ...(userStates[chatId] || {}), awaiting: 'support_message' };
  await sendOrEditMessage(chatId, "💬 *Tell us what you need*\n\nType your question or issue below in one message. A human will reply here soon.", {
    reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
  });
});
bot.onText(/\/admin/, async (msg) => renderAdminMenu(msg.chat.id));
bot.onText(/\/referral/, async (msg) => {
  const chatId = msg.chat.id;
  initializeReferralData(chatId);
  const { balance, referredCount } = referralData[chatId];

  let botUsername = 'Crypto_Seller_Bot';
  try { botUsername = (await bot.getMe()).username; } catch {}
  const referralLink = `https://t.me/${botUsername}?start=${chatId}`;

  const isReadyToWithdraw = balance >= MIN_REFERRAL_WITHDRAWAL_USDT;
  const missingAmount = MIN_REFERRAL_WITHDRAWAL_USDT - balance;

  let withdrawalButton = [];
  if (isReadyToWithdraw) {
    withdrawalButton.push([{ text: `💰 Withdraw ${balance.toFixed(2)} USDT`, callback_data: 'withdraw_referral' }]);
  }

  const message = `
*🤝 Referral Program*

• *Your ID:* \`${chatId}\`  
• *Your Link:* \`${referralLink}\`

• *Balance:* *${balance.toFixed(2)} USDT*  
• *Successful Referrals:* *${referredCount}*  
• *Reward per Referral:* *${REFERRAL_REWARD_USDT.toFixed(1)} USDT*  

*Withdrawal Minimum:* ${MIN_REFERRAL_WITHDRAWAL_USDT} USDT  
${isReadyToWithdraw ? "🎉 You're ready to withdraw!" : `Keep going — you need *${missingAmount.toFixed(2)} USDT* more to withdraw.`}
  `;

  sendOrEditMessage(chatId, message, {
    reply_markup: { inline_keyboard: [...withdrawalButton, [{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
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
    if (data === 'show_about') return await sendOrEditMessage(chatId, ABOUT_TEXT, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    if (data === 'show_help') return await sendOrEditMessage(chatId, ABOUT_TEXT, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    if (data === 'find_transaction') {
      userStates[chatId].awaiting = 'order_number_search';
      return await sendOrEditMessage(chatId, "🔎 *Find your order*\n\nPlease enter your order number (e.g., ORD1000123456):", {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
      });
    }

    // Translator
    if (data === 'translator') return await renderTranslatorMenu(chatId);
    if (data.startsWith('trg_')) {
      const lang = data.split('_')[1]; // de/ru/zh/es/hi
      userStates[chatId].awaiting = `translator_${lang}`;
      return await sendOrEditMessage(chatId, `✍️ Send the text to translate *into* ${lang.toUpperCase()}.`, {
        reply_markup: { inline_keyboard: [[{ text: "🌐 Choose another language", callback_data: 'translator' }], [{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
      });
    }

    // Wallet
    if (data === 'wallet_menu') return await renderWalletMenu(chatId);
    if (data === 'wallet_history') return await renderWalletHistory(chatId);

    if (data === 'wallet_deposit') {
      userStates[chatId].awaiting = 'wallet_deposit_request';
      return await sendOrEditMessage(chatId, `➕ *Deposit Request*\n\nSend a message like:\n\n\`Amount: 50\nNote/Proof: (e.g., TX hash, screenshot link)\``, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'wallet_menu' }]] }
      });
    }

    if (data === 'wallet_withdraw') {
      const w = getWallet(chatId);
      if (w.balance <= 0) {
        return await sendOrEditMessage(chatId, `❌ Your balance is 0. Please request a deposit first.`, {
          reply_markup: { inline_keyboard: [[{ text: "➕ Request Deposit", callback_data: 'wallet_deposit' }], [{ text: "⬅️ Back", callback_data: 'wallet_menu' }]] }
        });
      }
      userStates[chatId].awaiting = 'wallet_withdraw_request';
      return await sendOrEditMessage(chatId, `➖ *Withdraw Request*\n\nSend a message like:\n\n\`Amount: 25\nMethod: (Wise/PayPal/Bank/...)\nDetails: (email/tag/IBAN...)\``, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'wallet_menu' }]] }
      });
    }

    // Store
    if (data === 'store_menu') return await renderStoreMenu(chatId);
    if (data === 'store_browse') return await renderStoreBrowse(chatId);
    if (data.startsWith('store_view_')) {
      const pid = parseInt(data.split('_')[2]);
      return await renderStoreProduct(chatId, pid);
    }
    if (data.startsWith('store_buy_')) {
      const pid = parseInt(data.split('_')[2]);
      const p = store.products[pid];
      if (!p) return await sendOrEditMessage(chatId, `❌ Product not found.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'store_browse' }]] } });
      if (p.payloads.length === 0) return await sendOrEditMessage(chatId, `⛔ Out of stock.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'store_browse' }]] } });

      const w = getWallet(chatId);
      if (w.balance < p.priceUSDT) {
        return await sendOrEditMessage(chatId, `❌ Insufficient balance. Need *${p.priceUSDT} USDT*.\nYour balance: *${w.balance.toFixed(2)} USDT*`, {
          reply_markup: { inline_keyboard: [[{ text: "➕ Request Deposit", callback_data: 'wallet_deposit' }], [{ text: "⬅️ Back", callback_data: 'store_browse' }]] }
        });
      }

      // charge and deliver
      walletDebit(chatId, p.priceUSDT, `purchase:${p.name}`);
      const payload = p.payloads.shift(); // deliver first item
      const orderId = `DST${Date.now().toString().slice(-7)}`;
      store.orders.push({ orderId, userId: chatId, productId: p.id, priceUSDT: p.priceUSDT, deliveredPayload: payload, ts: new Date().toISOString() });

      await sendOrEditMessage(chatId, `✅ *Purchase Successful*\n\n*Item:* ${p.name}\n*Price:* ${p.priceUSDT} USDT\n*Order:* #${orderId}\n\n*Your item:*\n\`\`\`\n${payload}\n\`\`\``, {
        reply_markup: { inline_keyboard: [[{ text: "📦 More Products", callback_data: 'store_browse' }], [{ text: "👛 Wallet", callback_data: 'wallet_menu' }]] }
      });
      return;
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
      if (!ok) return await sendOrEditMessage(chatId, `❌ Could not update order *${orderNumber}*.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_menu' }]] } });
      await notifyUserOrderUpdated(orderNumber);
      return await renderAdminOrderDetail(chatId, orderNumber);
    }

    // Admin: Wallet
    if (data === 'admin_w_list') {
      if (!isAdmin(chatId)) return;
      const list = Object.values(pendingWithdrawals).filter(w => w.status === 'pending');
      if (list.length === 0) {
        return await sendOrEditMessage(chatId, `👛 *Pending Withdrawals*\n\n_None pending._`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_menu' }]] } });
      }
      const rows = list.map(w => [{ text: `#${w.id} — ${w.amount} USDT — ${w.userId}`, callback_data: `admin_w_view:${w.id}` }]);
      return await sendOrEditMessage(chatId, `👛 *Pending Withdrawals*`, { reply_markup: { inline_keyboard: [...rows, [{ text: "⬅️ Back", callback_data: 'admin_menu' }]] } });
    }

    if (data.startsWith('admin_w_view:')) {
      if (!isAdmin(chatId)) return;
      const id = parseInt(data.split(':')[1]);
      const r = pendingWithdrawals[id];
      if (!r) return await sendOrEditMessage(chatId, `❌ Request not found.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_w_list' }]] } });
      const text = `👛 *Withdrawal Request*\n\n#${r.id}\nUser: \`${r.userId}\`\nAmount: *${r.amount} USDT*\nMethod: ${r.method}\nDetails:\n\`${r.details}\`\nStatus: *${r.status}*`;
      return await sendOrEditMessage(chatId, text, {
        reply_markup: { inline_keyboard: [
          [{ text: "✅ Approve", callback_data: `admin_w_approve:${r.id}` }, { text: "🛑 Reject", callback_data: `admin_w_reject:${r.id}` }],
          [{ text: "⬅️ Back", callback_data: 'admin_w_list' }]
        ] }
      });
    }

    if (data.startsWith('admin_w_approve:')) {
      if (!isAdmin(chatId)) return;
      const id = parseInt(data.split(':')[1]);
      const r = pendingWithdrawals[id];
      if (!r || r.status !== 'pending') return;
      // debit user balance (already held? we didn't hold — debit now)
      const w = getWallet(r.userId);
      if (w.balance < r.amount) {
        pendingWithdrawals[id].status = 'failed';
        await bot.sendMessage(r.userId, `❌ Withdrawal #${id} failed due to insufficient balance. (Admin action)`);
      } else {
        walletDebit(r.userId, r.amount, `withdraw:#${id}`);
        pendingWithdrawals[id].status = 'approved';
        await bot.sendMessage(r.userId, `✅ Withdrawal #${id} approved. You will receive funds via *${r.method}*.`);
      }
      return await renderAdminMenu(chatId);
    }

    if (data.startsWith('admin_w_reject:')) {
      if (!isAdmin(chatId)) return;
      const id = parseInt(data.split(':')[1]);
      const r = pendingWithdrawals[id];
      if (!r || r.status !== 'pending') return;
      pendingWithdrawals[id].status = 'rejected';
      await bot.sendMessage(r.userId, `🛑 Withdrawal #${id} was rejected by admin.`);
      return await renderAdminMenu(chatId);
    }

    if (data === 'admin_w_credit') {
      if (!isAdmin(chatId)) return;
      userStates[chatId].awaiting = 'admin_wallet_credit';
      return await sendOrEditMessage(chatId, `👛 *Credit Wallet*\n\nSend a message like:\n\`UserID: 123456\nAmount: 50\nNote: Deposit confirmation\``, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_menu' }]] }
      });
    }

    // Admin: Store manage
    if (data === 'admin_store') {
      if (!isAdmin(chatId)) return;
      const lines = listProducts();
      return await sendOrEditMessage(chatId, `🛍 *Store Manager*\n\n${lines}`, {
        reply_markup: { inline_keyboard: [
          [{ text: "➕ Add Product", callback_data: 'admin_store_add' }],
          [{ text: "📦 Add Stock (Payloads)", callback_data: 'admin_store_stock' }],
          [{ text: "🗑 Remove Product", callback_data: 'admin_store_remove' }],
          [{ text: "⬅️ Back", callback_data: 'admin_menu' }]
        ] }
      });
    }

    if (data === 'admin_store_add') {
      if (!isAdmin(chatId)) return;
      userStates[chatId].awaiting = 'admin_store_add';
      return await sendOrEditMessage(chatId, `➕ *Add Product*\n\nSend a message like:\n\`Name: Netflix Premium\nPriceUSDT: 9.99\``, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_store' }]] }
      });
    }

    if (data === 'admin_store_stock') {
      if (!isAdmin(chatId)) return;
      userStates[chatId].awaiting = 'admin_store_stock';
      return await sendOrEditMessage(chatId, `📦 *Add Stock*\n\nSend a message like:\n\`ProductID: 1\nPayloads:\nCODE-1\nCODE-2\nhttps://download.link/file.zip\``, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_store' }]] }
      });
    }

    if (data === 'admin_store_remove') {
      if (!isAdmin(chatId)) return;
      userStates[chatId].awaiting = 'admin_store_remove';
      return await sendOrEditMessage(chatId, `🗑 *Remove Product*\n\nSend: \`ProductID: <id>\``, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_store' }]] }
      });
    }

    // Selling flow (existing)
    if (data === 'start_sell' || data === 'refresh_rates') {
      await showLoadingMessage(chatId);
      let pricesLine = '';
      try {
        const live = await fetchLiveRates();
        const pUSD = live.USD;
        pricesLine =
          `\n*Rates (approx)*\n` +
          `• 1 BTC ≈ $${(pUSD.BTC ?? 0).toFixed(2)}\n` +
          `• 1 ETH ≈ $${(pUSD.ETH ?? 0).toFixed(2)}\n` +
          `• 1 USDT = $${FIXED_USDT_USD.toFixed(2)}  *(fixed)*\n` +
          `• 1 USDT = €${FIXED_USDT_EUR.toFixed(2)}  *(fixed)*\n` +
          `• 1 USDT = £${FIXED_USDT_GBP.toFixed(2)}  *(fixed)*`;
      } catch (e) {
        pricesLine =
          `\n_Live BTC/ETH unavailable right now._\n` +
          `• 1 USDT = $${FIXED_USDT_USD.toFixed(2)} *(fixed)*\n` +
          `• 1 USDT = €${FIXED_USDT_EUR.toFixed(2)} *(fixed)*\n` +
          `• 1 USDT = £${FIXED_USDT_GBP.toFixed(2)} *(fixed)*`;
      }

      return sendOrEditMessage(chatId,
        `What are you selling today? 😊${pricesLine}`,
        { reply_markup: { inline_keyboard: [
          [{ text: "₿ Bitcoin (BTC)", callback_data: 'coin_BTC' }, { text: "Ξ Ethereum (ETH)", callback_data: 'coin_ETH' }],
          [{ text: "💎 Tether (USDT)", callback_data: 'coin_USDT' }],
          [{ text: "🔄 Refresh rates", callback_data: 'refresh_rates' }],
          [{ text: "🏠 Main Menu", callback_data: 'menu' }]
        ] } }
      );
    }

    if (data === 'cancel') {
      delete userStates[chatId];
      return await sendOrEditMessage(chatId, "No worries! Whenever you’re ready, just send /start to begin again.", {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
      });
    }

    if (data.startsWith('coin_')) {
      const coin = data.split('_')[1];
      userStates[chatId].coin = coin;
      return sendOrEditMessage(chatId, `✅ Great — *${coin}* selected.\n\nWhich currency would you like to receive?`, {
        reply_markup: { inline_keyboard: [
          [{ text: "🇺🇸 USD", callback_data: 'fiat_USD' }, { text: "🇪🇺 EUR", callback_data: 'fiat_EUR' }, { text: "🇬🇧 GBP", callback_data: 'fiat_GBP' }],
          [{ text: "🏠 Main Menu", callback_data: 'menu' }]
        ] }
      });
    }

    if (data.startsWith('fiat_')) {
      await showLoadingMessage(chatId);
      const currency = data.split('_')[1];
      userStates[chatId].fiat = currency;

      const c = userStates[chatId].coin || 'USDT';
      if (c === 'USDT') {
        return sendOrEditMessage(chatId, `✅ *${currency}* selected.\n\nPlease pick your ${c} network:`, {
          reply_markup: { inline_keyboard: [
            [{ text: "TRC20 (Tron)", callback_data: 'net_TRC20' }],
            [{ text: "ERC20 (Ethereum)", callback_data: 'net_ERC20' }],
            [{ text: "🏠 Main Menu", callback_data: 'menu' }]
          ] }
        });
      } else if (c === 'BTC') {
        userStates[chatId].network = 'MAIN';
        userStates[chatId].awaiting = 'amount';
        return sendOrEditMessage(chatId, `✅ BTC (Bitcoin mainnet).\n\nPlease enter the *amount of BTC* to sell.\n\n*Minimum:* $${MIN_USD_EQ}\n*Maximum:* $${MAX_USD_EQ}`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
      } else if (c === 'ETH') {
        userStates[chatId].network = 'MAIN';
        userStates[chatId].awaiting = 'amount';
        return sendOrEditMessage(chatId, `✅ ETH (Ethereum mainnet).\n\nPlease enter the *amount of ETH* to sell.\n\n*Minimum:* $${MIN_USD_EQ}\n*Maximum:* $${MAX_USD_EQ}`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
      }
    }

    if (data.startsWith('net_')) {
      await showLoadingMessage(chatId);
      const net = data.split('_')[1];
      userStates[chatId].network = net;
      userStates[chatId].awaiting = 'amount';
      const coin = userStates[chatId].coin || 'USDT';
      return sendOrEditMessage(chatId, `✅ ${coin} on *${userStates[chatId].network}*.\n\nPlease enter the amount of *${coin}* you want to sell.\n\n*Minimum:* $${MIN_USD_EQ}\n*Maximum:* $${MAX_USD_EQ}`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    }

    if (data.startsWith('pay_')) {
      await showLoadingMessage(chatId);
      const method = data.split('_')[1];
      let prompt = '';

      if (method !== 'bank' && method !== 'skrill') userStates[chatId].paymentMethod = method;

      switch (method) {
        case 'wise':
          prompt = '✅ *Wise Selected*\n\nPlease share your *Wise email* or *@wisetag*:';
          userStates[chatId].awaiting = 'wise_details';
          break;
        case 'revolut':
          prompt = '✅ *Revolut Selected*\n\nPlease share your *Revolut tag* (e.g., @username):';
          userStates[chatId].awaiting = 'revolut_details';
          break;
        case 'paypal':
          prompt = '✅ *PayPal Selected*\n\nPlease share your *PayPal email address*:';
          userStates[chatId].awaiting = 'paypal_details';
          break;
        case 'bank':
          return sendOrEditMessage(chatId, "✅ *Bank Transfer Selected*\n\nPlease choose your bank’s region:", {
            reply_markup: { inline_keyboard: [
              [{ text: "🇪🇺 European Bank", callback_data: 'bank_eu' }],
              [{ text: "🇺🇸 US Bank", callback_data: 'bank_us' }],
              [{ text: "🏠 Main Menu", callback_data: 'menu' }]
            ] }
          });
        case 'skrill':
          return sendOrEditMessage(chatId, "✅ *Skrill/Neteller Selected*\n\nWhich one are you using?", {
            reply_markup: { inline_keyboard: [
              [{ text: "Skrill", callback_data: 'payout_skrill' }],
              [{ text: "Neteller", callback_data: 'payout_neteller' }],
              [{ text: "🏠 Main Menu", callback_data: 'menu' }]
            ] }
          });
        case 'card':
          prompt = '✅ *Card Payment Selected*\n\nPlease share your *Visa or Mastercard number*:';
          userStates[chatId].awaiting = 'card_details';
          break;
        case 'payeer':
          prompt = '✅ *Payeer Selected*\n\nPlease share your *Payeer Number* (e.g., P12345678):';
          userStates[chatId].awaiting = 'payeer_details';
          break;
        case 'alipay':
          prompt = '✅ *Alipay Selected*\n\nPlease share your *Alipay email*:';
          userStates[chatId].awaiting = 'alipay_details';
          break;
      }
      if (prompt) return sendOrEditMessage(chatId, prompt, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    }

    if (data.startsWith('payout_')) {
      await showLoadingMessage(chatId);
      const method = data.split('_')[1];
      userStates[chatId].paymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
      userStates[chatId].awaiting = 'skrill_neteller_details';
      return sendOrEditMessage(chatId, `✅ *${userStates[chatId].paymentMethod} Selected*\n\nPlease share your *${userStates[chatId].paymentMethod} email*:`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    }

    if (data.startsWith('bank_')) {
      await showLoadingMessage(chatId);
      const region = data.split('_')[1];
      userStates[chatId].paymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
      if (region === 'eu') {
        userStates[chatId].awaiting = 'bank_details_eu';
        return sendOrEditMessage(chatId, '✅ *European Bank Transfer*\n\nReply in one message:\n\n`First and Last Name:\nIBAN:\nSwift Code:`', { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
      } else {
        userStates[chatId].awaiting = 'bank_details_us';
        return sendOrEditMessage(chatId, '✅ *US Bank Transfer*\n\nReply in one message:\n\n`Account Holder Name:\nAccount Number:\nRouting Number (ACH or ABA):`', { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
      }
    }

    if (data === 'confirm_transaction') {
      await showLoadingMessage(chatId);
      userStates[chatId].awaiting = null;
      await sendOrEditMessage(chatId, "🔐 Thanks! Creating a secure deposit address for you…", { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
      return generateDepositAddress(chatId);
    }

    if (data === 'edit_transaction') {
      await showLoadingMessage(chatId);
      delete userStates[chatId];
      return sendOrEditMessage(chatId, "No problem — let’s restart. Send /start when you’re ready.", { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    }

    if (data === 'withdraw_referral') {
      await showLoadingMessage(chatId);
      const { balance } = referralData[chatId];
      if (balance < MIN_REFERRAL_WITHDRAWAL_USDT) {
        return sendOrEditMessage(chatId, `❌ Minimum to withdraw is *${MIN_REFERRAL_WITHDRAWAL_USDT} USDT*. Your balance is *${balance.toFixed(2)} USDT*.`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
      }

      userStates[chatId].awaiting = 'referral_withdrawal_payment_selection';
      userStates[chatId].withdrawalAmount = balance;

      const message = `*💰 Withdraw Referral Balance*\n\nBalance to withdraw: *${balance.toFixed(2)} USDT*.\nPick your preferred payout method:`;
      return sendOrEditMessage(chatId, message, {
        reply_markup: { inline_keyboard: [
          [{ text: "Wise", callback_data: 'refpay_wise' }, { text: "Revolut", callback_data: 'refpay_revolut' }],
          [{ text: "PayPal", callback_data: 'refpay_paypal' }, { text: "Bank Transfer", callback_data: 'refpay_bank' }],
          [{ text: "Skrill/Neteller", callback_data: 'refpay_skrill' }, { text: "Visa/Mastercard", callback_data: 'refpay_card' }],
          [{ text: "Payeer", callback_data: 'refpay_payeer' }, { text: "Alipay", callback_data: 'refpay_alipay' }],
          [{ text: "🏠 Main Menu", callback_data: 'menu' }]
        ] }
      });
    }

  } finally {
    bot.answerCallbackQuery(cq.id);
  }
});

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  COINPAYMENTS DEPOSIT ADDRESS (existing sell flow)
 * ──────────────────────────────────────────────────────────────────────────────
 */

async function generateDepositAddress(chatId) {
  const userState = userStates[chatId];
  try {
    const coin = userState.coin || 'USDT';
    const net = userState.network || 'MAIN';

    let coinCurrency;
    if (coin === 'USDT') coinCurrency = COIN_NETWORK_MAP.USDT[net];
    else if (coin === 'BTC') coinCurrency = COIN_NETWORK_MAP.BTC.MAIN;
    else if (coin === 'ETH') coinCurrency = COIN_NETWORK_MAP.ETH.MAIN;
    if (!coinCurrency) throw new Error(`Unsupported coin/network: ${coin} ${net}`);

    const paymentMethodForCustom = userState.paymentMethod || 'Unknown';
    const orderNumber = generateOrderNumber();

    const transactionOptions = {
      currency1: coin,
      currency2: coinCurrency,
      amount: userState.amount,
      buyer_email: BUYER_REFUND_EMAIL,
      custom: `Order: ${orderNumber} | ${coin}/${net} | Payout to ${paymentMethodForCustom}: ${userState.paymentDetails}`,
      item_name: `Sell ${userState.amount} ${coin} for ${userState.fiat}`,
      ipn_url: 'YOUR_IPN_WEBHOOK_URL'
    };

    const result = await coinpayments.createTransaction(transactionOptions);

    storeTransactionRecord(orderNumber, {
      userId: chatId,
      amount: userState.amount,
      fiat: userState.fiat,
      network: userState.network,
      coin,
      paymentMethod: paymentMethodForCustom,
      paymentDetails: userState.paymentDetails,
      coinpaymentsTxnId: result.txn_id,
      depositAddress: result.address,
      timestamp: new Date().toISOString()
    });

    const referrerId = referralData[chatId]?.referrerId;
    if (referrerId && !referralData[chatId].isReferralRewardClaimed) {
      rewardReferrer(referrerId, chatId);
      referralData[chatId].isReferralRewardClaimed = true;
    }

    const depositInfo =
      `✅ *Deposit Address Ready!*\n\n` +
      `*Order Number:* #${orderNumber}\n*Transaction ID:* ${result.txn_id}\n\n` +
      `Please send exactly *${result.amount} ${coin}* (${net}) to:\n\n` +
      `\`${result.address}\`\n\n` +
      `⏳ *Waiting for network confirmations…*\n\n` +
      `*Payout Method:* ${paymentMethodForCustom}\n` +
      `*Payout Details:* \n\`${userState.paymentDetails}\`\n\n` +
      `⚠️ *Important:* Send only ${coin} on the ${net} network to this address. Other assets or networks may result in loss of funds.\n\n` +
      `💡 *Tip:* Save your order number (#${orderNumber}) to check status with \`/find\`.`;

    sendOrEditMessage(chatId, depositInfo, {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    delete userStates[chatId];

  } catch (error) {
    console.error("CoinPayments API Error:", error);
    sendOrEditMessage(chatId, "❌ Sorry — something went wrong while generating your deposit address. Please try again or contact */support*.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
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

  // Ignore commands (handled by command handlers)
  if (text.startsWith('/')) return;

  // Translator input
  if (st.awaiting && st.awaiting.startsWith('translator_')) {
    const lang = st.awaiting.split('_')[1];
    const translated = await translateText(text, lang);
    userStates[chatId].awaiting = null;
    return await sendOrEditMessage(chatId, `🌐 *Translated (${lang.toUpperCase()})*\n\n\`\`\`\n${translated}\n\`\`\``, {
      reply_markup: { inline_keyboard: [[{ text: "🌐 Translate another", callback_data: 'translator' }], [{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
    });
  }

  // Support message from user
  if (st.awaiting === 'support_message') {
    const supportText = text;
    const userInfo = `User ID: ${msg.from.id}, Name: ${msg.from.first_name || ''} ${msg.from.last_name || ''}, Username: @${msg.from.username || 'N/A'}`;
    const forwarded = `*🚨 NEW SUPPORT REQUEST*\n\nFrom: ${userInfo}\n\n*Message:* \n${supportText}\n\n--- \n_Reply to this message to respond to the user._`;
    try {
      const sent = await bot.sendMessage(ADMIN_CHAT_ID, forwarded, { parse_mode: 'Markdown' });
      adminReplyMap[sent.message_id] = chatId;
      await sendOrEditMessage(chatId, "✅ Thanks! Your message is with support. We’ll reply here shortly.", {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
      });
      delete userStates[chatId];
    } catch {
      await sendOrEditMessage(chatId, "❌ Sorry, we couldn’t reach support right now. Please try again later.", {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
      });
    }
    return;
  }

  // Admin — broadcast message
  if (st.awaiting === 'admin_broadcast_message' && isAdmin(chatId)) {
    const recipients = Object.keys(referralData);
    let success = 0, fail = 0;
    for (const uid of recipients) {
      try { await bot.sendMessage(uid, `📣 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' }); success++; } catch { fail++; }
    }
    userStates[chatId].awaiting = null;
    return await sendOrEditMessage(chatId, `✅ Broadcast complete.\nSent: *${success}* | Failed: *${fail}*`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_menu' }]] } });
  }

  // Admin — find order (text input)
  if (st.awaiting === 'admin_find_order' && isAdmin(chatId)) {
    userStates[chatId].awaiting = null;
    const orderNumber = text.trim().toUpperCase();
    return await renderAdminOrderDetail(chatId, orderNumber);
  }

  // Admin — wallet credit input
  if (st.awaiting === 'admin_wallet_credit' && isAdmin(chatId)) {
    // parse "UserID: x\nAmount: y\nNote: z"
    const uid = (text.match(/UserID:\s*([0-9-]+)/i) || [])[1];
    const amt = parseFloat((text.match(/Amount:\s*([0-9.]+)/i) || [])[1] || 'NaN');
    const note = (text.match(/Note:\s*([\s\S]+)/i) || [])[1] || 'admin credit';

    if (!uid || isNaN(amt) || amt <= 0) {
      return await sendOrEditMessage(chatId, `❌ Parse error. Please follow the template:\n\`UserID: 123456\nAmount: 50\nNote: Deposit confirmation\``, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_menu' }]] }
      });
    }
    walletCredit(uid, amt, note.trim());
    userStates[chatId].awaiting = null;
    try { await bot.sendMessage(uid, `👛 *Wallet Credit*\n\n+${amt} USDT — _${note.trim()}_`); } catch {}
    return await sendOrEditMessage(chatId, `✅ Credited *${amt} USDT* to \`${uid}\`.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_menu' }]] } });
  }

  // Admin — store add
  if (st.awaiting === 'admin_store_add' && isAdmin(chatId)) {
    const name = (text.match(/Name:\s*([^\n]+)/i) || [])[1];
    const price = parseFloat((text.match(/PriceUSDT:\s*([0-9.]+)/i) || [])[1] || 'NaN');
    if (!name || isNaN(price) || price <= 0) {
      return await sendOrEditMessage(chatId, `❌ Parse error. Use:\n\`Name: Netflix Premium\nPriceUSDT: 9.99\``, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_store' }]] } });
    }
    const id = store.nextProductId++;
    store.products[id] = { id, name: name.trim(), priceUSDT: Number(price.toFixed(2)), payloads: [], createdAt: new Date().toISOString() };
    userStates[chatId].awaiting = null;
    return await sendOrEditMessage(chatId, `✅ Added product #${id}: *${name.trim()}* — ${price} USDT`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_store' }]] } });
  }

  // Admin — store stock
  if (st.awaiting === 'admin_store_stock' && isAdmin(chatId)) {
    const pid = parseInt((text.match(/ProductID:\s*([0-9]+)/i) || [])[1]);
    const payloadsBlock = (text.match(/Payloads:\s*([\s\S]+)/i) || [])[1];
    if (!pid || !store.products[pid] || !payloadsBlock) {
      return await sendOrEditMessage(chatId, `❌ Parse error. Use:\n\`ProductID: 1\nPayloads:\nCODE-1\nCODE-2\nhttps://link/file.zip\``, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_store' }]] } });
    }
    const items = payloadsBlock.split('\n').map(s => s.trim()).filter(Boolean);
    store.products[pid].payloads.push(...items);
    userStates[chatId].awaiting = null;
    return await sendOrEditMessage(chatId, `✅ Added *${items.length}* payload(s) to product #${pid}.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_store' }]] } });
  }

  // Admin — store remove
  if (st.awaiting === 'admin_store_remove' && isAdmin(chatId)) {
    const pid = parseInt((text.match(/ProductID:\s*([0-9]+)/i) || [])[1]);
    if (!pid || !store.products[pid]) {
      return await sendOrEditMessage(chatId, `❌ Product not found.\nSend: \`ProductID: <id>\``, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_store' }]] } });
    }
    delete store.products[pid];
    userStates[chatId].awaiting = null;
    return await sendOrEditMessage(chatId, `🗑 Removed product #${pid}.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'admin_store' }]] } });
  }

  // User — find order
  if (st.awaiting === 'order_number_search') {
    const orderNumber = text.trim().toUpperCase();
    const t = findTransactionByOrderNumber(orderNumber);
    if (t) {
      const info = `
🔍 *Transaction Found*

*Order Number:* #${t.orderNumber}
*Transaction ID:* ${t.coinpaymentsTxnId}
*Coin:* ${t.coin || 'USDT'}
*Amount:* ${t.amount} ${t.coin || 'USDT'}
*Network:* ${t.network}
*Currency:* ${t.fiat}
*Payment Method:* ${t.paymentMethod}
*Status:* ${t.status}
*Date:* ${new Date(t.timestamp).toLocaleString()}
*Deposit Address:* \`${t.depositAddress}\`
      `;
      await sendOrEditMessage(chatId, info, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    } else {
      await sendOrEditMessage(chatId, `❌ No transaction found with order number *${orderNumber}*.`, {
        reply_markup: { inline_keyboard: [[{ text: "🔄 Try Again", callback_data: 'find_transaction' }], [{ text: "🏠 Main Menu", callback_data: 'menu' }]] }
      });
    }
    delete userStates[chatId];
    return;
  }

  // User — selling flow inputs
  if (st.awaiting === 'amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return sendOrEditMessage(chatId, `❌ That doesn’t look like a valid number. Please enter a positive amount.`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
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
      return sendOrEditMessage(chatId, `❌ Couldn’t fetch pricing for ${coin}. Please try again in a moment.`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    }
    if (usdValue < MIN_USD_EQ || usdValue > MAX_USD_EQ) {
      return sendOrEditMessage(chatId, `❌ Amount out of range.\nYour ${amount} ${coin} ≈ $${usdValue.toFixed(2)}.\nPlease enter an amount worth between $${MIN_USD_EQ} and $${MAX_USD_EQ}.`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: 'menu' }]] } });
    }

    userStates[chatId].amount = amount;

    const fiatToReceive = await calculateFiatLive(coin, amount, st.fiat || 'USD');
    const confirmationMessage = `✅ *Amount confirmed:* ${amount} ${coin}\n\nYou’ll receive approximately *${fiatToReceive.toFixed(2)} ${st.fiat}*.\n\nPlease choose your payout method:`;

    sendOrEditMessage(chatId, confirmationMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Wise", callback_data: 'pay_wise' }, { text: "Revolut", callback_data: 'pay_revolut' }],
          [{ text: "PayPal", callback_data: 'pay_paypal' }, { text: "Bank Transfer", callback_data: 'pay_bank' }],
          [{ text: "Skrill/Neteller", callback_data: 'pay_skrill' }, { text: "Visa/Mastercard", callback_data: 'pay_card' }],
          [{ text: "Payeer", callback_data: 'pay_payeer' }, { text: "Alipay", callback_data: 'pay_alipay' }],
          [{ text: "🏠 Main Menu", callback_data: 'menu' }]
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
    const reviewMessage = await formatPaymentDetailsLive(userStates[chatId], orderNumber);

    return sendOrEditMessage(chatId, reviewMessage, {
      reply_markup: { inline_keyboard: [
        [{ text: "✅ Continue & Generate Address", callback_data: 'confirm_transaction' }],
        [{ text: "✏️ Edit Payment Details", callback_data: 'edit_transaction' }],
        [{ text: "🏠 Main Menu", callback_data: 'menu' }]
      ] }
    });
  }

  // Wallet — deposit request text
  if (st.awaiting === 'wallet_deposit_request') {
    // Notify admin to credit manually
    const note = text;
    await bot.sendMessage(ADMIN_CHAT_ID, `➕ *Deposit Request*\n\nUser: \`${chatId}\`\n\n${note}`, { parse_mode: 'Markdown' });
    userStates[chatId].awaiting = null;
    return await sendOrEditMessage(chatId, `✅ Deposit request sent. Admin will review and credit your wallet once confirmed.`, {
      reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: 'wallet_menu' }]] }
    });
  }

  // Wallet — withdraw request text
  if (st.awaiting === 'wallet_withdraw_request') {
    // Parse minimal: Amount / Method / Details
    const amt = parseFloat((text.match(/Amount:\s*([0-9.]+)/i) || [])[1] || 'NaN');
    const method = (text.match(/Method:\s*([^\n]+)/i) || [])[1];
    const details = (text.match(/Details:\s*([\s\S]+)/i) || [])[1] || '';

    const w = getWallet(chatId);
    if (isNaN(amt) || amt <= 0 || !method) {
      return await sendOrEditMessage(chatId, `❌ Parse error.\nUse:\n\`Amount: 25\nMethod: Wise\nDetails: your@wise.com\``, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'wallet_menu' }]] } });
    }
    if (w.balance < amt) {
      return await sendOrEditMessage(chatId, `❌ Insufficient balance. You have *${w.balance.toFixed(2)} USDT*.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: 'wallet_menu' }]] } });
    }
    // Create pending request; do NOT debit yet, only on approval
    const id = nextWithdrawalId++;
    pendingWithdrawals[id] = { id, userId: chatId, amount: Number(amt.toFixed(2)), method: method.trim(), details: details.trim(), status: 'pending', ts: new Date().toISOString() };
    userStates[chatId].awaiting = null;

    await bot.sendMessage(ADMIN_CHAT_ID, `➖ *Withdrawal Request*\n\n#${id}\nUser: \`${chatId}\`\nAmount: *${amt} USDT*\nMethod: ${method}\nDetails:\n\`${details}\``, { parse_mode: 'Markdown' });

    return await sendOrEditMessage(chatId, `✅ Withdrawal request created: #${id}\n\nAdmin will review and process it.`, {
      reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: 'wallet_menu' }]] }
    });
  }

  // Admin — referral withdrawal inputs handled earlier
});

console.log("Bot is running…");
