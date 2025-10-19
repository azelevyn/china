require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Coinpayments = require('coinpayments');
const express = require('express');

const app = express();
app.use(express.json());

// ====== BOT CONFIG ======
const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const client = new Coinpayments({
  key: '7b4eaa9e7643e8f59a104ddc12062ac16d653de6e5cbffd1ea408cd9f2f8e3d7',
  secret: '3fb100ea69a1d9dC600237dbb65A48df3479ec426056aC61D93Feb55c258D6cC'
});

// ====== HELPER ======
const sendMenu = (chatId) => {
  bot.sendMessage(chatId, "📘 *Menu Utama* — pilih salah satu:", {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [{ text: "💰 Jual USDT" }],
        [{ text: "❓ FAQ / Bantuan" }]
      ],
      resize_keyboard: true
    }
  });
};

// ====== INTRO MESSAGE ======
bot.onText(/\/start/, (msg) => {
  const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
  const intro = `
👋 *Halo ${name}!*
Selamat datang di *USDT Sell Bot*.

🪙 Bot ini membantu Anda menjual USDT dengan cepat dan aman.
Kami mendukung jaringan BEP20, TRC20, dan ERC20 serta berbagai metode pembayaran fiat seperti Wise, Revolut, PayPal, Bank Transfer, Skrill/Neteller, Kartu (Visa/Mastercard), Payeer, dan Alipay.

💵 *Kurs saat ini:*
- USD ➡️ EUR = 0.89 EUR  
- USDT ➡️ GBP = 0.77 GBP  
- USD ➡️ USDT = 1.08 USDT  

Ketik *Jual USDT* untuk memulai transaksi atau buka *FAQ/Bantuan* untuk instruksi lebih lanjut.
`;
  bot.sendMessage(msg.chat.id, intro, { parse_mode: "Markdown" });
  sendMenu(msg.chat.id);
});

// ====== FAQ MENU ======
bot.onText(/FAQ|Bantuan/i, (msg) => {
  const help = `
📘 *FAQ / Bantuan*

1️⃣ *Bagaimana cara menjual USDT?*
   Tekan tombol "💰 Jual USDT", pilih jaringan dan metode pembayaran Anda, lalu kirim USDT ke alamat yang diberikan.

2️⃣ *Berapa minimum penjualan?*
   Minimum 25 USDT dan maksimum 50,000 USDT.

3️⃣ *Kapan saya menerima pembayaran fiat?*
   Setelah deposit dikonfirmasi di blockchain, kami akan kirim pembayaran ke metode pilihan Anda dalam waktu 5–20 menit.

4️⃣ *Apakah aman?*
   Ya, semua transaksi dilakukan melalui CoinPayments yang terverifikasi.

💬 Jika Anda butuh bantuan lebih lanjut, hubungi admin support.
`;
  bot.sendMessage(msg.chat.id, help, { parse_mode: "Markdown" });
});

// ====== MAIN FLOW ======
bot.onText(/Jual USDT/i, (msg) => {
  bot.sendMessage(msg.chat.id, "Apakah Anda ingin menjual USDT sekarang?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ YA", callback_data: "sell_yes" }],
        [{ text: "❌ TIDAK", callback_data: "sell_no" }]
      ]
    }
  });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "sell_yes") {
    bot.sendMessage(chatId, "Pilih mata uang fiat yang ingin Anda terima:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🇺🇸 USD", callback_data: "fiat_usd" }],
          [{ text: "🇪🇺 EUR", callback_data: "fiat_eur" }],
          [{ text: "🇬🇧 GBP", callback_data: "fiat_gbp" }]
        ]
      }
    });
  } else if (data === "sell_no") {
    bot.sendMessage(chatId, "Baik, Anda dapat memulai kapan saja dengan mengetik *Jual USDT*.", { parse_mode: "Markdown" });
  }

  if (data.startsWith("fiat_")) {
    bot.sendMessage(chatId, "Pilih jaringan deposit Anda:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "BEP20", callback_data: "net_bep20" }],
          [{ text: "TRC20", callback_data: "net_trc20" }],
          [{ text: "ERC20", callback_data: "net_erc20" }]
        ]
      }
    });
  }

  if (data.startsWith("net_")) {
    bot.sendMessage(chatId, "Pilih metode pembayaran fiat Anda:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Wise", callback_data: "pay_wise" }],
          [{ text: "Revolut", callback_data: "pay_revolut" }],
          [{ text: "PayPal", callback_data: "pay_paypal" }],
          [{ text: "Bank Transfer", callback_data: "pay_bank" }],
          [{ text: "Skrill / Neteller", callback_data: "pay_skrill_neteller" }],
          [{ text: "Visa / Mastercard", callback_data: "pay_card" }],
          [{ text: "Payeer", callback_data: "pay_payeer" }],
          [{ text: "Alipay", callback_data: "pay_alipay" }]
        ]
      }
    });
  }

  if (data === "pay_skrill_neteller") {
    bot.sendMessage(chatId, "Pilih salah satu:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💸 Skrill", callback_data: "pay_skrill" }],
          [{ text: "💰 Neteller", callback_data: "pay_neteller" }]
        ]
      }
    });
  }

  if (data.startsWith("pay_")) {
    const method = data.split("_")[1];
    let ask = "";
    switch (method) {
      case "wise":
        ask = "Masukkan email atau tag Wise Anda (@username).";
        break;
      case "revolut":
        ask = "Masukkan Revolut tag Anda (revtag).";
        break;
      case "paypal":
        ask = "Masukkan email PayPal Anda.";
        break;
      case "bank":
        ask = "Masukkan detail bank Anda (Nama Lengkap, IBAN, SWIFT).";
        break;
      case "skrill":
      case "neteller":
        ask = "Masukkan email Skrill/Neteller Anda.";
        break;
      case "card":
        ask = "Masukkan nomor kartu Anda (Visa/Mastercard).";
        break;
      case "payeer":
        ask = "Masukkan nomor akun Payeer Anda.";
        break;
      case "alipay":
        ask = "Masukkan email Alipay Anda.";
        break;
    }
    bot.sendMessage(chatId, ask);
    bot.once("message", async (m) => {
      const userDetails = m.text;
      bot.sendMessage(chatId, "Berapa jumlah USDT yang ingin Anda jual? (min 25, max 50000)");
      bot.once("message", async (amountMsg) => {
        const amount = parseFloat(amountMsg.text);
        if (isNaN(amount) || amount < 25 || amount > 50000) {
          return bot.sendMessage(chatId, "❌ Jumlah tidak valid! Minimum 25 USDT, maksimum 50000 USDT.");
        }

        bot.sendMessage(chatId, "⏳ Membuat alamat deposit...");

        try {
          const tx = await client.createTransaction({
            currency1: 'USDT',
            currency2: 'USDT.TRC20',
            amount: amount,
            buyer_email: 'azelchillexa@gmail.com',
            item_name: `USDT Sell ${amount}`
          });

          bot.sendMessage(chatId, `
✅ Transaksi berhasil dibuat!

💵 Jumlah: *${amount} USDT*
📧 Email refund: azelchillexa@gmail.com
🏦 Metode pembayaran: *${method.toUpperCase()}*
📄 Detail Anda: ${userDetails}

📤 Kirim USDT ke alamat berikut:
\`${tx.address}\`

Atau gunakan QR Code ini:
${tx.qrcode_url}

Pastikan untuk mengirim jumlah yang benar. Setelah konfirmasi blockchain selesai, pembayaran fiat akan dikirim dalam 5–20 menit.
`, { parse_mode: "Markdown" });

        } catch (err) {
          bot.sendMessage(chatId, `❌ Gagal membuat transaksi CoinPayments: ${err.message}`);
        }
      });
    });
  }
});

// ====== EXPRESS KEEPALIVE ======
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(process.env.PORT || 8080, () => console.log('Bot online ✅'));
