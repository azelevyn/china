require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { createTransaction } = require('./helpers/coinpayments');

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// ✅ Start command
bot.start((ctx) => {
  ctx.reply(
    `👋 Selamat datang, ${ctx.from.first_name}!\n\n` +
    `Bot ini digunakan untuk melakukan transaksi USDT (TRC20) melalui CoinPayments.\n\n` +
    `Klik menu di bawah untuk memulai.`,
    Markup.keyboard([
      ['💰 Deposit', '💼 Cek Saldo'],
      ['👥 Referral', 'ℹ️ Bantuan']
    ]).resize()
  );
});

// ✅ Command /deposit
bot.hears('💰 Deposit', async (ctx) => {
  try {
    await ctx.reply('⏳ Membuat alamat deposit USDT (TRC20)...');
    const txn = await createTransaction(10, 'USDT.TRC20', 'USDT.TRC20');

    await ctx.reply(
      `✅ Transaksi berhasil dibuat!\n\n` +
      `💵 Jumlah: ${txn.amount} USDT\n` +
      `🏦 Alamat Deposit:\n\`${txn.address}\`\n\n` +
      `🔗 TXN ID: ${txn.txn_id}\n` +
      `📩 Status: ${txn.status_text}`,
      { parse_mode: 'Markdown' }
    );

    if (txn.qrcode_url) {
      await ctx.replyWithPhoto(txn.qrcode_url, { caption: 'Scan QR untuk deposit' });
    }
  } catch (err) {
    console.error('❌ Gagal membuat transaksi CoinPayments:', err);
    await ctx.reply('❌ Gagal membuat transaksi CoinPayments. Coba lagi nanti.');
  }
});

// ✅ Command /cek saldo (contoh statis)
bot.hears('💼 Cek Saldo', async (ctx) => {
  await ctx.reply('💼 Saldo Anda saat ini: 0.00 USDT\n\nGunakan menu Deposit untuk menambah saldo.');
});

// ✅ Referral
bot.hears('👥 Referral', async (ctx) => {
  const refLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
  await ctx.reply(
    `👥 Program Referral\n\n` +
    `Bagikan link ini ke teman Anda:\n${refLink}\n\n` +
    `Anda akan mendapatkan bonus setelah teman Anda melakukan deposit.`
  );
});

// ✅ Bantuan
bot.hears('ℹ️ Bantuan', async (ctx) => {
  await ctx.reply(
    `📖 Bantuan Bot\n\n` +
    `• Gunakan "💰 Deposit" untuk melakukan top-up.\n` +
    `• Gunakan "💼 Cek Saldo" untuk melihat saldo.\n` +
    `• Gunakan "👥 Referral" untuk mendapatkan link referral.\n\n` +
    `Jika ada kendala, hubungi admin.`
  );
});

// ✅ Jalankan bot
bot.launch();
console.log('🤖 Bot Telegram berjalan...');

// ✅ Express server (untuk menjaga bot tetap hidup di hosting)
app.get('/', (req, res) => res.send('Bot aktif 🚀'));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🌐 Server berjalan di port ${PORT}`));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
