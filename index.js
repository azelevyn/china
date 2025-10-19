/**
 * USDT Sell Telegram Bot
 *
 * Requirements:
 * - Node.js 16+
 * - npm install telegraf coinpayments dotenv
 *
 * Run:
 * 1. copy .env.example -> .env and set TELEGRAM_BOT_TOKEN
 * 2. npm install telegraf coinpayments dotenv
 * 3. node index.js
 *
 * Notes:
 * - This uses in-memory sessions for simplicity. Use a DB in production.
 * - Add IPN handling for automatic confirmation (CoinPayments IPN).
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const CoinPayments = require('coinpayments');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error('Please set TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

// Use environment keys if present, otherwise fallback to provided creds (from your earlier message)
const COINPAYMENTS_PUBLIC_KEY = process.env.COINPAYMENTS_PUBLIC_KEY || '7b4eaa9e7643e8f59a104ddc12062ac16d653de6e5cbffd1ea408cd9f2f8e3d7';
const COINPAYMENTS_PRIVATE_KEY = process.env.COINPAYMENTS_PRIVATE_KEY || '3fb100ea69a1d9dC600237dbb65A48df3479ec426056aC61D93Feb55c258D6cC';
const COINPAYMENTS_MERCHANT_ID = process.env.COINPAYMENTS_MERCHANT_ID || '431eb6f352649dfdcde42b2ba8d5b6d8';

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const cpClient = new CoinPayments({
  key: COINPAYMENTS_PUBLIC_KEY,
  secret: COINPAYMENTS_PRIVATE_KEY
});

// In-memory session storage (small demo). Replace with DB for production.
const sessions = {};
function session(ctx) {
  const id = ctx.from.id;
  if (!sessions[id]) sessions[id] = { step: null, data: {} };
  return sessions[id];
}

/* ---------- Rates (based on your provided rates) ---------- */
const RATES = {
  USD_TO_EUR: 0.89,   // 1 USD = 0.89 EUR
  USD_TO_USDT: 1.08,  // 1 USD = 1.08 USDT
  USDT_TO_GBP: 0.77   // 1 USDT = 0.77 GBP  (used to approximate USD<->GBP)
};

function fiatToUsd(amount, fiat) {
  fiat = (fiat || 'USD').toUpperCase();
  if (fiat === 'USD') return amount;
  if (fiat === 'EUR') {
    // 1 EUR = 1 / 0.89 USD
    return amount / RATES.USD_TO_EUR;
  }
  if (fiat === 'GBP') {
    // derive USD per GBP using provided chain:
    // 1 USD = 1.08 USDT, 1 USDT = 0.77 GBP => 1 USD = 1.08 * 0.77 GBP = 0.8316 GBP
    // => 1 GBP = 1 / 0.8316 USD
    const usdPerGbp = 1 / (RATES.USD_TO_USDT * RATES.USDT_TO_GBP);
    return amount * usdPerGbp;
  }
  return amount;
}

function usdToUsdt(usd) {
  return usd * RATES.USD_TO_USDT;
}

function networkToCoinpaymentsCurrency(networkChoice) {
  const n = (networkChoice || '').toUpperCase();
  if (n.includes('TRC')) return 'USDT.TRC20';
  if (n.includes('BEP')) return 'USDT.BEP20';
  if (n.includes('ERC')) return 'USDT.ERC20';
  return 'USDT.TRC20';
}

/* ---------- Bot Flow ---------- */

// Start / Intro
bot.start(async (ctx) => {
  const s = session(ctx);
  s.step = 'intro';
  s.data = {};

  const first = ctx.from.first_name || '';
  const last = ctx.from.last_name || '';
  const name = `${first} ${last}`.trim();

  const intro = `👋 Hello ${name}!\n\n` +
    `Welcome to the *USDT Sell Bot*.\n\n` +
    `This bot helps you generate a deposit address (via CoinPayments) so buyers can send USDT to you. ` +
    `After the deposit is confirmed, you will be paid the fiat amount you requested by your chosen payout method.\n\n` +
    `Do you want to sell USDT now?`;

  await ctx.replyWithMarkdown(intro, Markup.inlineKeyboard([
    [Markup.button.callback('✅ YES', 'SELL_YES'), Markup.button.callback('❌ NO', 'SELL_NO')]
  ]));
});

bot.action('SELL_NO', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Okay — if you change your mind, send /start anytime.');
});

bot.action('SELL_YES', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  s.step = 'choose_fiat';
  await ctx.reply('Which fiat currency would you like to receive?', Markup.inlineKeyboard([
    [Markup.button.callback('USD', 'FIAT_USD'), Markup.button.callback('EUR', 'FIAT_EUR'), Markup.button.callback('GBP', 'FIAT_GBP')]
  ]));
});

// Fiat selection
bot.action(/FIAT_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const fiat = ctx.match[0].split('_')[1];
  s.data.fiat = fiat;
  s.step = 'choose_network';
  await ctx.reply(`You selected *${fiat}*. Now select the USDT network for deposit:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('USDT TRC20', 'NET_TRC20')],
    [Markup.button.callback('USDT BEP20', 'NET_BEP20')],
    [Markup.button.callback('USDT ERC20', 'NET_ERC20')]
  ])});
});

// Network selection
bot.action(/NET_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const net = ctx.match[0].split('_')[1];
  s.data.network = net;
  s.step = 'choose_method';
  await ctx.reply('Choose your payout method:', Markup.inlineKeyboard([
    [Markup.button.callback('Wise', 'PAY_WISE'), Markup.button.callback('Revolut', 'PAY_REVOLUT')],
    [Markup.button.callback('PayPal', 'PAY_PAYPAL'), Markup.button.callback('Bank Transfer', 'PAY_BANK')],
    [Markup.button.callback('Skrill/Neteller', 'PAY_SKRILL')],
    [Markup.button.callback('Visa/Mastercard', 'PAY_CARD')],
    [Markup.button.callback('Payeer', 'PAY_PAYEER'), Markup.button.callback('Alipay', 'PAY_ALIPAY')]
  ]));
});

// Payment method chosen -> ask for specific details per method
bot.action(/PAY_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const method = ctx.match[0].split('_')[1];
  s.data.payment_method = method;
  s.step = 'collect_payment_details';

  let prompt = '';
  switch (method) {
    case 'WISE':
      prompt = 'Please enter your Wise email or Wise tag (e.g. user@example.com or @username).';
      break;
    case 'REVOLUT':
      prompt = 'Please enter your Revolut tag (e.g. @revtag).';
      break;
    case 'PAYPAL':
      prompt = 'Please enter your PayPal email (e.g. user@example.com).';
      break;
    case 'BANK':
      prompt = 'Please provide bank transfer details in this format:\n\nFull Name:\nIBAN:\nSWIFT/BIC:';
      break;
    case 'SKRILL':
      prompt = 'Please enter your Skrill or Neteller email (e.g. user@example.com).';
      break;
    case 'CARD':
      prompt = 'Please enter your card number (Visa/Mastercard). Only numbers, no spaces or dashes.';
      break;
    case 'PAYEER':
      prompt = 'Please enter your Payeer account number (e.g. P1234567).';
      break;
    case 'ALIPAY':
      prompt = 'Please enter your Alipay email or account ID.';
      break;
    default:
      prompt = 'Please provide your payout details.';
  }

  await ctx.reply(prompt);
});

// Receive free text (payment details or amount)
bot.on('text', async (ctx, next) => {
  const s = session(ctx);
  const text = ctx.message.text.trim();

  if (s.step === 'collect_payment_details') {
    // Basic validations depending on method (light-touch)
    const method = s.data.payment_method || '';
    let valid = true;
    let normalized = text;

    if (method === 'CARD') {
      // remove non-digits
      const digits = text.replace(/\D/g, '');
      if (digits.length < 12 || digits.length > 19) {
        valid = false;
      } else normalized = digits;
    }

    if (method === 'BANK') {
      // expecting at least 3 lines: name, IBAN, SWIFT
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length < 3) valid = false;
    }

    if (!valid) {
      await ctx.reply('The details you provided look invalid for the selected payout method. Please re-enter correctly.');
      return;
    }

    s.data.payment_details = normalized;
    s.step = 'ask_amount';
    await ctx.reply(`Got it ✅\nNow enter the amount of *${s.data.fiat}* you want to receive (numbers only, e.g. 150).`, { parse_mode: 'Markdown' });
    return;
  }

  if (s.step === 'ask_amount') {
    // Accept numeric input
    // remove commas and other non-digit except dot
    const cleaned = text.replace(/,/g, '').replace(/[^\d.]/g,'');
    const amount = parseFloat(cleaned);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('Please enter a valid numeric amount (e.g. 100 or 250.50).');
      return;
    }

    s.data.fiat_amount = amount;

    // estimate USDT required
    const usdEquivalent = fiatToUsd(amount, s.data.fiat);
    const estimatedUsdt = usdToUsdt(usdEquivalent);
    s.data.usdt_required_est = Number(estimatedUsdt.toFixed(6));

    s.step = 'confirm_create_tx';

    const summary =
      `📄 *Order Summary*\n\n` +
      `Fiat to receive: *${amount} ${s.data.fiat}*\n` +
      `Payout method: *${s.data.payment_method}*\n` +
      `Payout details: \`${s.data.payment_details}\`\n` +
      `Network: *USDT ${s.data.network}*\n` +
      `Estimated USDT required (buyer): *${s.data.usdt_required_est} USDT*\n\n` +
      `Do you want to generate a deposit address now?`;

    await ctx.replyWithMarkdown(summary, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Generate deposit', 'CREATE_TX'), Markup.button.callback('❌ Cancel', 'CANCEL_TX')]
    ]));
    return;
  }

  // fallback - not in a flow
  return next();
});

// Cancel
bot.action('CANCEL_TX', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  s.step = null;
  s.data = {};
  await ctx.reply('Transaction cancelled. Send /start to begin again.');
});

// CREATE transaction on CoinPayments
bot.action('CREATE_TX', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);

  if (!s.data || !s.data.fiat_amount) {
    await ctx.reply('No active sell request found. Start again with /start.');
    return;
  }

  // Convert fiat -> USD value (CoinPayments expects fiat amount in currency1)
  const usdAmount = fiatToUsd(s.data.fiat_amount, s.data.fiat);
  const currency1 = 'USD';
  const currency2 = networkToCoinpaymentsCurrency(s.data.network);

  try {
    await ctx.reply('Creating CoinPayments transaction... 🔄');

    const opts = {
      amount: Number(usdAmount.toFixed(6)),
      currency1,
      currency2,
      buyer_email: ctx.from.username ? `${ctx.from.username}@telegram` : `${ctx.from.id}@telegram`,
      item_name: `Sell USDT -> ${s.data.fiat} (${s.data.payment_method})`
    };

    // createTransaction uses a callback interface
    cpClient.createTransaction(opts, async (err, tx) => {
      if (err) {
        console.error('CoinPayments createTransaction error:', err);
        await ctx.reply('Failed to create CoinPayments transaction: ' + (err.message || JSON.stringify(err)));
        return;
      }

      // store tx in session for later reference
      s.data.tx = tx;
      s.step = 'awaiting_payment';

      // tx fields: amount, coin, address, confirms_needed, qrcode_url, status_url, etc.
      const msg =
        `✅ *Transaction Created!*\n\n` +
        `Please send exactly *${tx.amount} ${tx.coin}* to the address below:\n\n` +
        `${tx.address || '(address shown on status page)'}\n\n` +
        `Confirmations needed: *${tx.confirms_needed}*\n\n` +
        `Open the payment page for more details. After confirmation, your payout will be processed.`;

      await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
        [Markup.button.url('🔗 Open payment page', tx.status_url)]
      ]));
    });

  } catch (e) {
    console.error('Error creating transaction:', e);
    await ctx.reply('Unexpected error: ' + (e.message || e.toString()));
  }
});

// If user types anything else outside flow
bot.on('message', async (ctx) => {
  const s = session(ctx);
  if (!s.step) {
    await ctx.reply('Send /start to begin selling USDT.');
  }
});

// Launch
bot.launch().then(() => console.log('USDT Sell Bot started'));

// graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
