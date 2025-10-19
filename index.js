require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');
const express = require('express');
const bodyParser = require('body-parser');
const { Markup } = require('telegraf');

const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// Initialize CoinPayments
const cpClient = new CoinPayments({
  key: '7b4eaa9e7643e8f59a104ddc12062ac16d653de6e5cbffd1ea408cd9f2f8e3d7',
  secret: '3fb100ea69a1d9dC600237dbb65A48df3479ec426056aC61D93Feb55c258D6cC'
});

// --- In-memory session (for demo) ---
const sessions = {};
const session = (chatId) => (sessions[chatId] ||= {});

// --- Exchange Rates ---
const rates = {
  USD_TO_EUR: 0.89,
  USDT_TO_GBP: 0.77,
  USD_TO_USDT: 1.08
};

// --- INTRO MESSAGE ---
const introText = `
💸 *Welcome to the USDT Selling Bot!*

This bot allows you to sell your USDT safely and quickly.  
You can choose to receive payment via multiple fiat options such as:
*Wise, Revolut, PayPal, Bank Transfer, Skrill/Neteller, Visa/Mastercard, Payeer, or Alipay.*

✅ *Minimum amount:* 25 USDT  
✅ *Maximum amount:* 50,000 USDT  
✅ *Supported Networks:* BEP20, TRC20, ERC20  
✅ *Fast, secure & transparent process.*

Simply press “Start Selling” to begin!

Use /help for instructions and FAQs.
`;

// --- HELP / FAQ ---
const helpText = `
📖 *FAQ / Help*

1️⃣ *What does this bot do?*  
It lets you sell your USDT and receive fiat money (USD, EUR, GBP) through your chosen method.

2️⃣ *Minimum & Maximum?*  
Minimum: 25 USDT  
Maximum: 50,000 USDT

3️⃣ *Supported Networks?*  
USDT BEP20, TRC20, ERC20

4️⃣ *Payment Methods?*  
Wise, Revolut, PayPal, Bank Transfer, Skrill, Neteller, Visa/Mastercard, Payeer, Alipay.

5️⃣ *Is it safe?*  
Yes — payments are handled securely via CoinPayments.

For assistance, contact admin at: azelchillexa@gmail.com
`;

// --- START COMMAND ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();

  bot.sendMessage(chatId, `Hello ${name}! 👋\n\n${introText}`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💰 Start Selling', callback_data: 'SELL_USDT' }],
        [{ text: '📖 FAQ / Help', callback_data: 'HELP' }]
      ]
    }
  });
});

// --- HELP MENU ---
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const s = session(chatId);

  switch (data) {
    case 'HELP':
      await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
      break;

    case 'SELL_USDT':
      await bot.sendMessage(chatId, 'Do you want to sell your USDT?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ YES', callback_data: 'YES_SELL' }],
            [{ text: '❌ NO', callback_data: 'NO_SELL' }]
          ]
        }
      });
      break;

    case 'NO_SELL':
      await bot.sendMessage(chatId, 'Okay! You can start anytime by using /start 😊');
      break;

    case 'YES_SELL':
      await bot.sendMessage(chatId, `💱 Current Rates:\n\nUSD → EUR = ${rates.USD_TO_EUR}\nUSDT → GBP = ${rates.USDT_TO_GBP}\nUSD → USDT = ${rates.USD_TO_USDT}`);
      await bot.sendMessage(chatId, 'Which currency would you like to receive?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'USD', callback_data: 'FIAT_USD' }],
            [{ text: 'EUR', callback_data: 'FIAT_EUR' }],
            [{ text: 'GBP', callback_data: 'FIAT_GBP' }]
          ]
        }
      });
      break;

    case 'FIAT_USD':
    case 'FIAT_EUR':
    case 'FIAT_GBP':
      s.fiat = data.split('_')[1];
      await bot.sendMessage(chatId, 'Select your USDT network:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'BEP20', callback_data: 'NET_BEP20' }],
            [{ text: 'TRC20', callback_data: 'NET_TRC20' }],
            [{ text: 'ERC20', callback_data: 'NET_ERC20' }]
          ]
        }
      });
      break;

    case 'NET_BEP20':
    case 'NET_TRC20':
    case 'NET_ERC20':
      s.network = data.split('_')[1];
      await bot.sendMessage(chatId, 'Choose your preferred payment method:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Wise', callback_data: 'PAY_WISE' }],
            [{ text: 'Revolut', callback_data: 'PAY_REVOLUT' }],
            [{ text: 'PayPal', callback_data: 'PAY_PAYPAL' }],
            [{ text: 'Bank Transfer', callback_data: 'PAY_BANK' }],
            [{ text: 'Skrill / Neteller', callback_data: 'PAY_SKRILL_NETELLER' }],
            [{ text: 'Visa / Mastercard', callback_data: 'PAY_CARD' }],
            [{ text: 'Payeer', callback_data: 'PAY_PAYEER' }],
            [{ text: 'Alipay', callback_data: 'PAY_ALIPAY' }]
          ]
        }
      });
      break;

    case 'PAY_SKRILL_NETELLER':
      await bot.sendMessage(chatId, 'Please choose:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Skrill', callback_data: 'PAY_SKRILL' }],
            [{ text: 'Neteller', callback_data: 'PAY_NETELLER' }]
          ]
        }
      });
      break;

    default:
      break;
  }
});

// --- CAPTURE PAYMENT DETAILS ---
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const s = session(chatId);

  if (data.startsWith('PAY_')) {
    const method = data.split('_')[1];
    s.method = method;

    let askText = '';
    switch (method.toUpperCase()) {
      case 'WISE':
        askText = 'Please provide your Wise email or @WiseTag.';
        break;
      case 'REVOLUT':
        askText = 'Please provide your Revolut tag.';
        break;
      case 'PAYPAL':
        askText = 'Please provide your PayPal email.';
        break;
      case 'BANK':
        askText = 'Please provide your bank transfer details:\nFull Name:\nIBAN:\nSWIFT:';
        break;
      case 'SKRILL':
      case 'NETELLER':
        askText = `Please provide your ${method} email.`;
        break;
      case 'CARD':
        askText = 'Please provide your card number.';
        break;
      case 'PAYEER':
        askText = 'Please provide your Payeer number.';
        break;
      case 'ALIPAY':
        askText = 'Please provide your Alipay email.';
        break;
    }

    s.awaitingDetail = true;
    await bot.sendMessage(chatId, askText);
  }
});

// --- HANDLE TEXT INPUT ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const s = session(chatId);
  if (s.awaitingDetail && !msg.text.startsWith('/')) {
    s.details = msg.text;
    s.awaitingDetail = false;

    await bot.sendMessage(chatId, '✅ Received your payment details.');
    await bot.sendMessage(chatId, 'Enter the amount of USDT you want to sell (min 25, max 50000):');
    s.awaitingAmount = true;
  } else if (s.awaitingAmount) {
    const amount = parseFloat(msg.text);
    if (isNaN(amount) || amount < 25 || amount > 50000) {
      await bot.sendMessage(chatId, '❌ Invalid amount. Must be between 25 and 50000 USDT.');
      return;
    }

    s.amount = amount;
    s.awaitingAmount = false;

    await bot.sendMessage(chatId, 'Generating CoinPayments deposit address...');

    try {
      const tx = await cpClient.createTransaction({
        amount,
        currency1: 'USDT',
        currency2: 'USDT',
        buyer_email: 'azelchillexa@gmail.com',
        item_name: `Sell USDT via ${s.method}`
      });

      await bot.sendMessage(chatId, `✅ Transaction created!\n\nSend *${tx.amount} ${tx.coin}* to the address below:\n\n${tx.address}\n\nYou can also view your payment status here: ${tx.status_url}`, { parse_mode: 'Markdown' });

    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, `❌ Failed to create transaction: ${err.message}`);
    }
  }
});

console.log('🤖 Bot is running...');
