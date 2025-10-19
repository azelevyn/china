require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Coinpayments = require('coinpayments-v2');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Create CoinPayments v2 client
const cp = new Coinpayments({
  key: process.env.COINPAYMENTS_PUBLIC,
  secret: process.env.COINPAYMENTS_PRIVATE,
  merchant: process.env.COINPAYMENTS_MERCHANT
});

// Simpan state pengguna (guna DB untuk production)
const userState = {};

const RATES = {
  USD_TO_EUR: 0.89,
  USDT_TO_GBP: 0.77,
  USD_TO_USDT: 1.08
};

// 🟢 Mula
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
  userState[chatId] = {};

  await bot.sendMessage(
    chatId,
    `Hello ${name}, 👋\n\nSaya boleh bantu anda jual USDT.\nMahu mula jual sekarang?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ YES", callback_data: "SELL_YES" }, { text: "❌ NO", callback_data: "SELL_NO" }]
        ]
      }
    }
  );
});

// 🟡 Callback button handler
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userState[chatId] || {};

  await bot.answerCallbackQuery(query.id);

  switch (data) {
    case "SELL_YES":
      state.step = "AMOUNT";
      userState[chatId] = state;
      return bot.sendMessage(chatId, `Sila masukkan jumlah USDT yang anda ingin jual.\n\n💱 Kadar semasa:\nUSD → EUR: 0.89\nUSDT → GBP: 0.77\nUSD → USDT: 1.08`);

    case "SELL_NO":
      return bot.sendMessage(chatId, "Baik! Anda boleh kembali bila-bila masa dengan /start.");

    // Fiat selection
    case "FIAT_USD":
    case "FIAT_EUR":
    case "FIAT_GBP":
      state.fiat = data.split("_")[1];
      state.step = "NETWORK";
      return bot.sendMessage(chatId, "Pilih rangkaian USDT untuk deposit:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "USDT BEP20", callback_data: "NET_BEP20" }],
            [{ text: "USDT TRC20", callback_data: "NET_TRC20" }],
            [{ text: "USDT ERC20", callback_data: "NET_ERC20" }]
          ]
        }
      });

    // Network selection
    case "NET_BEP20":
    case "NET_TRC20":
    case "NET_ERC20":
      state.network = data.split("_")[1];
      state.step = "PAYMENT_METHOD";
      return bot.sendMessage(chatId, "Pilih kaedah pembayaran fiat:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Wise", callback_data: "PM_Wise" }, { text: "Revolut", callback_data: "PM_Revolut" }],
            [{ text: "PayPal", callback_data: "PM_PayPal" }, { text: "Bank Transfer", callback_data: "PM_Bank" }],
            [{ text: "Skrill/Neteller", callback_data: "PM_Skrill" }, { text: "Visa/Mastercard", callback_data: "PM_Card" }],
            [{ text: "Payeer", callback_data: "PM_Payeer" }, { text: "Alipay", callback_data: "PM_Alipay" }]
          ]
        }
      });

    // Payment method
    default:
      if (data.startsWith("PM_")) {
        state.paymentMethod = data.split("_")[1];
        state.step = "PAYMENT_DETAIL";
        return bot.sendMessage(chatId, `Anda pilih ${state.paymentMethod}. 🏦\nSila hantar butiran pembayaran (contoh: email, akaun, IBAN dll).`);
      }
  }
});

// 🧠 Handler untuk mesej text (mengikut langkah)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const state = userState[chatId];

  if (!state || msg.text.startsWith("/")) return;

  switch (state.step) {
    case "AMOUNT":
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "Sila masukkan jumlah USDT yang sah, contoh: 150");
      state.amount = amount;
      state.step = "FIAT";
      return bot.sendMessage(chatId, "Pilih mata wang fiat untuk terima:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "USD", callback_data: "FIAT_USD" }, { text: "EUR", callback_data: "FIAT_EUR" }, { text: "GBP", callback_data: "FIAT_GBP" }]
          ]
        }
      });

    case "PAYMENT_DETAIL":
      state.paymentDetail = text;
      state.step = "CREATING_TX";
      await bot.sendMessage(chatId, "Mencipta transaksi CoinPayments, sila tunggu...");

      try {
        // network mapping
        const networkMap = {
          BEP20: "USDT.BEP20",
          TRC20: "USDT.TRC20",
          ERC20: "USDT.ERC20"
        };

        const currency2 = networkMap[state.network];
        const currency1 = state.fiat;
        const fiatValue = calculateFiat(state.amount, state.fiat);

        const tx = await cp.createTransaction({
          currency1,
          currency2,
          amount: fiatValue,
          buyer_email: "azelchillexa@gmail.com",
          invoice: `sell-${chatId}-${Date.now()}`
        });

        const info = [
          `💰 Jumlah: ${tx.amount} ${tx.coin}`,
          `🏦 Hantar ke: ${tx.address}`,
          `🕒 Masa tamat: ${tx.timeout} saat`,
          `🔗 Status: ${tx.status_url}`
        ].join("\n");

        await bot.sendMessage(chatId, `✅ Transaksi CoinPayments telah dicipta!\n\n${info}`);
      } catch (err) {
        console.error(err);
        await bot.sendMessage(chatId, `❌ Ralat cipta transaksi: ${err.message}`);
      }
      break;
  }
});

// 🔢 Kiraan tukaran ringkas
function calculateFiat(usdtAmount, fiat) {
  switch (fiat) {
    case "EUR": return usdtAmount * RATES.USD_TO_EUR;
    case "GBP": return usdtAmount * RATES.USDT_TO_GBP;
    default: return usdtAmount * RATES.USD_TO_USDT;
  }
}

console.log("✅ Bot USDT Sell sedang berjalan...");
