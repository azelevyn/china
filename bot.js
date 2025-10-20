// === USDT SELLER BOT (Friendly Version with Refund Feature) ===

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

// --- BOT INITIALIZATION ---
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.COINPAYMENTS_PUBLIC_KEY || !process.env.COINPAYMENTS_PRIVATE_KEY || !process.env.ADMIN_CHAT_ID) {
  console.error('FATAL ERROR: Missing environment variables.');
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const coinpayments = new CoinPayments({
  key: process.env.COINPAYMENTS_PUBLIC_KEY,
  secret: process.env.COINPAYMENTS_PRIVATE_KEY,
});

// --- CONFIGURATION ---
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com';
const MIN_USDT = 25;
const MAX_USDT = 50000;
const SUPPORT_CONTACT = '@DeanAbdullah';

const RATES = {
  USDT_TO_USD: 1.05,
  USDT_TO_EUR: 0.89,
  USDT_TO_GBP: 0.79,
};

const userStates = {};
const adminReplyMap = {};

// --- HELPERS ---
function getCurrentDateTime() {
  const now = new Date();
  return now.toLocaleString('en-GB', { hour12: false });
}

function calculateFiat(usdtAmount, currency) {
  if (currency === 'USD') return usdtAmount * RATES.USDT_TO_USD;
  if (currency === 'EUR') return usdtAmount * RATES.USDT_TO_EUR;
  if (currency === 'GBP') return usdtAmount * RATES.USDT_TO_GBP;
  return 0;
}

// --- COMMANDS ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'Trader';
  const welcome = `👋 Hello *${firstName}*!\n\nWelcome to the *USDT Seller Bot*!\nI can help you sell your USDT instantly for *USD*, *EUR*, or *GBP*.\n\nReady to start?`;

  userStates[chatId] = {};

  bot.sendMessage(chatId, welcome, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Yes, let’s start', callback_data: 'start_sell' }],
        [{ text: '📘 How it works', callback_data: 'show_help' }],
      ],
    },
  });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `💡 *How to Sell USDT:*

1️⃣ Use /start to begin.
2️⃣ Choose your payout currency (USD, EUR, GBP).
3️⃣ Select your deposit network (TRC20 or ERC20).
4️⃣ Enter how much USDT you want to sell.
5️⃣ Provide your payout method (PayPal, Wise, Bank, etc.).
6️⃣ Confirm your transaction details.
7️⃣ Send USDT to the provided address.

🧾 You’ll receive your fiat payment once confirmed on blockchain.\n\nNeed help? Contact ${SUPPORT_CONTACT}`, { parse_mode: 'Markdown' });
});

// --- CALLBACK HANDLER ---

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!userStates[chatId]) userStates[chatId] = {};

  switch (data) {
    case 'show_help':
      bot.emit('text', { chat: { id: chatId }, text: '/help' });
      break;

    case 'start_sell':
      bot.sendMessage(chatId, `💱 *Current Exchange Rates:*

• 1 USDT = ${RATES.USDT_TO_USD} USD
• 1 USDT = ${RATES.USDT_TO_EUR} EUR
• 1 USDT = ${RATES.USDT_TO_GBP} GBP\n\nWhich currency do you want to receive?`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🇺🇸 USD', callback_data: 'fiat_USD' },
              { text: '🇪🇺 EUR', callback_data: 'fiat_EUR' },
              { text: '🇬🇧 GBP', callback_data: 'fiat_GBP' },
            ],
          ],
        },
      });
      break;

    default:
      if (data.startsWith('fiat_')) {
        const currency = data.split('_')[1];
        userStates[chatId].fiat = currency;
        bot.sendMessage(chatId, `Please select the *network* for your USDT deposit:`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'TRC20 (Tron)', callback_data: 'net_TRC20' }],
              [{ text: 'ERC20 (Ethereum)', callback_data: 'net_ERC20' }],
            ],
          },
        });
      } else if (data.startsWith('net_')) {
        userStates[chatId].network = data.split('_')[1];
        userStates[chatId].awaiting = 'amount';
        bot.sendMessage(chatId, `💰 Enter how many *USDT* you want to sell (Min: ${MIN_USDT}, Max: ${MAX_USDT})`, { parse_mode: 'Markdown' });
      } else if (data === 'confirm_transaction') {
        await handleTransactionCreation(chatId);
      } else if (data === 'cancel_transaction') {
        bot.sendMessage(chatId, '❌ Transaction cancelled. If you want to request a refund, type /refund.');
        delete userStates[chatId];
      }
      break;
  }

  bot.answerCallbackQuery(query.id);
});

// --- MESSAGE HANDLER ---

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const state = userStates[chatId];

  if (!state) return;

  if (state.awaiting === 'amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < MIN_USDT || amount > MAX_USDT) {
      return bot.sendMessage(chatId, `⚠️ Please enter a valid number between ${MIN_USDT} and ${MAX_USDT}.`);
    }
    state.amount = amount;
    state.awaiting = 'payment_method';

    const fiatValue = calculateFiat(amount, state.fiat).toFixed(2);
    bot.sendMessage(chatId, `You’ll receive approximately *${fiatValue} ${state.fiat}*.\n\nChoose your payout method:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Wise', callback_data: 'pay_wise' }, { text: 'PayPal', callback_data: 'pay_paypal' }],
          [{ text: 'Revolut', callback_data: 'pay_revolut' }, { text: 'Bank Transfer', callback_data: 'pay_bank' }],
        ],
      },
    });
  }

  if (state.awaiting === 'payment_details') {
    state.paymentDetails = text;
    state.awaiting = null;

    const summary = `🧾 *Transaction Summary:*

• Network: *${state.network}*
• Amount: *${state.amount} USDT*
• Payout Currency: *${state.fiat}*
• Payout Method: *${state.paymentMethod}*
• Payout Details:*\n${state.paymentDetails}*

✅ Confirm to proceed or ❌ Cancel.`;

    bot.sendMessage(chatId, summary, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm', callback_data: 'confirm_transaction' }],
          [{ text: '❌ Cancel', callback_data: 'cancel_transaction' }],
        ],
      },
    });
  }

  if (state.awaiting === 'refund_address') {
    const refundAddress = text;
    state.awaiting = null;

    await bot.sendMessage(ADMIN_CHAT_ID, `💸 *Refund Request Received:*

*User ID:* ${chatId}
*Refund Address:* ${refundAddress}
*Transaction Info:* ${JSON.stringify(state, null, 2)}`, { parse_mode: 'Markdown' });

    bot.sendMessage(chatId, '✅ Your refund request has been sent to admin. Please wait for manual processing.');
  }
});

// --- PAYMENT METHOD CALLBACKS ---

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userStates[chatId];

  if (!state) return;

  if (data.startsWith('pay_')) {
    const method = data.split('_')[1];
    state.paymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
    state.awaiting = 'payment_details';
    bot.sendMessage(chatId, `Please provide your *${state.paymentMethod}* payout details.`, { parse_mode: 'Markdown' });
  }
});

// --- REFUND COMMAND ---

bot.onText(/\/refund/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { awaiting: 'refund_address' };
  bot.sendMessage(chatId, '💸 Please enter your *USDT refund address* (TRC20 or ERC20):', { parse_mode: 'Markdown' });
});

// --- CREATE TRANSACTION ---

async function handleTransactionCreation(chatId) {
  const state = userStates[chatId];
  if (!state) return;

  bot.sendMessage(chatId, '🔄 Creating your secure deposit address, please wait...');
  try {
    const coinCurrency = state.network === 'TRC20' ? 'USDT.TRC20' : 'USDT.ERC20';

    const tx = await coinpayments.createTransaction({
      currency1: 'USDT',
      currency2: coinCurrency,
      amount: state.amount,
      buyer_email: BUYER_REFUND_EMAIL,
      custom: `Payout to ${state.paymentMethod}: ${state.paymentDetails}`,
      item_name: `Sell ${state.amount} USDT for ${state.fiat}`,
      ipn_url: 'YOUR_IPN_WEBHOOK_URL',
    });

    const info = `✅ *Deposit Address Ready!*

Please send *${tx.amount} USDT* (${state.network}) to:
\`${tx.address}\`

📍 [Track Status](${tx.status_url})

⚠️ *IMPORTANT:* Send only USDT via ${state.network}. Sending on the wrong network will result in loss of funds.`;

    bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
    delete userStates[chatId];
  } catch (err) {
    console.error('Error creating transaction:', err);
    bot.sendMessage(chatId, '❌ Error generating deposit address. Please try again later.');
  }
}

console.log('🤖 Bot is now running...');
