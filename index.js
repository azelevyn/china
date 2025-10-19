require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Coinpayments = require('coinpayments');

const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.error('Set TELEGRAM_TOKEN in .env');
  process.exit(1);
}
const bot = new TelegramBot(TOKEN, { polling: true });

// CoinPayments client
const cpClient = new Coinpayments({
  key: process.env.COINPAYMENTS_PUBLIC,
  secret: process.env.COINPAYMENTS_PRIVATE
});

// In-memory state per user (for demo). Use DB in production.
const state = {};

/*
  Flow:
  /start -> greet -> ask: Sell USDT? [YES] [NO]
  YES -> ask how much USDT -> ask fiat (USD/EUR/GBP) -> ask network (BEP20/TRC20/ERC20)
         -> ask payment method -> ask payment details -> create coinpayments tx -> show address/invoice
*/

const RATES_TEXT = `Rate:
USD TO EUR = 0.89 EUR
USDT TO GBP = 0.77 GBP
USD TO USDT = 1.08`;

function startSellFlow(chatId, user) {
  state[chatId] = { step: 'ask_amount', user };
  bot.sendMessage(chatId, `${RATES_TEXT}\n\nBerapa banyak USDT yang anda ingin jual? (contoh: 100)`);
}

function askFiat(chatId) {
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'USD', callback_data: 'FIAT_USD' }, { text: 'EUR', callback_data: 'FIAT_EUR' }, { text: 'GBP', callback_data: 'FIAT_GBP' }]
      ]
    }
  };
  state[chatId].step = 'ask_fiat';
  bot.sendMessage(chatId, 'Anda mahu terima dalam fiat mana?', opts);
}

function askNetwork(chatId) {
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'USDT BEP20', callback_data: 'NET_BEP20' }],
        [{ text: 'USDT TRC20', callback_data: 'NET_TRC20' }],
        [{ text: 'USDT ERC20', callback_data: 'NET_ERC20' }]
      ]
    }
  };
  state[chatId].step = 'ask_network';
  bot.sendMessage(chatId, 'Pilih rangkaian untuk deposit USDT:', opts);
}

function askPaymentMethod(chatId) {
  const rows = [
    [{ text: 'Wise', callback_data: 'PM_Wise' }, { text: 'Revolut', callback_data: 'PM_Revolut' }],
    [{ text: 'PayPal', callback_data: 'PM_PayPal' }, { text: 'Bank Transfer', callback_data: 'PM_Bank' }],
    [{ text: 'Skrill/Neteller', callback_data: 'PM_Skrill' }, { text: 'Visa/Mastercard', callback_data: 'PM_Card' }],
    [{ text: 'Payeer', callback_data: 'PM_Payeer' }, { text: 'Alipay', callback_data: 'PM_Alipay' }]
  ];
  state[chatId].step = 'ask_payment_method';
  bot.sendMessage(chatId, 'Pilih kaedah pembayaran pilihan anda:', { reply_markup: { inline_keyboard: rows } });
}

function createCoinpaymentsTx(chatId) {
  const s = state[chatId];
  // Safety checks
  if (!s || !s.amount_usdt || !s.network || !s.fiat_currency) {
    return bot.sendMessage(chatId, 'Maklumat tidak lengkap. Sila mula semula dengan /start.');
  }

  // Map selected network to CoinPayments currency codes.
  // NOTE: Sesuaikan kod ini jika CoinPayments anda menggunakan code yang berbeza (contoh: 'USDT.TRC20' / 'USDT.ERC20' / 'USDT.BEP20')
  const networkMap = {
    BEP20: 'USDT.BEP20',   // contoh label; sila semak dashboard CoinPayments anda
    TRC20: 'USDT.TRC20',
    ERC20: 'USDT.ERC20'
  };
  const currency2 = networkMap[s.network];
  if (!currency2) {
    return bot.sendMessage(chatId, 'Rangkaian tidak disokong. Sila hubungi admin.');
  }

  // Ask user amount in USDT already captured in s.amount_usdt
  // We'll create a transaction where currency1 is USD (or chosen fiat) and currency2 is USDT variant.
  // To compute fiat amount: USD_TO_USDT = 1.08 (given). We assume user provided amount in USDT, so convert to USD if fiat = USD.
  // Simple conversion: fiatAmount = amount_usdt * priceUsdPerUsdt
  const USD_PER_USDT = 1.08; // from your rate: USD TO USDT = 1.08 (i.e. 1 USDT = 1.08 USD)
  let fiatAmountUSD = parseFloat(s.amount_usdt) * USD_PER_USDT;
  let currency1 = 'USD';
  if (s.fiat_currency === 'EUR') {
    // USD -> EUR = 0.89
    fiatAmountUSD = fiatAmountUSD * 0.89; // This is approximate: apply USD->EUR
    currency1 = 'EUR';
  } else if (s.fiat_currency === 'GBP') {
    // Use USDT TO GBP = 0.77 (we interpret as 1 USDT = 0.77 GBP)
    currency1 = 'GBP';
    fiatAmountUSD = parseFloat(s.amount_usdt) * 0.77;
  } else {
    currency1 = 'USD';
    fiatAmountUSD = parseFloat(s.amount_usdt) * USD_PER_USDT;
  }

  // Round fiat amount
  fiatAmountUSD = Math.round((fiatAmountUSD + Number.EPSILON) * 100) / 100;

  bot.sendMessage(chatId, `Mencipta invoice di CoinPayments...\nAnda akan menerima ≈ ${fiatAmountUSD} ${currency1} (bergantung pengesahan & fees). Mohon tunggu...`);

  // createTransaction: create checkout where buyer pays in USDT (currency2) for fiat amount currency1
  // Perhatikan: parameter currency2 harus sesuai kod CoinPayments (USDT.TRC20 / USDT.ERC20 / ...).
  // Sila semak kod di dashboard CoinPayments jika berlaku error.
  const createParams = {
    currency1: currency1,         // fiat currency we charge (USD/EUR/GBP)
    currency2: currency2,         // what buyer pays in (USDT on selected network)
    amount: fiatAmountUSD,        // amount in currency1
    buyer_email: s.payment_email || undefined,
    invoice: `sell-usdt-${chatId}-${Date.now()}`,
    // optional: 'ipn_url' to receive webhook updates
  };

  cpClient.createTransaction(createParams, (err, tx) => {
    if (err) {
      console.error('CoinPayments error:', err);
      return bot.sendMessage(chatId, `Gagal mencipta transaksi CoinPayments: ${err.message || JSON.stringify(err)}`);
    }
    // tx contains address, amount, confirms_needed, timeout, status_url, qrcode_url, etc.
    s.coinpayments_tx = tx;
    const msg = [
      `Invoice created!`,
      `Please send EXACTLY: ${tx.amount} ${tx.coin} (${tx.address})`,
      `Status page: ${tx.status_url}`,
      `QR: ${tx.qrcode_url || 'N/A'}`
    ].join('\n\n');

    bot.sendMessage(chatId, msg);
    // show admin contact / next steps
    bot.sendMessage(chatId, `Setelah anda hantar USDT ke alamat di atas, sistem akan mengesan pembayaran. Untuk sebarang kekeliruan hubungi admin.`);
  });
}

// Start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const first = msg.from.first_name || '';
  const last = msg.from.last_name || '';
  const greeting = `Hello ${first} ${last},`;
  state[chatId] = { step: 'idle', user: msg.from };

  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'YES', callback_data: 'SELL_YES' }, { text: 'NO', callback_data: 'SELL_NO' }]
      ]
    }
  };
  bot.sendMessage(chatId, `${greeting}\n\nKami membantu anda jual USDT.\nMahu jual USDT sekarang?`, opts);
});

// Inline button handlers
bot.on('callback_query', (callbackQuery) => {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;

  // ensure state exists
  if (!state[chatId]) state[chatId] = { step: 'idle', user: callbackQuery.from };

  if (data === 'SELL_YES') {
    bot.answerCallbackQuery(callbackQuery.id);
    startSellFlow(chatId, callbackQuery.from);
    return;
  }
  if (data === 'SELL_NO') {
    bot.answerCallbackQuery(callbackQuery.id, { text: 'Baik — boleh mulakan semula bila-bila masa.' });
    return;
  }

  // fiat selection
  if (data.startsWith('FIAT_')) {
    bot.answerCallbackQuery(callbackQuery.id);
    const fiat = data.split('_')[1];
    state[chatId].fiat_currency = fiat;
    bot.sendMessage(chatId, `Anda pilih ${fiat}.`);
    askNetwork(chatId);
    return;
  }

  // network selection
  if (data.startsWith('NET_')) {
    bot.answerCallbackQuery(callbackQuery.id);
    const net = data.split('_')[1]; // BEP20/TRC20/ERC20
    state[chatId].network = net;
    bot.sendMessage(chatId, `Rangkaian dipilih: ${net}`);
    askPaymentMethod(chatId);
    return;
  }

  // payment method selection
  if (data.startsWith('PM_')) {
    bot.answerCallbackQuery(callbackQuery.id);
    const pm = data.split('_')[1];
    state[chatId].payment_method = pm;
    state[chatId].step = 'ask_payment_details';
    bot.sendMessage(chatId, `Anda pilih ${pm}. Sila hantarkan butiran pembayaran (contoh: email/payee name/IBAN/URL PayPal):`);
    return;
  }

  bot.answerCallbackQuery(callbackQuery.id, { text: 'Pilihan tidak dikenali.' });
});

// Text message handler to collect inputs for stateful steps
bot.on('message', (msg) => {
  // ignore messages that are callbacks already handled
  if (msg.text && msg.text.startsWith('/')) return; // ignore commands here (except /start handled above)

  const chatId = msg.chat.id;
  if (!state[chatId]) return; // no flow

  const s = state[chatId];
  if (s.step === 'ask_amount') {
    // parse amount
    const val = msg.text.replace(/[^0-9.]/g, '');
    const amount = parseFloat(val);
    if (!amount || amount <= 0) {
      return bot.sendMessage(chatId, 'Sila masukkan jumlah USDT yang sah. Contoh: 100');
    }
    s.amount_usdt = amount;
    s.step = 'amount_received';
    bot.sendMessage(chatId, `Anda mahu jual ${amount} USDT.`);
    askFiat(chatId);
    return;
  }

  if (s.step === 'ask_payment_details') {
    s.payment_details = msg.text;
    // optional: capture email if text looks like an email
    const emailMatch = msg.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);
    if (emailMatch) s.payment_email = emailMatch[0];

    // All data collected, create coinpayments tx
    s.step = 'creating_tx';
    bot.sendMessage(chatId, 'Terima kasih — mencipta invoice CoinPayments sekarang...');
    createCoinpaymentsTx(chatId);
    return;
  }
});
