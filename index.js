require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const CoinPayments = require('coinpayments');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const cpClient = new CoinPayments({
  key: process.env.COINPAYMENTS_PUBLIC_KEY,
  secret: process.env.COINPAYMENTS_PRIVATE_KEY
});

// In-memory session (for testing)
const sessions = {};
const session = (ctx) => {
  const id = ctx.from.id;
  if (!sessions[id]) sessions[id] = { step: null, data: {} };
  return sessions[id];
};

// Rates
const RATES = {
  USD_TO_EUR: 0.89,
  USD_TO_USDT: 1.08,
  USDT_TO_GBP: 0.77
};

function fiatToUsd(amount, fiat) {
  fiat = fiat.toUpperCase();
  if (fiat === 'USD') return amount;
  if (fiat === 'EUR') return amount / RATES.USD_TO_EUR;
  if (fiat === 'GBP') return amount / (RATES.USD_TO_USDT * RATES.USDT_TO_GBP);
  return amount;
}

function usdToUsdt(usd) {
  return usd * RATES.USD_TO_USDT;
}

function networkToCoinpaymentsCurrency(networkChoice) {
  const n = networkChoice.toUpperCase();
  if (n.includes('TRC')) return 'USDT.TRC20';
  if (n.includes('BEP')) return 'USDT.BEP20';
  if (n.includes('ERC')) return 'USDT.ERC20';
  return 'USDT.TRC20';
}

/* ---------- BOT FLOW ---------- */

// Introduction
bot.start(async (ctx) => {
  const s = session(ctx);
  s.step = 'intro';
  s.data = {};

  const name = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
  await ctx.replyWithMarkdown(
    `👋 *Hello ${name}!*\n\nWelcome to the *USDT Selling Bot*.\n\nThis bot helps you convert your *USDT* into *fiat currency* (USD, EUR, GBP) safely.\n\n💱 You’ll be able to:\n• Choose your preferred currency\n• Select your USDT network (TRC20/BEP20/ERC20)\n• Choose your payout method (Wise, PayPal, Bank, etc.)\n• Receive payment after deposit confirmation\n\nWould you like to *sell your USDT now?*`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ YES', 'SELL_YES'), Markup.button.callback('❌ NO', 'SELL_NO')]
    ])
  );
});

bot.action('SELL_NO', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Alright! You can start anytime by sending /start again.');
});

bot.action('SELL_YES', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  s.step = 'choose_fiat';
  await ctx.reply('Please choose the currency you would like to receive:', Markup.inlineKeyboard([
    [Markup.button.callback('USD', 'FIAT_USD'), Markup.button.callback('EUR', 'FIAT_EUR'), Markup.button.callback('GBP', 'FIAT_GBP')]
  ]));
});

bot.action(/FIAT_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const fiat = ctx.match[0].split('_')[1];
  s.data.fiat = fiat;
  s.step = 'choose_network';
  await ctx.reply(`You selected ${fiat}. Now choose the USDT network:`, Markup.inlineKeyboard([
    [Markup.button.callback('USDT TRC20', 'NET_TRC20')],
    [Markup.button.callback('USDT BEP20', 'NET_BEP20')],
    [Markup.button.callback('USDT ERC20', 'NET_ERC20')]
  ]));
});

bot.action(/NET_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const net = ctx.match[0].split('_')[1];
  s.data.network = net;
  s.step = 'choose_method';
  await ctx.reply('Please select your payout method:', Markup.inlineKeyboard([
    [Markup.button.callback('Wise', 'PAY_WISE'), Markup.button.callback('Revolut', 'PAY_REVOLUT')],
    [Markup.button.callback('PayPal', 'PAY_PAYPAL'), Markup.button.callback('Bank Transfer', 'PAY_BANK')],
    [Markup.button.callback('Skrill/Neteller', 'PAY_SKRILL')],
    [Markup.button.callback('Visa/Mastercard', 'PAY_CARD')],
    [Markup.button.callback('Payeer', 'PAY_PAYEER'), Markup.button.callback('Alipay', 'PAY_ALIPAY')]
  ]));
});

// Handle different payment method input prompts
bot.action(/PAY_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const method = ctx.match[0].split('_')[1];
  s.data.payment_method = method;
  s.step = 'collect_payment_details';

  let prompt = '';
  switch (method) {
    case 'WISE':
      prompt = 'Please enter your Wise email or Wise tag (@username):';
      break;
    case 'REVOLUT':
      prompt = 'Please enter your Revolut tag (e.g. @revtag):';
      break;
    case 'PAYPAL':
      prompt = 'Please enter your PayPal email:';
      break;
    case 'BANK':
      prompt = 'Please provide your Bank Transfer details in this format:\n\nFull Name:\nIBAN:\nSWIFT Code:';
      break;
    case 'SKRILL':
      prompt = 'Please enter your Skrill or Neteller email:';
      break;
    case 'CARD':
      prompt = 'Please enter your card number (Visa/Mastercard):';
      break;
    case 'PAYEER':
      prompt = 'Please enter your Payeer account number (e.g. P1234567):';
      break;
    case 'ALIPAY':
      prompt = 'Please enter your Alipay email:';
      break;
    default:
      prompt = 'Please provide your payout details:';
  }

  await ctx.reply(prompt);
});

// Receive payment details
bot.on('text', async (ctx, next) => {
  const s = session(ctx);
  if (s.step === 'collect_payment_details') {
    s.data.payment_details = ctx.message.text;
    s.step = 'ask_amount';
    await ctx.reply(`Got it ✅\nNow enter the amount of ${s.data.fiat} you wish to receive:`);
    return;
  }

  if (s.step === 'ask_amount') {
    const raw = ctx.message.text.trim().replace(/[^\d.]/g, '');
    const amount = parseFloat(raw);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('Please enter a valid numeric amount.');
      return;
    }
    s.data.fiat_amount = amount;

    const usdEquivalent = fiatToUsd(amount, s.data.fiat);
    const usdtRequired = usdToUsdt(usdEquivalent);
    s.data.usdt_required_est = usdtRequired.toFixed(6);
    s.step = 'confirm_create_tx';

    await ctx.reply(
      `💰 Summary of your sell order:\n\n` +
      `Fiat to receive: ${amount} ${s.data.fiat}\n` +
      `Payout method: ${s.data.payment_method}\n` +
      `Details: ${s.data.payment_details}\n` +
      `Network: USDT ${s.data.network}\n` +
      `Estimated deposit amount: ${s.data.usdt_required_est} USDT\n\nProceed to generate deposit address?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Generate Deposit', 'CREATE_TX'), Markup.button.callback('❌ Cancel', 'CANCEL_TX')]
      ])
    );
    return;
  }
  return next();
});

bot.action('CANCEL_TX', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  s.step = null;
  s.data = {};
  await ctx.reply('❌ Transaction cancelled. Type /start to begin again.');
});

bot.action('CREATE_TX', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  if (!s.data.fiat_amount) return ctx.reply('No active transaction found.');

  const usdAmount = fiatToUsd(s.data.fiat_amount, s.data.fiat);
  const currency1 = 'USD';
  const currency2 = networkToCoinpaymentsCurrency(s.data.network);

  try {
    await ctx.reply('🔄 Creating CoinPayments transaction...');
    const tx = await new Promise((resolve, reject) => {
      cpClient.createTransaction({
        amount: usdAmount,
        currency1,
        currency2,
        buyer_email: ctx.from.username
          ? `${ctx.from.username}@telegram`
          : `${ctx.from.id}@telegram`,
        item_name: `Sell USDT -> ${s.data.fiat} (${s.data.payment_method})`
      }, (err, tx) => (err ? reject(err) : resolve(tx)));
    });

    s.step = 'awaiting_payment';
    s.data.tx = tx;

    await ctx.reply(
      `✅ Transaction Created!\n\n` +
      `Send exactly *${tx.amount} ${tx.coin}* to this address:\n\n` +
      `💳 ${tx.address}\n\n` +
      `Confirmations needed: ${tx.confirms_needed}\n` +
      `\nAfter confirmation, your payout will be processed manually.`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('🔗 Open Payment Page', tx.status_url)]]) }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply('❌ Error creating CoinPayments transaction: ' + err.message);
  }
});

bot.launch().then(() => console.log('✅ USDT Sell Bot Started'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
