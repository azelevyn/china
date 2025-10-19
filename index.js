require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Coinpayments = require('coinpayments');

// --- Setup bot and coinpayments ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const client = new Coinpayments({
  key: process.env.COINPAYMENTS_PUBLIC_KEY,
  secret: process.env.COINPAYMENTS_PRIVATE_KEY
});

// --- Intro message ---
const intro = `
🤖 *Welcome to the Secure Payment Bot!*

This bot allows you to send and receive money through multiple methods such as:
- 💳 Card
- 💸 PayPal
- 🏦 Bank Transfer
- 💰 Skrill / Neteller
- 💲 Payeer
- 🪙 CoinPayments (Crypto)
- 🧧 Alipay
- 🌍 Wise / Revolut

📘 Use the menu below to start!
`;

const faqText = `
❓ *FAQ / Help*

1️⃣ *How to Deposit?*
→ Choose "Deposit" and select your payment method.

2️⃣ *Minimum Amount:*
→ Minimum deposit is *25 USD* and maximum is *50,000 USD.*

3️⃣ *Refunds*
→ All refunds handled via email: *azelchillexa@gmail.com*

4️⃣ *Supported Crypto:*
→ BTC and ETH (via CoinPayments)

⚙️ If you face any issues, contact support: *@yourusername*
`;

// --- Main Menu ---
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('💰 Deposit', 'deposit')],
  [Markup.button.callback('📘 FAQ / Help', 'faq')]
]);

bot.start((ctx) => ctx.replyWithMarkdown(intro, mainMenu));

// --- Deposit Menu ---
bot.action('deposit', (ctx) => {
  ctx.reply(
    'Select your payment method:',
    Markup.inlineKeyboard([
      [Markup.button.callback('💳 Card', 'card')],
      [Markup.button.callback('💸 PayPal', 'paypal')],
      [Markup.button.callback('🏦 Bank Transfer', 'bank')],
      [Markup.button.callback('💰 Skrill / Neteller', 'skrill_neteller')],
      [Markup.button.callback('💲 Payeer', 'payeer')],
      [Markup.button.callback('🪙 Crypto (CoinPayments)', 'crypto')],
      [Markup.button.callback('🌍 Wise', 'wise')],
      [Markup.button.callback('🏧 Revolut', 'revolut')],
      [Markup.button.callback('🧧 Alipay', 'alipay')],
      [Markup.button.callback('⬅️ Back', 'main')]
    ])
  );
});

// --- FAQ ---
bot.action('faq', (ctx) => ctx.replyWithMarkdown(faqText, mainMenu));
bot.action('main', (ctx) => ctx.replyWithMarkdown(intro, mainMenu));

// --- Skrill / Neteller Submenu ---
bot.action('skrill_neteller', (ctx) => {
  ctx.reply(
    'Choose a platform:',
    Markup.inlineKeyboard([
      [Markup.button.callback('💰 Skrill', 'skrill')],
      [Markup.button.callback('💰 Neteller', 'neteller')],
      [Markup.button.callback('⬅️ Back', 'deposit')]
    ])
  );
});

// --- Data Input ---
const awaitingData = new Map();

function askAmount(ctx, type) {
  ctx.reply('Enter the amount (Min: 25, Max: 50000):');
  awaitingData.set(ctx.from.id, { step: 'amount', method: type });
}

function askDetails(ctx, text) {
  ctx.reply(text);
}

bot.action('wise', (ctx) => askAmount(ctx, 'wise'));
bot.action('revolut', (ctx) => askAmount(ctx, 'revolut'));
bot.action('paypal', (ctx) => askAmount(ctx, 'paypal'));
bot.action('bank', (ctx) => askAmount(ctx, 'bank'));
bot.action('skrill', (ctx) => askAmount(ctx, 'skrill'));
bot.action('neteller', (ctx) => askAmount(ctx, 'neteller'));
bot.action('card', (ctx) => askAmount(ctx, 'card'));
bot.action('payeer', (ctx) => askAmount(ctx, 'payeer'));
bot.action('alipay', (ctx) => askAmount(ctx, 'alipay'));
bot.action('crypto', (ctx) => askAmount(ctx, 'crypto'));

// --- Handle amount and details ---
bot.on('text', async (ctx) => {
  const data = awaitingData.get(ctx.from.id);
  if (!data) return;

  const text = ctx.message.text.trim();

  if (data.step === 'amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 25 || amount > 50000) {
      return ctx.reply('❌ Invalid amount. Please enter between 25 - 50000.');
    }

    data.amount = amount;
    awaitingData.set(ctx.from.id, { ...data, step: 'details' });

    switch (data.method) {
      case 'wise':
        return askDetails(ctx, 'Please provide your Wise email or Wise tag (@username):');
      case 'revolut':
        return askDetails(ctx, 'Please provide your Revolut tag (revtag):');
      case 'paypal':
        return askDetails(ctx, 'Please provide your PayPal email:');
      case 'bank':
        return askDetails(ctx, 'Please provide: Full name, IBAN, and SWIFT code.');
      case 'skrill':
      case 'neteller':
        return askDetails(ctx, `Please provide your ${data.method} email:`);
      case 'card':
        return askDetails(ctx, 'Please provide your card number:');
      case 'payeer':
        return askDetails(ctx, 'Please provide your Payeer number:');
      case 'alipay':
        return askDetails(ctx, 'Please provide your Alipay email:');
      case 'crypto':
        try {
          const txn = await client.createTransaction({
            currency1: 'USDT',
            currency2: 'BTC',
            amount: amount,
            buyer_email: 'azelchillexa@gmail.com'
          });

          ctx.replyWithMarkdown(
            `✅ *Payment created successfully!*
            
💰 Amount: *${amount} USD*
🔗 Transaction ID: \`${txn.txn_id}\`
📥 Deposit Address: \`${txn.address}\`
🧾 Please send the exact amount.

Thank you!`
          );
          awaitingData.delete(ctx.from.id);
        } catch (err) {
          console.error(err);
          ctx.reply('❌ Gagal membuat transaksi CoinPayments.');
        }
        return;
    }
  } else if (data.step === 'details') {
    const details = text;
    ctx.replyWithMarkdown(
      `✅ *Your payment request has been received!*

📦 Method: *${data.method}*
💰 Amount: *${data.amount} USD*
🧾 Details: \`${details}\`

Our team will review and process it shortly.`
    );
    awaitingData.delete(ctx.from.id);
  }
});

// --- Start bot ---
bot.launch();
console.log('✅ Bot is running...');
