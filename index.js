require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const CoinPayments = require('coinpayments');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const cpClient = new CoinPayments({
  key: process.env.COINPAYMENTS_PUBLIC_KEY,
  secret: process.env.COINPAYMENTS_PRIVATE_KEY
});

// In-memory user states (for demo). For production use a DB.
const sessions = {};

/**
 * Simple helper to get or create session
 */
function session(ctx) {
  const id = ctx.from.id;
  if (!sessions[id]) sessions[id] = { step: null, data: {} };
  return sessions[id];
}

/**
 * Rates & conversion assumptions:
 * - Provided in the request:
 *    USD -> EUR = 0.89  (meaning 1 USD = 0.89 EUR)
 *    USDT -> GBP = 0.77 (we'll interpret rates in a sensible way below)
 *    USD -> USDT = 1.08 (1 USD = 1.08 USDT)
 *
 * Implementation approach:
 * - When user asks to receive X in a fiat currency (USD/EUR/GBP), we convert that requested fiat into USD equivalent
 *   then multiply by USD_TO_USDT (1.08) to calculate the USDT amount required.
 * - Example: user wants 100 EUR -> convert EUR to USD: USD = EUR / 0.89 (because 1 USD = 0.89 EUR)
 *   then USDT required = USD * 1.08
 */
const RATES = {
  USD_TO_EUR: 0.89,
  USD_TO_USDT: 1.08,
  // USDT_TO_GBP is given but not directly needed for our flow; we'll convert GBP->USD via inversion when required.
  USDT_TO_GBP: 0.77
};

function fiatToUsd(amount, fiat) {
  fiat = fiat.toUpperCase();
  if (fiat === 'USD') return amount;
  if (fiat === 'EUR') {
    // 1 USD = 0.89 EUR => 1 EUR = 1 / 0.89 USD
    return amount / RATES.USD_TO_EUR;
  }
  if (fiat === 'GBP') {
    // We don't have direct USD->GBP; we have USDT->GBP. Simplest reasonable approach:
    // Assume 1 USD = 1.08 USDT and 1 USDT = 0.77 GBP (from input USDT_TO_GBP).
    // => 1 USD = 1.08 USDT = 1.08 * 0.77 GBP => 1 USD = 0.8316 GBP
    // So 1 GBP = 1 / 0.8316 USD
    const usdPerGbp = 1 / (RATES.USD_TO_USDT * RATES.USDT_TO_GBP); // = 1/(1.08*0.77)
    return amount * usdPerGbp;
  }
  // fallback: treat as USD
  return amount;
}

function usdToUsdt(usd) {
  return usd * RATES.USD_TO_USDT;
}

// Map selected network -> CoinPayments currency code
function networkToCoinpaymentsCurrency(networkChoice) {
  const n = networkChoice.toUpperCase();
  if (n.includes('TRC')) return 'USDT.TRC20';
  if (n.includes('BEP')) return 'USDT.BEP20';
  if (n.includes('ERC')) return 'USDT.ERC20';
  // fallback to TRC20
  return 'USDT.TRC20';
}

/* ---------- Bot flow ---------- */

bot.start(async (ctx) => {
  const s = session(ctx);
  s.step = 'started';
  s.data = {};
  const first = ctx.from.first_name || '';
  const last = ctx.from.last_name || '';
  await ctx.reply(`Hello ${first} ${last},\nWelcome — do you want to sell USDT?`, Markup.inlineKeyboard([
    [Markup.button.callback('YES', 'SELL_YES'), Markup.button.callback('NO', 'SELL_NO')]
  ]));
});

// Handle YES / NO
bot.action('SELL_NO', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('No worries. If you change your mind, type /start anytime.');
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
  await ctx.reply(`You chose ${fiat}. Please choose USDT network for deposit:`, Markup.inlineKeyboard([
    [Markup.button.callback('USDT TRC20', 'NET_TRC20')],
    [Markup.button.callback('USDT BEP20', 'NET_BEP20')],
    [Markup.button.callback('USDT ERC20', 'NET_ERC20')]
  ]));
});

// Network selection
bot.action(/NET_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const net = ctx.match[0].split('_')[1];
  s.data.network = net;
  s.step = 'choose_method';
  await ctx.reply('Which fiat payout method do you prefer? (Wise, Revolut, PayPal, Bank Transfer, Skrill/Neteller, Visa/Mastercard, Payeer, Alipay)', Markup.inlineKeyboard([
    [Markup.button.callback('Wise', 'PAY_WISE'), Markup.button.callback('Revolut', 'PAY_REVOLUT')],
    [Markup.button.callback('PayPal', 'PAY_PAYPAL'), Markup.button.callback('Bank Transfer', 'PAY_BANK')],
    [Markup.button.callback('Skrill/Neteller', 'PAY_SKRILL')],
    [Markup.button.callback('Visa/Mastercard', 'PAY_CARD'), Markup.button.callback('Payeer', 'PAY_PAYEER')],
    [Markup.button.callback('Alipay', 'PAY_ALIPAY')]
  ], { columns: 2 }));
});

// Payment method chosen
bot.action(/PAY_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  const method = ctx.match[0].split('_')[1];
  s.data.payment_method = method;
  s.step = 'collect_payment_details';
  await ctx.reply(`Send the payment details for ${method} (account email/IBAN/phone or any details needed to pay the user):\n\nExample: email@example.com or IBAN: XX00 0000 0000 0000`);
});

// Receive payment details (text)
bot.on('text', async (ctx, next) => {
  const s = session(ctx);
  if (s.step === 'collect_payment_details') {
    s.data.payment_details = ctx.message.text;
    s.step = 'ask_amount';
    await ctx.reply(`Got it. Now enter the amount of ${s.data.fiat} you want to receive (numeric, e.g. 100):`);
    return;
  }

  if (s.step === 'ask_amount') {
    const raw = ctx.message.text.replace(/[, ]+/g,'').trim();
    const amount = parseFloat(raw);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('Please enter a valid numeric amount (e.g. 250).');
      return;
    }
    s.data.fiat_amount = amount;

    // Convert fiat -> USD -> calculate USDT required
    const usdEquivalent = fiatToUsd(amount, s.data.fiat);
    const usdtRequired = usdToUsdt(usdEquivalent);

    s.data.usdt_required_est = Number(usdtRequired.toFixed(6));
    s.step = 'confirm_create_tx';

    await ctx.reply(
      `Summary:\n- You want to receive: ${amount} ${s.data.fiat}\n- Payment method: ${s.data.payment_method}\n- Payment details: ${s.data.payment_details}\n- Selected network: ${s.data.network}\n\nEstimated USDT to be sent by buyer (based on internal conversion): ${s.data.usdt_required_est} USDT\n\nProceed to create a deposit transaction (CoinPayments will calculate the exact crypto amount and provide address)?`,
      Markup.inlineKeyboard([[Markup.button.callback('Create deposit', 'CREATE_TX'), Markup.button.callback('Cancel', 'CANCEL_TX')]])
    );
    return;
  }

  // If not part of flow, pass to next middleware
  return next();
});

// Cancel
bot.action('CANCEL_TX', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  s.step = null;
  s.data = {};
  await ctx.reply('Cancelled. Type /start to begin again.');
});

// Create CoinPayments transaction
bot.action('CREATE_TX', async (ctx) => {
  await ctx.answerCbQuery();
  const s = session(ctx);
  if (!s.data || !s.data.fiat_amount) {
    await ctx.reply('No active sell request. Type /start to begin.');
    return;
  }

  // We'll create a CoinPayments transaction where:
  //   currency1 = USD (we pass fiat in USD equivalent)
  //   currency2 = USDT.<network> (CoinPayments will quote how much USDT required)
  const usdAmount = fiatToUsd(s.data.fiat_amount, s.data.fiat);
  const currency1 = 'USD';
  const currency2 = networkToCoinpaymentsCurrency(s.data.network);

  try {
    await ctx.reply('Creating CoinPayments transaction...');

    // create_transaction expects: amount, currency1, currency2, buyer_email optional
    const opts = {
      amount: Number(usdAmount.toFixed(6)),
      currency1,
      currency2,
      // we include a custom field to help identify the buyer in your IPN or merchant panel
      buyer_email: ctx.from.username ? `${ctx.from.username}@telegram` : `${ctx.from.id}@telegram`,
      // add a short note in 'item_name' so you can recognize transactions in merchant panel
      item_name: `Sell USDT -> ${s.data.fiat} (${s.data.payment_method})`
    };

    cpClient.createTransaction(opts, async (err, tx) => {
      if (err) {
        console.error('CoinPayments createTransaction error:', err);
        await ctx.reply('Failed to create CoinPayments transaction: ' + (err.message || JSON.stringify(err)));
        return;
      }

      // tx contains: amount (crypto amount), address, confirms_needed, qrcode_url, status_url, etc.
      s.step = 'awaiting_payment';
      s.data.tx = tx;

      let msg = `Transaction created!\n\nCoinPayments transaction info:\n- Status URL: ${tx.status_url}\n- Pay amount (crypto): ${tx.amount} ${tx.coin}\n- Deposit address: ${tx.address || '— (see status URL)'}\n- Confirms needed: ${tx.confirms_needed}\n\nPlease send exactly the required crypto to the address shown. After it is confirmed, your sell request will be processed.`;

      // send with keyboard to view status link
      await ctx.reply(msg, Markup.inlineKeyboard([
        [Markup.button.url('Open payment page', tx.status_url)]
      ]));
    });

  } catch (e) {
    console.error(e);
    await ctx.reply('Unexpected error when creating transaction: ' + e.message);
  }
});

// small handler for unknown
bot.on('message', async (ctx) => {
  // if user sends something out of flow
  const s = session(ctx);
  if (!s.step) {
    await ctx.reply('Send /start to begin selling USDT.');
  }
});

/* start polling */
bot.launch().then(() => {
  console.log('Bot started');
});

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
