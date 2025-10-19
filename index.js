/**
 * USDT Sell Telegram Bot (CoinPayments Integration)
 * -----------------------------------------------
 * Features:
 * ✅ Intro & guided conversation
 * ✅ Choose fiat (USD, EUR, GBP)
 * ✅ Choose network (TRC20, BEP20, ERC20)
 * ✅ Choose payout method (Wise, Revolut, etc.)
 * ✅ Collect payout details
 * ✅ Create CoinPayments transaction for deposit
 *
 * Run:
 * 1️⃣ npm install telegraf coinpayments dotenv
 * 2️⃣ Add .env with TELEGRAM_BOT_TOKEN
 * 3️⃣ node index.js
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const CoinPayments = require('coinpayments');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ Please set TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

// CoinPayments API Keys
const cpClient = new CoinPayments({
  key: '7b4eaa9e7643e8f59a104ddc12062ac16d653de6e5cbffd1ea408cd9f2f8e3d7',
  secret: '3fb100ea69a1d9dC600237dbb65A48df3479ec426056aC61D93Feb55c258D6cC'
});

// Simple in-memory session
const sessions = {};
function session(ctx) {
  const id = ctx.from.id;
  if (!sessions[id]) sessions[id] = { step: null, data: {} };
  return sessions[id];
}

// Conversion rates
const RATES = {
  USD_TO_EUR: 0.89,
  USD_TO_USDT: 1.08,
  USDT_TO_GBP: 0.77
};

function fiatToUsd(amount, fiat) {
  fiat = fiat.toUpperCase();
  if (fiat === 'USD') return amount;
  if (fiat === 'EUR') return amount / RATES.USD_TO_EUR;
  if (fiat === 'GBP') {
    const usdPerGbp = 1 / (RATES.USD_TO_USDT * RATES.USDT_TO_GBP);
    return amount * usdPerGbp;
  }
  return amount;
}
function usdToUsdt(usd) {
  return usd * RATES.USD_TO_USDT;
}
function networkToCoinpaymentsCurrency(net) {
  net = net.toUpperCase();
  if (net.includes('TRC')) return 'USDT.TRC20';
  if (net.includes('BEP')) return 'USDT.BEP20';
  if (net.includes('ERC')) return 'USDT.ERC20';
  return 'USDT.TRC20';
}

// Initialize bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

/* 🟢 INTRO */
bot.start(async (ctx) => {
  const s = session(ctx);
  s.step = 'intro';
  s.data = {};

  const first = ctx.from.first_name || '';
  const last = ctx.from.last_name || '';
  const name = `${first} ${last}`.trim();

  const intro = `👋 Hello ${name}!\n\n` +
    `Welcome to the *USDT Sell Bot*.\n\n` +
    `This bot allows you to *sell your USDT* and receive fiat through your preferred payment method.\n\n` +
    `Do you want to sell USDT now?`;

  await ctx.replyWithMarkdown(intro, Markup.inlineKeyboard([
    [Markup.button.callback('✅ YES', 'SELL_YES'), Markup.button.callback('❌ NO', 'SELL_NO')]
  ]));
});

bot.action('SELL_NO', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Okay! You can come back anytime by sending /start.');
});

bot.action('SELL_YES', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  s.step = 'choose_fiat';
  await ctx.reply('Which fiat currency would you like to receive?', Markup.inlineKeyboard([
    [Markup.button.callback('USD', 'FIAT_USD'), Markup.button.callback('EUR', 'FIAT_EUR'), Markup.button.callback('GBP', 'FIAT_GBP')]
  ]));
});

// Choose fiat
bot.action(/FIAT_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const fiat = ctx.match[0].split('_')[1];
  s.data.fiat = fiat;
  s.step = 'choose_network';
  await ctx.reply(`You selected *${fiat}*.\n\nNow select the deposit network:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('USDT TRC20', 'NET_TRC20')],
    [Markup.button.callback('USDT BEP20', 'NET_BEP20')],
    [Markup.button.callback('USDT ERC20', 'NET_ERC20')]
  ])});
});

// Choose network
bot.action(/NET_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const net = ctx.match[0].split('_')[1];
  s.data.network = net;
  s.step = 'choose_method';
  await ctx.reply('Select your preferred payment method:', Markup.inlineKeyboard([
    [Markup.button.callback('Wise', 'PAY_WISE'), Markup.button.callback('Revolut', 'PAY_REVOLUT')],
    [Markup.button.callback('PayPal', 'PAY_PAYPAL'), Markup.button.callback('Bank Transfer', 'PAY_BANK')],
    [Markup.button.callback('Skrill/Neteller', 'PAY_SKRILL')],
    [Markup.button.callback('Visa/Mastercard', 'PAY_CARD')],
    [Markup.button.callback('Payeer', 'PAY_PAYEER'), Markup.button.callback('Alipay', 'PAY_ALIPAY')]
  ]));
});

// Choose payout method
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
      prompt = 'Please enter your PayPal email.';
      break;
    case 'BANK':
      prompt = 'Please provide:\nFull Name:\nIBAN:\nSWIFT/BIC:';
      break;
    case 'SKRILL':
      prompt = 'Please enter your Skrill/Neteller email.';
      break;
    case 'CARD':
      prompt = 'Please enter your card number (Visa/Mastercard).';
      break;
    case 'PAYEER':
      prompt = 'Please enter your Payeer Number (e.g. P1234567).';
      break;
    case 'ALIPAY':
      prompt = 'Please enter your Alipay email.';
      break;
    default:
      prompt = 'Please enter your payout details.';
  }
  await ctx.reply(prompt);
});

// Collect details or amount
bot.on('text', async (ctx, next) => {
  const s = session(ctx);
  const text = ctx.message.text.trim();

  if (s.step === 'collect_payment_details') {
    s.data.payment_details = text;
    s.step = 'ask_amount';
    await ctx.reply(`✅ Got it.\nNow enter the amount of *${s.data.fiat}* you want to receive:`, { parse_mode: 'Markdown' });
    return;
  }

  if (s.step === 'ask_amount') {
    const amount = parseFloat(text.replace(/,/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('Please enter a valid amount (numbers only).');
      return;
    }

    s.data.fiat_amount = amount;
    const usdEquivalent = fiatToUsd(amount, s.data.fiat);
    const estimatedUsdt = usdToUsdt(usdEquivalent);
    s.data.usdt_required_est = Number(estimatedUsdt.toFixed(6));

    s.step = 'confirm_create_tx';

    const summary =
      `📋 *Order Summary*\n\n` +
      `Fiat: *${amount} ${s.data.fiat}*\n` +
      `Payment: *${s.data.payment_method}*\n` +
      `Details: \`${s.data.payment_details}\`\n` +
      `Network: *USDT ${s.data.network}*\n` +
      `Estimated deposit: *${s.data.usdt_required_est} USDT*\n\n` +
      `Generate a deposit address now?`;

    await ctx.replyWithMarkdown(summary, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Generate', 'CREATE_TX'), Markup.button.callback('❌ Cancel', 'CANCEL_TX')]
    ]));
    return;
  }

  return next();
});

// Cancel
bot.action('CANCEL_TX', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  s.step = null;
  s.data = {};
  await ctx.reply('❌ Transaction cancelled. Send /start to begin again.');
});

// ✅ Create CoinPayments transaction
bot.action('CREATE_TX', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);

  if (!s.data || !s.data.fiat_amount) {
    await ctx.reply('No active sell request. Send /start.');
    return;
  }

  const usdAmount = fiatToUsd(s.data.fiat_amount, s.data.fiat);
  const currency1 = 'USD';
  const currency2 = networkToCoinpaymentsCurrency(s.data.network);

  try {
    await ctx.reply('⏳ Creating CoinPayments transaction...');

    const opts = {
      amount: Number(usdAmount.toFixed(6)),
      currency1,
      currency2,
      buyer_email: 'azelchillexa@gmail.com', // ✅ Fixed email
      item_name: `Sell USDT -> ${s.data.fiat} (${s.data.payment_method})`
    };

    cpClient.createTransaction(opts, async (err, tx) => {
      if (err) {
        console.error('CoinPayments Error:', err);
        await ctx.reply('❌ Failed: ' + (err.message || JSON.stringify(err)));
        return;
      }

      s.data.tx = tx;
      s.step = 'awaiting_payment';

      const msg =
        `✅ *Transaction Created!*\n\n` +
        `Send exactly *${tx.amount} ${tx.coin}* to:\n\n` +
        `${tx.address || '(shown on status page)'}\n\n` +
        `Confirmations needed: *${tx.confirms_needed}*\n\n` +
        `After confirmation, your payout will be processed.`;

      await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
        [Markup.button.url('🔗 Payment Page', tx.status_url)]
      ]));
    });

  } catch (e) {
    console.error('Error creating transaction:', e);
    await ctx.reply('Unexpected error: ' + (e.message || e.toString()));
  }
});

bot.launch().then(() => console.log('🚀 USDT Sell Bot started successfully'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
