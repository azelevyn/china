require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');
const express = require('express');
const bodyParser = require('body-parser');

const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// ✅ Inline keyboard helper
const Markup = {
  inlineKeyboard: (buttons) => ({ reply_markup: { inline_keyboard: buttons } }),
  button: {
    url: (text, url) => ({ text, url }),
    callback: (text, data) => ({ text, callback_data: data })
  }
};

// ✅ CoinPayments setup
const cpClient = new CoinPayments({
  key: '7b4eaa9e7643e8f59a104ddc12062ac16d653de6e5cbffd1ea408cd9f2f8e3d7',
  secret: '3fb100ea69a1d9dC600237dbb65A48df3479ec426056aC61D93Feb55c258D6cC'
});

// ✅ Simple session memory
const sessions = {};
const session = (id) => (sessions[id] ||= {});

// ✅ Rates
const rates = {
  USD_TO_EUR: 0.89,
  USDT_TO_GBP: 0.77,
  USD_TO_USDT: 1.08
};

// ✅ Intro & Help Text
const introText = `
💸 *Welcome to the USDT Selling Bot!*

Sell your USDT easily and receive money via:
*Wise, Revolut, PayPal, Bank Transfer, Skrill/Neteller, Visa/Mastercard, Payeer, or Alipay.*

✅ *Minimum:* 25 USDT
✅ *Maximum:* 50,000 USDT
✅ *Networks:* BEP20 / TRC20 / ERC20
✅ *Fast & Secure via CoinPayments*

Press “Start Selling” to begin.
`;

const helpText = `
📖 *FAQ / Help*

1️⃣ *What does this bot do?*
Sell your USDT and receive fiat via your chosen method.

2️⃣ *Limits:* 25–50,000 USDT  
3️⃣ *Networks:* BEP20 / TRC20 / ERC20  
4️⃣ *Payment Methods:* Wise, Revolut, PayPal, Bank, Skrill, Neteller, Card, Payeer, Alipay  
5️⃣ *Support:* azelchillexa@gmail.com
`;

// ✅ START
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

// ✅ Handle Menu
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const s = session(chatId);

  switch (data) {
    case 'HELP':
      return bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });

    case 'SELL_USDT':
      return bot.sendMessage(chatId, 'Do you want to sell your USDT?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ YES', callback_data: 'YES_SELL' }],
            [{ text: '❌ NO', callback_data: 'NO_SELL' }]
          ]
        }
      });

    case 'NO_SELL':
      return bot.sendMessage(chatId, 'Okay! You can start anytime by typing /start 😊');

    case 'YES_SELL':
      await bot.sendMessage(chatId, `💱 Current Rates:\nUSD→EUR=${rates.USD_TO_EUR}\nUSDT→GBP=${rates.USDT_TO_GBP}\nUSD→USDT=${rates.USD_TO_USDT}`);
      return bot.sendMessage(chatId, 'Which currency would you like to receive?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'USD', callback_data: 'FIAT_USD' }],
            [{ text: 'EUR', callback_data: 'FIAT_EUR' }],
            [{ text: 'GBP', callback_data: 'FIAT_GBP' }]
          ]
        }
      });

    case 'FIAT_USD':
    case 'FIAT_EUR':
    case 'FIAT_GBP':
      s.fiat = data.split('_')[1];
      return bot.sendMessage(chatId, 'Select your USDT network:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'BEP20', callback_data: 'NET_BEP20' }],
            [{ text: 'TRC20', callback_data: 'NET_TRC20' }],
            [{ text: 'ERC20', callback_data: 'NET_ERC20' }]
          ]
        }
      });

    case 'NET_BEP20':
    case 'NET_TRC20':
    case 'NET_ERC20':
      s.network = data.split('_')[1];
      return bot.sendMessage(chatId, 'Choose your payment method:', {
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

    case 'PAY_SKRILL_NETELLER':
      return bot.sendMessage(chatId, 'Please choose one:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Skrill', callback_data: 'PAY_SKRILL' }],
            [{ text: 'Neteller', callback_data: 'PAY_NETELLER' }]
          ]
        }
      });

    default:
      break;
  }
});

// ✅ Payment details input
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const s = session(chatId);
  const method = query.data.replace('PAY_', '');

  const prompts = {
    WISE: 'Enter your Wise email or @WiseTag.',
    REVOLUT: 'Enter your Revolut tag.',
    PAYPAL: 'Enter your PayPal email.',
    BANK: 'Enter your bank details:\nFull Name:\nIBAN:\nSWIFT:',
    SKRILL: 'Enter your Skrill email.',
    NETELLER: 'Enter your Neteller email.',
    CARD: 'Enter your card number.',
    PAYEER: 'Enter your Payeer number.',
    ALIPAY: 'Enter your Alipay email.'
  };

  if (prompts[method]) {
    s.method = method;
    s.awaitingDetail = true;
    return bot.sendMessage(chatId, prompts[method]);
  }
});

// ✅ Handle user inputs
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const s = session(chatId);
  const text = msg.text.trim();

  if (s.awaitingDetail && !text.startsWith('/')) {
    s.details = text;
    s.awaitingDetail = false;
    s.awaitingAmount = true;
    return bot.sendMessage(chatId, '✅ Got it! Now enter amount of USDT to sell (25–50000):');
  }

  if (s.awaitingAmount) {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 25 || amount > 50000) {
      return bot.sendMessage(chatId, '❌ Invalid amount. Please enter between 25–50000 USDT.');
    }

    s.amount = amount;
    s.awaitingAmount = false;

    await bot.sendMessage(chatId, 'Generating CoinPayments address...');

    try {
      const tx = await cpClient.createTransaction({
        amount,
        currency1: 'USDT',
        currency2: 'USDT',
        buyer_email: 'azelchillexa@gmail.com',
        item_name: `Sell USDT via ${s.method}`
      });

      await bot.sendMessage(chatId,
        `✅ Transaction Created!\n\nSend *${tx.amount} ${tx.coin}* to:\n\n${tx.address}\n\n[View Status](${tx.status_url})`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, `❌ Transaction failed: ${err.message}`);
    }
  }
});

console.log('🤖 USDT Sell Bot is running...');
