const dotenv = require("dotenv");
const express = require("express");
const CoinPayments = require("coinpayments");
const { Telegraf, Markup } = require("telegraf");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const TOKEN = process.env.TELEGRAM_TOKEN;

if (!TOKEN) {
  console.error("❌ TELEGRAM_TOKEN not found in .env");
  process.exit(1);
}

const bot = new Telegraf(TOKEN);

// CoinPayments setup
const client = new CoinPayments({
  key: "7b4eaa9e7643e8f59a104ddc12062ac16d653de6e5cbffd1ea408cd9f2f8e3d7",
  secret: "3fb100ea69a1d9dC600237dbb65A48df3479ec426056aC61D93Feb55c258D6cC",
});

// User states
const userState = {};

// === INTRO ===
const introMessage = `
💱 *Welcome to the USDT Sell Bot!*

This bot helps you sell your *USDT* securely via *CoinPayments*.

📖 *How It Works:*
1️⃣ Choose to sell your USDT  
2️⃣ Pick your preferred *fiat currency (USD, EUR, GBP)*  
3️⃣ Select your *USDT network* (TRC20, BEP20, ERC20)  
4️⃣ Provide your *payment method* (e.g. Wise, Revolut, PayPal, Bank, etc.)  
5️⃣ Deposit the required USDT via CoinPayments  
6️⃣ Receive your payout in your chosen method 💰

⚙️ *Minimum*: 25 USDT  
⚙️ *Maximum*: 50,000 USDT  

Use /help to learn more or /start to begin.
`;

// === HELP / FAQ ===
const faqMessage = `
📚 *FAQ / Help*

❓ *Q: What is this bot?*  
A: This bot helps you sell your USDT easily and receive fiat payments.

❓ *Q: What payment methods are supported?*  
A: Wise, Revolut, PayPal, Bank, Skrill, Neteller, Card, Payeer, Alipay.

❓ *Q: What networks are supported?*  
A: USDT TRC20, BEP20, ERC20.

❓ *Q: What is the minimum/maximum amount?*  
A: 25 USDT minimum, 50,000 USDT maximum.

❓ *Q: Who handles the transactions?*  
A: CoinPayments handles secure deposit and processing.

Need more help? Contact support: *azelchillexa@gmail.com*
`;

// === START ===
bot.start((ctx) => {
  const firstName = ctx.from.first_name || "";
  const lastName = ctx.from.last_name || "";
  ctx.replyWithMarkdown(
    `👋 Hello *${firstName} ${lastName}*, welcome!\n\n${introMessage}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💰 Sell USDT", "sell_usdt")],
      [Markup.button.callback("📖 Help / FAQ", "faq")],
    ])
  );
});

bot.action("faq", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(faqMessage);
});

// === SELL USDT FLOW ===
bot.action("sell_usdt", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    "Do you want to sell USDT?",
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ YES", "confirm_sell")],
      [Markup.button.callback("❌ NO", "cancel_sell")],
    ])
  );
});

bot.action("cancel_sell", async (ctx) => {
  await ctx.answerCbQuery("Cancelled");
  await ctx.reply("❌ Cancelled. Type /start to begin again.");
});

bot.action("confirm_sell", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    `📊 *Current Rates:*\n\nUSD → EUR = 0.89 EUR\nUSDT → GBP = 0.77 GBP\nUSD → USDT = 1.08\n\nPlease choose your preferred fiat currency:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("🇺🇸 USD", "fiat_usd"),
          Markup.button.callback("🇪🇺 EUR", "fiat_eur"),
          Markup.button.callback("🇬🇧 GBP", "fiat_gbp"),
        ],
      ]),
    }
  );
});

["usd", "eur", "gbp"].forEach((fiat) => {
  bot.action(`fiat_${fiat}`, async (ctx) => {
    await ctx.answerCbQuery();
    userState[ctx.from.id] = { fiat };
    ctx.reply(
      "Please select your USDT network:",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("💎 BEP20", "net_bep20"),
          Markup.button.callback("⚡ TRC20", "net_trc20"),
          Markup.button.callback("🌐 ERC20", "net_erc20"),
        ],
      ])
    );
  });
});

["bep20", "trc20", "erc20"].forEach((net) => {
  bot.action(`net_${net}`, async (ctx) => {
    await ctx.answerCbQuery();
    userState[ctx.from.id].network = net;
    ctx.reply(
      "Select your payment method:",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("💸 Wise", "pay_wise"),
          Markup.button.callback("🏦 Bank", "pay_bank"),
        ],
        [
          Markup.button.callback("💳 Card", "pay_card"),
          Markup.button.callback("💰 Skrill/Neteller", "pay_skrillneteller"),
        ],
        [
          Markup.button.callback("📧 PayPal", "pay_paypal"),
          Markup.button.callback("💠 Payeer", "pay_payeer"),
        ],
        [Markup.button.callback("🅰️ Alipay", "pay_alipay")],
      ])
    );
  });
});

bot.action("pay_skrillneteller", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    "Choose between Skrill or Neteller:",
    Markup.inlineKeyboard([
      [Markup.button.callback("💰 Skrill", "pay_skrill")],
      [Markup.button.callback("💰 Neteller", "pay_neteller")],
    ])
  );
});

const prompts = {
  wise: "Please enter your Wise email or @wise tag:",
  paypal: "Please enter your PayPal email:",
  bank: "Enter: Full Name, IBAN, and SWIFT code:",
  skrill: "Please enter your Skrill email:",
  neteller: "Please enter your Neteller email:",
  card: "Please enter your Card number:",
  payeer: "Please enter your Payeer number:",
  alipay: "Please enter your Alipay email:",
};

Object.keys(prompts).forEach((key) => {
  bot.action(`pay_${key}`, async (ctx) => {
    await ctx.answerCbQuery();
    userState[ctx.from.id].method = key;
    ctx.reply(prompts[key]);
    userState[ctx.from.id].awaitingDetails = true;
  });
});

bot.on("text", async (ctx) => {
  const state = userState[ctx.from.id];
  if (!state || !state.awaitingDetails) return;

  const text = ctx.message.text.trim();
  if (!state.paymentDetails) {
    state.paymentDetails = text;
    state.awaitingDetails = false;
    ctx.reply("Enter the amount of USDT you want to sell (25 - 50000):");
    state.awaitingAmount = true;
    return;
  }

  if (state.awaitingAmount) {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 25 || amount > 50000) {
      return ctx.reply("❌ Invalid amount! Please enter between 25 and 50000 USDT.");
    }
    state.amount = amount;
    state.awaitingAmount = false;

    try {
      const txn = await client.createTransaction({
        currency1: "USDT",
        currency2: "USDT",
        amount: amount,
        buyer_email: "azelchillexa@gmail.com",
      });

      ctx.replyWithMarkdown(
        `✅ *Transaction Created!*\n\n💰 *Amount:* ${amount} USDT\n🌐 *Network:* ${state.network.toUpperCase()}\n💳 *Payment:* ${state.method}\n📧 *Details:* ${state.paymentDetails}\n\n➡️ *Send your USDT to:*\n\`${txn.address}\`\n\n🔗 [View on CoinPayments](${txn.status_url})`
      );
    } catch (err) {
      ctx.reply(`❌ Failed to create CoinPayments transaction: ${err.message}`);
    }
  }
});

app.get("/", (req, res) => res.send("✅ Telegram USDT Sell Bot is running"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

bot.launch();
console.log("🤖 Bot is running...");
