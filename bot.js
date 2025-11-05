require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

// --- BOT AND API INITIALIZATION ---

// Check for essential environment variables
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.COINPAYMENTS_PUBLIC_KEY || !process.env.COINPAYMENTS_PRIVATE_KEY || !process.env.ADMIN_CHAT_ID) {
    console.error("FATAL ERROR: Missing required environment variables. Please check your .env file and ensure ADMIN_CHAT_ID is set.");
    process.exit(1);
}

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Initialize CoinPayments Client
const coinpayments = new CoinPayments({
    key: process.env.COINPAYMENTS_PUBLIC_KEY,
    secret: process.env.COINPAYMENTS_PRIVATE_KEY,
});

// Set bot commands for the menu button
bot.setMyCommands([
    { command: 'start', description: '🚀 Start a new transaction' },
    { command: 'referral', description: '🤝 Check your referral status and link' },
    { command: 'find', description: '🔍 Find transaction by order number' },
    { command: 'help', description: '❓ How to use this bot (FAQ)' },
    { command: 'support', description: '💬 Contact a support agent' }
]);

// --- CONSTANTS AND CONFIGURATION ---

const MERCHANT_ID = '431eb6f352649dfdcde42b2ba8d5b6d8'; // Your Merchant ID
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com'; // Your refund email
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ID of the admin receiving support requests

// Amount limits interpreted as USD-equivalent min/max for any coin
const MIN_USD_EQ = 25;     // $25 minimum
const MAX_USD_EQ = 50000;  // $50,000 maximum

const SUPPORT_CONTACT = '@DeanAbdullah'; // REPLACE WITH YOUR SUPPORT USERNAME

// --- Supported coins & network mapping (BNB removed) ---
const SUPPORTED_COINS = ['USDT', 'BTC', 'ETH'];
const COIN_NETWORK_MAP = {
  USDT: { TRC20: 'USDT.TRC20', ERC20: 'USDT.ERC20' },
  BTC:  { MAIN:  'BTC' },
  ETH:  { MAIN:  'ETH' }
};

// --- Fixed USDT policy (your requested rates) ---
const FIXED_USDT_USD = 1.12; // 1 USDT = 1.12 USD
const FIXED_USDT_EUR = 0.98; // 1 USDT = 0.98 EUR
const FIXED_USDT_GBP = 0.86; // 1 USDT = 0.86 GBP

// REFERRAL CONSTANTS
const REFERRAL_REWARD_USDT = 1.2;
const MIN_REFERRAL_WITHDRAWAL_USDT = 50;

// Track last message IDs for editing
const lastMessageIds = {};

// Order number tracking
let orderCounter = 1000;
const transactionRecords = {}; // Store transaction records by order number

// --- IN-MEMORY STATE (MOCK DATABASE) ---

// User conversation state
const userStates = {};

// Referral tracking (should be persistent in production)
const referralData = {}; 

// Admin reply map
const adminReplyMap = {};

// --- HELPER FUNCTIONS ---

// Live rates cache + fetcher using CoinPayments "rates" (BTC-base) for BTC/ETH; USDT uses fixed rates above
let lastRates = null;
let lastRatesAt = 0;
const RATES_TTL_MS = 60 * 1000; // cache for 60s

async function fetchLiveRates() {
    const now = Date.now();
    if (lastRates && (now - lastRatesAt) < RATES_TTL_MS) return lastRates;

    const raw = await coinpayments.rates({ short: 1 }); // BTC-based 'rate_btc'
    const get = s => raw[s] && raw[s].rate_btc ? parseFloat(raw[s].rate_btc) : null;

    const rUSD = get('USD');
    const rEUR = get('EUR');
    const rGBP = get('GBP');
    if (!rUSD || !rEUR || !rGBP) throw new Error('Missing fiat anchors from CoinPayments rates');

    const price = (symbol, fiatRateBTC) => {
        const v = get(symbol);
        return v ? (v / fiatRateBTC) : null;
    };

    const result = {
        USD: {
            BTC: price('BTC', rUSD),
            ETH: price('ETH', rUSD),
            USDT: FIXED_USDT_USD, // fixed per request
        },
        EUR: {
            BTC: price('BTC', rEUR),
            ETH: price('ETH', rEUR),
            USDT: FIXED_USDT_EUR, // fixed per request
        },
        GBP: {
            BTC: price('BTC', rGBP),
            ETH: price('ETH', rGBP),
            USDT: FIXED_USDT_GBP, // fixed per request
        },
    };

    lastRates = result;
    lastRatesAt = now;
    return result;
}

// calculate received fiat; USDT uses fixed rates; BTC/ETH use live
async function calculateFiatLive(coinSymbol, coinAmount, fiatCurrency) {
    if (coinSymbol === 'USDT') {
        if (fiatCurrency === 'USD') return coinAmount * FIXED_USDT_USD;
        if (fiatCurrency === 'EUR') return coinAmount * FIXED_USDT_EUR;
        if (fiatCurrency === 'GBP') return coinAmount * FIXED_USDT_GBP;
    }
    const rates = await fetchLiveRates();
    const px = rates[fiatCurrency]?.[coinSymbol];
    if (!px) return 0;
    return coinAmount * px;
}

// Generate unique order number
function generateOrderNumber() {
    const timestamp = Date.now().toString().slice(-6);
    const orderNumber = `ORD${orderCounter++}${timestamp}`;
    return orderNumber;
}

// Store transaction record
function storeTransactionRecord(orderNumber, transactionData) {
    transactionRecords[orderNumber] = {
        ...transactionData,
        orderNumber,
        timestamp: new Date().toISOString(),
        status: 'pending'
    };
}

// Find transaction by order number
function findTransactionByOrderNumber(orderNumber) {
    return transactionRecords[orderNumber];
}

// Current formatted date/time
function getCurrentDateTime() {
    const now = new Date();
    const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${date} - ${time}`;
}

// Initialize referral data
function initializeReferralData(userId) {
    if (!referralData[userId]) {
        referralData[userId] = {
            referrerId: null,
            balance: 0,
            referredCount: 0,
            isReferralRewardClaimed: false,
        };
    }
}

// Reward referrer + notify
function rewardReferrer(referrerId, referredUserId) {
    if (referrerId && referralData[referrerId]) {
        referralData[referrerId].balance += REFERRAL_REWARD_USDT;
        referralData[referrerId].referredCount += 1;
        bot.sendMessage(referrerId, `🎉 *Referral Reward!* You earned *${REFERRAL_REWARD_USDT.toFixed(1)} USDT* from user \`${referredUserId}\`. New balance: *${referralData[referrerId].balance.toFixed(2)} USDT*.`, { parse_mode: 'Markdown' });
        return true;
    }
    return false;
}

// Notify admin of new user
function notifyAdminNewUser(userId, userInfo, referredBy = null) {
    const referralInfo = referredBy ? `\n*Referred by:* \`${referredBy}\`` : '';
    const notificationMessage = `
🆕 *NEW USER JOINED*

*User ID:* \`${userId}\`
*User Info:* ${userInfo}
*Join Time:* ${getCurrentDateTime()}${referralInfo}

Total users: ${Object.keys(referralData).length}
    `;
    bot.sendMessage(ADMIN_CHAT_ID, notificationMessage, { parse_mode: 'Markdown' });
}

// Review summary (live)
async function formatPaymentDetailsLive(userState, orderNumber = null) {
    const { amount, fiat, network, paymentMethod, paymentDetails, coin } = userState;
    const fiatToReceive = await calculateFiatLive(coin || 'USDT', amount, fiat);
    const orderInfo = orderNumber ? `*Order Number:* #${orderNumber}\n\n` : '';
    return `
📋 *TRANSACTION SUMMARY*

${orderInfo}*Selling:* ${amount} ${coin || 'USDT'}
*Network:* ${network}
*Currency to Receive:* ${fiat}
*Amount to Receive (current):* ${fiatToReceive.toFixed(2)} ${fiat}
*Payment Method:* ${paymentMethod}
*Payment Details:* 
\`${paymentDetails}\`
`;
}

// Send or edit message (tracked)
async function sendOrEditMessage(chatId, text, options = {}) {
    try {
        if (lastMessageIds[chatId]) {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: lastMessageIds[chatId],
                parse_mode: 'Markdown',
                ...options
            });
        } else {
            const sentMessage = await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                ...options
            });
            lastMessageIds[chatId] = sentMessage.message_id;
        }
    } catch (error) {
        if (error.response && error.response.statusCode === 400) {
            const sentMessage = await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                ...options
            });
            lastMessageIds[chatId] = sentMessage.message_id;
        } else {
            throw error;
        }
    }
}

// Clear tracked message id
function clearLastMessage(chatId) {
    delete lastMessageIds[chatId];
}

// Loading toast
async function showLoadingMessage(chatId, duration = 1200) {
    const loadingMessage = await bot.sendMessage(chatId, "⏳ One moment… updating things for you.");
    return new Promise((resolve) => {
        setTimeout(async () => {
            try { await bot.deleteMessage(chatId, loadingMessage.message_id); } catch (error) {}
            resolve();
        }, duration);
    });
}

// --- TRUST / ABOUT TEXT ---
const ABOUT_TEXT = `
🛡️ *About & Safety*

• *Non-Custodial Flow:* You only send funds to a dedicated address generated for your order.  
• *Order Tracking:* Every transaction has a unique order number (e.g., ORD1000123456).  
• *Secure Processor:* We rely on reputable payment rails and industry-standard crypto tooling.  
• *Human Support:* Real people available via */support* if anything feels unclear.  
• *Transparent Quotes:* Live estimates with a dedicated *Refresh rates* button.

_Pro tip:_ Always verify the *coin* and *network* before sending. If unsure, ask us first!
`;

// --- BOT COMMANDS AND MESSAGE HANDLERS ---

// /start (supports referrals)
bot.onText(/\/start\s?(\d+)?/, async (msg, match) => { 
    const chatId = msg.chat.id;
    const referredBy = match ? match[1] : null;
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username ? `@${msg.from.username}` : 'N/A';
    const dateTime = getCurrentDateTime(); 

    const isNewUser = !referralData[chatId];
    initializeReferralData(chatId);

    if (referredBy && referredBy !== chatId.toString()) {
        const referrerIdStr = referredBy.toString();
        if (referralData[referrerIdStr] && !referralData[chatId].referrerId) {
            referralData[chatId].referrerId = referrerIdStr;
            bot.sendMessage(chatId, `🤝 Sweet — you joined with a referral from \`${referrerIdStr}\`! Once you complete your first transaction, they’ll get a reward.`, { parse_mode: 'Markdown' });
        }
    }
    
    userStates[chatId] = {};
    clearLastMessage(chatId);

    if (isNewUser) {
        const userInfo = `${firstName} ${lastName} (${username})`;
        notifyAdminNewUser(chatId, userInfo, referredBy);
    }

    const welcomeMessage = 
`Hey *${firstName}*! 👋

Welcome to your friendly crypto off-ramp.  
I can help you sell *BTC, ETH, or USDT* and receive *USD, EUR, or GBP* — fast and simple.

*It’s currently:* _${dateTime}_

Ready to go? Tap a button below 👇`;

    await sendOrEditMessage(chatId, welcomeMessage, {
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Start selling", callback_data: 'start_sell' }],
                [{ text: "ℹ️ About & Safety", callback_data: 'show_about' }],
                [{ text: "🔍 Find Transaction", callback_data: 'find_transaction' }],
                [{ text: "📖 GUIDE / FAQ", callback_data: 'show_help' }]
            ]
        }
    });
});

// /find
bot.onText(/\/find/, (msg) => {
    const chatId = msg.chat.id;
    userStates[chatId] = { awaiting: 'order_number_search' };
    sendOrEditMessage(chatId, "🔎 *Find your order*\n\nPlease enter your order number (e.g., ORD1000123456):");
});

// /referral
bot.onText(/\/referral/, async (msg) => {
    const chatId = msg.chat.id;
    initializeReferralData(chatId);

    const { balance, referredCount } = referralData[chatId];
    
    let botUsername = 'Crypto_Seller_Bot';
    try {
        const me = await bot.getMe();
        botUsername = me.username;
    } catch (e) {
        console.error("Could not fetch bot username:", e);
    }
    
    const referralLink = `https://t.me/${botUsername}?start=${chatId}`;
    const isReadyToWithdraw = balance >= MIN_REFERRAL_WITHDRAWAL_USDT;
    const missingAmount = MIN_REFERRAL_WITHDRAWAL_USDT - balance;
    
    let withdrawalButton = [];
    if (isReadyToWithdraw) {
        withdrawalButton.push([{ text: `💰 Withdraw ${balance.toFixed(2)} USDT`, callback_data: 'withdraw_referral' }]);
    } 

    const message = `
*🤝 Referral Program*

• *Your ID:* \`${chatId}\`  
• *Your Link:* \`${referralLink}\`

• *Balance:* *${balance.toFixed(2)} USDT*  
• *Successful Referrals:* *${referredCount}*  
• *Reward per Referral:* *${REFERRAL_REWARD_USDT.toFixed(1)} USDT*  

*Withdrawal Minimum:* ${MIN_REFERRAL_WITHDRAWAL_USDT} USDT  
${isReadyToWithdraw ? "🎉 You're ready to withdraw!" : `Keep going — you need *${missingAmount.toFixed(2)} USDT* more to withdraw.`}
    `;

    sendOrEditMessage(chatId, message, {
        reply_markup: {
            inline_keyboard: [
                ...withdrawalButton,
                [{ text: "🔙 Back to Menu", callback_data: 'start_sell' }]
            ]
        }
    });
});

// /help
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `
*📖 GUIDE / FAQ*

*1) Start*  
Use \`/start\` → pick the coin (BTC/ETH/USDT) → choose payout currency (USD/EUR/GBP).

*2) Network*  
Pick the correct network (USDT on TRC20/ERC20; BTC and ETH are mainnet).  
*Sending to the wrong network can result in loss of funds.*

*3) Amount*  
Enter the amount. We show a live estimate (USDT uses fixed rates you see below).  
*Min:* $${MIN_USD_EQ} | *Max:* $${MAX_USD_EQ}.

*4) Payout Method*  
Wise, Revolut, PayPal, Bank Transfer, Skrill/Neteller, Card, Payeer, Alipay.

*5) Review & Confirm*  
We summarize everything. If all good, we generate your unique deposit address.

*6) Send & Track*  
Send the exact amount and keep your *Order Number* to check status with \`/find\`.

${ABOUT_TEXT}
    `;
    sendOrEditMessage(chatId, helpMessage);
});

// /support
bot.onText(/\/support/, (msg) => {
    const chatId = msg.chat.id;
    if (userStates[chatId] && userStates[chatId].awaiting) {
        bot.sendMessage(chatId, "⚠️ You’re in the middle of a transaction. Please /start a new one or finish first, then message support.");
        return;
    }
    userStates[chatId] = { awaiting: 'support_message' };
    sendOrEditMessage(chatId, "💬 *Tell us what you need*\n\nType your question or issue below in one message. A human will reply here soon.", {
        reply_markup: { force_reply: true, selective: true }
    });
});

// Callback queries
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    if (!userStates[chatId]) userStates[chatId] = {};
    initializeReferralData(chatId);

    if (userStates[chatId].awaiting === 'support_message') {
        delete userStates[chatId].awaiting;
    }

    if (data === 'show_help') {
        bot.getMe().then(() => {
             bot.processUpdate({ update_id: 0, message: { ...msg, text: '/help', entities: [{type: 'bot_command', offset: 0, length: 5}] }});
        });
    } else if (data === 'show_about') {
        sendOrEditMessage(chatId, ABOUT_TEXT, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔙 Back", callback_data: 'start_sell' }]
                ]
            }
        });
    } else if (data === 'find_transaction') {
        bot.getMe().then(() => {
             bot.processUpdate({ update_id: 0, message: { ...msg, text: '/find', entities: [{type: 'bot_command', offset: 0, length: 5}] }});
        });

    // Start or Refresh rates
    } else if (data === 'start_sell' || data === 'refresh_rates') {
        await showLoadingMessage(chatId);

        // Live panel: BTC & ETH live; USDT fixed
        let pricesLine = '';
        try {
            const live = await fetchLiveRates();
            const pUSD = live.USD;
            pricesLine =
              `\n*Rates (approx)*\n` +
              `• 1 BTC ≈ $${(pUSD.BTC ?? 0).toFixed(2)}\n` +
              `• 1 ETH ≈ $${(pUSD.ETH ?? 0).toFixed(2)}\n` +
              `• 1 USDT = $${FIXED_USDT_USD.toFixed(2)}  *(fixed)*\n` +
              `• 1 USDT = €${FIXED_USDT_EUR.toFixed(2)}  *(fixed)*\n` +
              `• 1 USDT = £${FIXED_USDT_GBP.toFixed(2)}  *(fixed)*`;
        } catch (e) {
            pricesLine =
              `\n_Live BTC/ETH unavailable right now._\n` +
              `• 1 USDT = $${FIXED_USDT_USD.toFixed(2)} *(fixed)*\n` +
              `• 1 USDT = €${FIXED_USDT_EUR.toFixed(2)} *(fixed)*\n` +
              `• 1 USDT = £${FIXED_USDT_GBP.toFixed(2)} *(fixed)*`;
        }

        sendOrEditMessage(chatId,
          `What are you selling today? 😊${pricesLine}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "₿ Bitcoin (BTC)", callback_data: 'coin_BTC' },
                 { text: "Ξ Ethereum (ETH)", callback_data: 'coin_ETH' }],
                [{ text: "💎 Tether (USDT)", callback_data: 'coin_USDT' }],
                [{ text: "🔄 Refresh rates", callback_data: 'refresh_rates' }],
                [{ text: "🔍 Find Transaction", callback_data: 'find_transaction' }],
                [{ text: "📖 GUIDE / FAQ", callback_data: 'show_help' }]
              ]
            }
          }
        );

    } else if (data === 'cancel') {
        sendOrEditMessage(chatId, "No worries! Whenever you’re ready, just send /start to begin again.");
        delete userStates[chatId];

    // Coin selection → fiat selection
    } else if (data.startsWith('coin_')) {
        const coin = data.split('_')[1]; // BTC/ETH/USDT
        userStates[chatId].coin = coin;

        sendOrEditMessage(chatId, `✅ Great — *${coin}* selected.\n\nWhich currency would you like to receive?`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🇺🇸 USD", callback_data: 'fiat_USD' },
                     { text: "🇪🇺 EUR", callback_data: 'fiat_EUR' },
                     { text: "🇬🇧 GBP", callback_data: 'fiat_GBP' }]
                ]
            }
        });

    // Fiat selection → network (depends on coin)
    } else if (data.startsWith('fiat_')) {
        await showLoadingMessage(chatId);
        
        const currency = data.split('_')[1];
        userStates[chatId].fiat = currency;

        const c = userStates[chatId].coin || 'USDT';
        if (c === 'USDT') {
            sendOrEditMessage(chatId, `✅ *${currency}* selected.\n\nPlease pick your ${c} network:`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "TRC20 (Tron)", callback_data: 'net_TRC20' }],
                        [{ text: "ERC20 (Ethereum)", callback_data: 'net_ERC20' }]
                    ]
                }
            });
        } else if (c === 'BTC') {
            userStates[chatId].network = 'MAIN';
            userStates[chatId].awaiting = 'amount';
            sendOrEditMessage(chatId, `✅ BTC (Bitcoin mainnet).\n\nPlease enter the *amount of BTC* to sell.\n\n*Minimum:* $${MIN_USD_EQ}\n*Maximum:* $${MAX_USD_EQ}`);
        } else if (c === 'ETH') {
            userStates[chatId].network = 'MAIN';
            userStates[chatId].awaiting = 'amount';
            sendOrEditMessage(chatId, `✅ ETH (Ethereum mainnet).\n\nPlease enter the *amount of ETH* to sell.\n\n*Minimum:* $${MIN_USD_EQ}\n*Maximum:* $${MAX_USD_EQ}`);
        }

    // Network picked (TRC20/ERC20) → ask for amount
    } else if (data.startsWith('net_')) {
        await showLoadingMessage(chatId);
        
        const net = data.split('_')[1]; // TRC20/ERC20
        userStates[chatId].network = net;
        userStates[chatId].awaiting = 'amount';

        const coin = userStates[chatId].coin || 'USDT';
        sendOrEditMessage(chatId,
          `✅ ${coin} on *${userStates[chatId].network}*.\n\nPlease enter the amount of *${coin}* you want to sell.\n\n*Minimum:* $${MIN_USD_EQ}\n*Maximum:* $${MAX_USD_EQ}`
        );

    } else if (data.startsWith('pay_')) {
        await showLoadingMessage(chatId);
        
        const method = data.split('_')[1];
        let prompt = '';
        
        if (method !== 'bank' && method !== 'skrill') {
            userStates[chatId].paymentMethod = method;
        }

        switch (method) {
            case 'wise':
                prompt = '✅ *Wise Selected*\n\nPlease share your *Wise email* or *@wisetag*:';
                userStates[chatId].awaiting = 'wise_details';
                break;
            case 'revolut':
                prompt = '✅ *Revolut Selected*\n\nPlease share your *Revolut tag* (e.g., @username):';
                userStates[chatId].awaiting = 'revolut_details';
                break;
            case 'paypal':
                prompt = '✅ *PayPal Selected*\n\nPlease share your *PayPal email address*:';
                userStates[chatId].awaiting = 'paypal_details';
                break;
            case 'bank':
                sendOrEditMessage(chatId, "✅ *Bank Transfer Selected*\n\nPlease choose your bank’s region:", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🇪🇺 European Bank", callback_data: 'bank_eu' }],
                            [{ text: "🇺🇸 US Bank", callback_data: 'bank_us' }]
                        ]
                    }
                });
                break;
            case 'skrill':
                sendOrEditMessage(chatId, "✅ *Skrill/Neteller Selected*\n\nWhich one are you using?", {
                   reply_markup: {
                        inline_keyboard: [
                            [{ text: "Skrill", callback_data: 'payout_skrill' }],
                            [{ text: "Neteller", callback_data: 'payout_neteller' }]
                        ]
                   }
                });
                break;
            case 'card':
                prompt = '✅ *Card Payment Selected*\n\nPlease share your *Visa or Mastercard number*:';
                userStates[chatId].awaiting = 'card_details';
                break;
            case 'payeer':
                prompt = '✅ *Payeer Selected*\n\nPlease share your *Payeer Number* (e.g., P12345678):';
                userStates[chatId].awaiting = 'payeer_details';
                break;
            case 'alipay':
                prompt = '✅ *Alipay Selected*\n\nPlease share your *Alipay email*:';
                userStates[chatId].awaiting = 'alipay_details';
                break;
        }
        if (prompt) sendOrEditMessage(chatId, prompt);

    } else if (data.startsWith('payout_')) {
        await showLoadingMessage(chatId);
        
        const method = data.split('_')[1]; // 'skrill' or 'neteller'
        userStates[chatId].paymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
        userStates[chatId].awaiting = 'skrill_neteller_details';
        sendOrEditMessage(chatId, `✅ *${userStates[chatId].paymentMethod} Selected*\n\nPlease share your *${userStates[chatId].paymentMethod} email*:`);

    } else if (data.startsWith('bank_')) {
        await showLoadingMessage(chatId);
        
        const region = data.split('_')[1]; // 'eu' or 'us'
        userStates[chatId].paymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        if (region === 'eu') {
            userStates[chatId].awaiting = 'bank_details_eu';
            const prompt = '✅ *European Bank Transfer*\n\nReply in one message:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            sendOrEditMessage(chatId, prompt);
        } else if (region === 'us') {
            userStates[chatId].awaiting = 'bank_details_us';
            const prompt = '✅ *US Bank Transfer*\n\nReply in one message:\n\n`Account Holder Name:\nAccount Number:\nRouting Number (ACH or ABA):`';
            sendOrEditMessage(chatId, prompt);
        }

    } else if (data === 'confirm_transaction') {
        await showLoadingMessage(chatId);
        userStates[chatId].awaiting = null;
        sendOrEditMessage(chatId, "🔐 Thanks! Creating a secure deposit address for you…");
        generateDepositAddress(chatId);
        
    } else if (data === 'edit_transaction') {
        await showLoadingMessage(chatId);
        sendOrEditMessage(chatId, "No problem — let’s restart. Send /start when you’re ready.");
        delete userStates[chatId];

    } else if (data === 'withdraw_referral') {
        await showLoadingMessage(chatId);
        
        const { balance } = referralData[chatId];
        if (balance < MIN_REFERRAL_WITHDRAWAL_USDT) {
             sendOrEditMessage(chatId, `❌ Minimum to withdraw is *${MIN_REFERRAL_WITHDRAWAL_USDT} USDT*. Your balance is *${balance.toFixed(2)} USDT*.`);
             bot.answerCallbackQuery(callbackQuery.id);
             return;
        }

        userStates[chatId].awaiting = 'referral_withdrawal_payment_selection';
        userStates[chatId].withdrawalAmount = balance;

        const message = `*💰 Withdraw Referral Balance*\n\nBalance to withdraw: *${balance.toFixed(2)} USDT*.\nPick your preferred payout method:`;

        sendOrEditMessage(chatId, message, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Wise", callback_data: 'refpay_wise' }, { text: "Revolut", callback_data: 'refpay_revolut' }],
                    [{ text: "PayPal", callback_data: 'refpay_paypal' }, { text: "Bank Transfer", callback_data: 'refpay_bank' }],
                    [{ text: "Skrill/Neteller", callback_data: 'refpay_skrill' }, { text: "Visa/Mastercard", callback_data: 'refpay_card' }],
                    [{ text: "Payeer", callback_data: 'refpay_payeer' }, { text: "Alipay", callback_data: 'refpay_alipay' }]
                ]
            }
        });

    } else if (data.startsWith('refpay_')) {
        await showLoadingMessage(chatId);
        
        const method = data.split('_')[1];
        let prompt = '';
        
        userStates[chatId].isReferralWithdrawal = true;
        userStates[chatId].referralPaymentMethod = method;

        switch (method) {
            case 'wise':
                prompt = '✅ *Wise Selected*\n\nPlease share your *Wise email* or *@wisetag*:';
                userStates[chatId].awaiting = 'ref_wise_details';
                break;
            case 'revolut':
                prompt = '✅ *Revolut Selected*\n\nPlease share your *Revolut tag* (e.g., @username):';
                userStates[chatId].awaiting = 'ref_revolut_details';
                break;
            case 'paypal':
                prompt = '✅ *PayPal Selected*\n\nPlease share your *PayPal email address*:';
                userStates[chatId].awaiting = 'ref_paypal_details';
                break;
            case 'bank':
                sendOrEditMessage(chatId, "✅ *Bank Transfer Selected*\n\nPlease choose your bank’s region:", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🇪🇺 European Bank", callback_data: 'refbank_eu' }],
                            [{ text: "🇺🇸 US Bank", callback_data: 'refbank_us' }]
                        ]
                    }
                });
                break;
            case 'skrill':
                sendOrEditMessage(chatId, "✅ *Skrill/Neteller Selected*\n\nWhich one are you using?", {
                   reply_markup: {
                        inline_keyboard: [
                            [{ text: "Skrill", callback_data: 'refpayout_skrill' }],
                            [{ text: "Neteller", callback_data: 'refpayout_neteller' }]
                        ]
                   }
                });
                break;
            case 'card':
                prompt = '✅ *Card Payment Selected*\n\nPlease share your *Visa or Mastercard number*:';
                userStates[chatId].awaiting = 'ref_card_details';
                break;
            case 'payeer':
                prompt = '✅ *Payeer Selected*\n\nPlease share your *Payeer Number* (e.g., P12345678):';
                userStates[chatId].awaiting = 'ref_payeer_details';
                break;
            case 'alipay':
                prompt = '✅ *Alipay Selected*\n\nPlease share your *Alipay email*:';
                userStates[chatId].awaiting = 'ref_alipay_details';
                break;
        }
        if (prompt) sendOrEditMessage(chatId, prompt);
        
    } else if (data.startsWith('refpayout_')) {
        await showLoadingMessage(chatId);
        
        const method = data.split('_')[1]; // 'skrill' or 'neteller'
        userStates[chatId].referralPaymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
        userStates[chatId].awaiting = 'ref_skrill_neteller_details';
        sendOrEditMessage(chatId, `✅ *${userStates[chatId].referralPaymentMethod} Selected*\n\nPlease share your *${userStates[chatId].referralPaymentMethod} email*:`);

    } else if (data.startsWith('refbank_')) {
        await showLoadingMessage(chatId);
        
        const region = data.split('_')[1]; // 'eu' or 'us'
        userStates[chatId].referralPaymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        if (region === 'eu') {
            userStates[chatId].awaiting = 'ref_bank_details_eu';
            const prompt = '✅ *European Bank Transfer*\n\nReply in one message:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            sendOrEditMessage(chatId, prompt);
        } else if (region === 'us') {
            userStates[chatId].awaiting = 'ref_bank_details_us';
            const prompt = '✅ *US Bank Transfer*\n\nReply in one message:\n\n`Account Holder Name:\nAccount Number:\nRouting Number (ACH or ABA):`';
            sendOrEditMessage(chatId, prompt);
        }
    }

    bot.answerCallbackQuery(callbackQuery.id);
});

// Create deposit address (coin/network-aware)
async function generateDepositAddress(chatId) {
    const userState = userStates[chatId];
    
    try {
        const coin = userState.coin || 'USDT';
        const net = userState.network || 'MAIN';

        let coinCurrency;
        if (coin === 'USDT') {
            coinCurrency = COIN_NETWORK_MAP.USDT[net]; // TRC20/ERC20
        } else if (coin === 'BTC') {
            coinCurrency = COIN_NETWORK_MAP.BTC.MAIN;  // BTC
        } else if (coin === 'ETH') {
            coinCurrency = COIN_NETWORK_MAP.ETH.MAIN;  // ETH
        }
        if (!coinCurrency) throw new Error(`Unsupported coin/network: ${coin} ${net}`);

        const paymentMethodForCustom = userState.paymentMethod || 'Unknown';
        const orderNumber = generateOrderNumber();
        
        const transactionOptions = {
            currency1: coin,          // pricing unit (the coin they're selling)
            currency2: coinCurrency,  // the chain asset the user will send
            amount: userState.amount,
            buyer_email: BUYER_REFUND_EMAIL,
            custom: `Order: ${orderNumber} | ${coin}/${net} | Payout to ${paymentMethodForCustom}: ${userState.paymentDetails}`,
            item_name: `Sell ${userState.amount} ${coin} for ${userState.fiat}`,
            ipn_url: 'YOUR_IPN_WEBHOOK_URL'
        };

        const result = await coinpayments.createTransaction(transactionOptions);

        // Store transaction record
        storeTransactionRecord(orderNumber, {
            userId: chatId,
            amount: userState.amount,
            fiat: userState.fiat,
            network: userState.network,
            coin,
            paymentMethod: paymentMethodForCustom,
            paymentDetails: userState.paymentDetails,
            coinpaymentsTxnId: result.txn_id,
            depositAddress: result.address,
            timestamp: new Date().toISOString()
        });

        // Referral reward simulation
        const referrerId = referralData[chatId]?.referrerId;
        if (referrerId) {
            if (!referralData[chatId].isReferralRewardClaimed) {
                rewardReferrer(referrerId, chatId);
                referralData[chatId].isReferralRewardClaimed = true;
            }
        }

        const depositInfo = 
            `✅ *Deposit Address Ready!*\n\n` +
            `*Order Number:* #${orderNumber}\n*Transaction ID:* ${result.txn_id}\n\n` +
            `Please send exactly *${result.amount} ${coin}* (${net}) to:\n\n` +
            `\`${result.address}\`\n\n` +
            `⏳ *Waiting for network confirmations…*\n\n` +
            `*Payout Method:* ${paymentMethodForCustom}\n` +
            `*Payout Details:* \n\`${userState.paymentDetails}\`\n\n` +
            `⚠️ *Important:* Send only ${coin} on the ${net} network to this address. Other assets or networks may result in loss of funds.\n\n` +
            `💡 *Tip:* Save your order number (#${orderNumber}) to check status with \`/find\`.`;

        sendOrEditMessage(chatId, depositInfo);
        delete userStates[chatId];

    } catch (error) {
        console.error("CoinPayments API Error:", error);
        sendOrEditMessage(chatId, "❌ Sorry — something went wrong while generating your deposit address. Please try again or contact */support*.");
    }
}

// Message handler (support, order search, amount & payout details)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userState = userStates[chatId];
    initializeReferralData(chatId);

    // Admin reply
    if (msg.reply_to_message && chatId.toString() === ADMIN_CHAT_ID) {
        const forwardedMessageId = msg.reply_to_message.message_id;
        const originalUserChatId = adminReplyMap[forwardedMessageId];

        if (originalUserChatId) {
            try {
                await bot.sendMessage(originalUserChatId, `📢 *Support Reply*\n\n${text}`, { parse_mode: 'Markdown' });
                await bot.sendMessage(chatId, "✅ Reply sent to user.");
                delete adminReplyMap[forwardedMessageId]; 
            } catch (e) {
                console.error("Error sending reply back to user:", e);
                await bot.sendMessage(chatId, "❌ Couldn’t deliver reply. The user may have blocked the bot.");
            }
        } else {
            bot.sendMessage(chatId, "Hmm, I can’t match that reply to an active support ticket.");
        }
        return;
    }

    // Ignore commands
    if (!text || text.startsWith('/')) return;

    // Support message
    if (userState && userState.awaiting === 'support_message') {
        const supportText = text;
        const userInfo = `User ID: ${msg.from.id}, Name: ${msg.from.first_name || ''} ${msg.from.last_name || ''}, Username: @${msg.from.username || 'N/A'}`;
        const forwardedMessage = `*🚨 NEW SUPPORT REQUEST*\n\nFrom: ${userInfo}\n\n*Message:* \n${supportText}\n\n--- \n_Reply to this message to respond to the user._`;
        
        try {
            const sentMessage = await bot.sendMessage(ADMIN_CHAT_ID, forwardedMessage, { parse_mode: 'Markdown' });
            adminReplyMap[sentMessage.message_id] = chatId;

            sendOrEditMessage(chatId, "✅ Thanks! Your message is with support. We’ll reply here shortly. You can also */start* a new transaction anytime.");
            delete userStates[chatId]; 
        } catch (error) {
            console.error("Error forwarding support message:", error);
            sendOrEditMessage(chatId, "❌ Sorry, we couldn’t reach support right now. Please try again later.");
        }
        return;
    }

    // Order search
    if (userState && userState.awaiting === 'order_number_search') {
        const orderNumber = text.trim().toUpperCase();
        const transaction = findTransactionByOrderNumber(orderNumber);
        
        if (transaction) {
            const transactionInfo = `
🔍 *Transaction Found*

*Order Number:* #${transaction.orderNumber}
*Transaction ID:* ${transaction.coinpaymentsTxnId}
*Coin:* ${transaction.coin || 'USDT'}
*Amount:* ${transaction.amount} ${transaction.coin || 'USDT'}
*Network:* ${transaction.network}
*Currency:* ${transaction.fiat}
*Payment Method:* ${transaction.paymentMethod}
*Status:* ${transaction.status}
*Date:* ${new Date(transaction.timestamp).toLocaleString()}
*Deposit Address:* \`${transaction.depositAddress}\`
            `;
            sendOrEditMessage(chatId, transactionInfo, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔙 Back to Menu", callback_data: 'start_sell' }]
                    ]
                }
            });
        } else {
            sendOrEditMessage(chatId, `❌ No transaction found with order number *${orderNumber}*.\nPlease check it and try again.`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔄 Try Again", callback_data: 'find_transaction' }],
                        [{ text: "🔙 Back to Menu", callback_data: 'start_sell' }]
                    ]
                }
            });
        }
        delete userStates[chatId];
        return;
    }

    // Transaction / Withdrawal flow
    if (userState && userState.awaiting) {
        const awaiting = userState.awaiting;

        // Amount input: validate using USD-equivalent (USDT uses fixed USD rate)
        if (awaiting === 'amount') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount <= 0) {
                sendOrEditMessage(chatId, `❌ That doesn’t look like a valid number. Please enter a positive amount.`);
                return;
            }

            const coin = userState.coin || 'USDT';

            // Validate min/max via USD value
            let usdValue = 0;
            try {
                if (coin === 'USDT') {
                    usdValue = amount * FIXED_USDT_USD;
                } else {
                    const liveUSD = (await fetchLiveRates()).USD;
                    const px = liveUSD[coin];
                    usdValue = px ? amount * px : 0;
                }
            } catch (_) {}

            if (!usdValue) {
                sendOrEditMessage(chatId, `❌ Couldn’t fetch pricing for ${coin}. Please try again in a moment.`);
                return;
            }
            if (usdValue < MIN_USD_EQ || usdValue > MAX_USD_EQ) {
                sendOrEditMessage(chatId, `❌ Amount out of range.\nYour ${amount} ${coin} ≈ $${usdValue.toFixed(2)}.\nPlease enter an amount worth between $${MIN_USD_EQ} and $${MAX_USD_EQ}.`);
                return;
            }

            userState.amount = amount;

            const fiatToReceive = await calculateFiatLive(coin, amount, userState.fiat || 'USD');
            const confirmationMessage = 
                `✅ *Amount confirmed:* ${amount} ${coin}\n\n` +
                `You’ll receive approximately *${fiatToReceive.toFixed(2)} ${userState.fiat}*.\n\n` +
                `Please choose your payout method:`;

            sendOrEditMessage(chatId, confirmationMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Wise", callback_data: 'pay_wise' }, { text: "Revolut", callback_data: 'pay_revolut' }],
                        [{ text: "PayPal", callback_data: 'pay_paypal' }, { text: "Bank Transfer", callback_data: 'pay_bank' }],
                        [{ text: "Skrill/Neteller", callback_data: 'pay_skrill' }, { text: "Visa/Mastercard", callback_data: 'pay_card' }],
                        [{ text: "Payeer", callback_data: 'pay_payeer' }, { text: "Alipay", callback_data: 'pay_alipay' }]
                    ]
                }
            });
            userState.awaiting = null; 

        } else if ([
            'wise_details', 'revolut_details', 'paypal_details', 'card_details', 
            'payeer_details', 'alipay_details', 'skrill_neteller_details', 
            'bank_details_eu', 'bank_details_us'
        ].includes(awaiting)) {

            // Main transaction details
            userState.paymentDetails = text;
            userState.awaiting = null;
            
            const orderNumber = generateOrderNumber();
            const reviewMessage = await formatPaymentDetailsLive(userState, orderNumber);
            
            sendOrEditMessage(chatId, reviewMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Continue & Generate Address", callback_data: 'confirm_transaction' }],
                        [{ text: "✏️ Edit Payment Details", callback_data: 'edit_transaction' }]
                    ]
                }
            });
            
        } else if ([
            'ref_wise_details', 'ref_revolut_details', 'ref_paypal_details', 'ref_card_details',
            'ref_payeer_details', 'ref_alipay_details', 'ref_skrill_neteller_details',
            'ref_bank_details_eu', 'ref_bank_details_us'
        ].includes(awaiting)) {

            // Referral withdrawal
            const withdrawalAmount = userState.withdrawalAmount;
            
            let paymentMethod = userState.referralPaymentMethod;
            if (awaiting.includes('ref_bank_details_')) {
                paymentMethod = awaiting.includes('_eu') ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
            } else if (awaiting === 'ref_skrill_neteller_details') {
                paymentMethod = userState.referralPaymentMethod;
            } else {
                paymentMethod = awaiting.split('_')[1];
                paymentMethod = paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1);
            }

            const paymentDetails = text;
            
            const adminNotification = `
*💰 NEW REFERRAL WITHDRAWAL REQUEST*

*User ID:* \`${chatId}\`
*Amount:* *${withdrawalAmount.toFixed(2)} USDT*
*Payment Method:* ${paymentMethod}
*Payment Details:*
\`\`\`
${paymentDetails}
\`\`\`
*Action:* Please process this payout manually.
            `;

            try {
                await bot.sendMessage(ADMIN_CHAT_ID, adminNotification, { parse_mode: 'Markdown' });
                if (referralData[chatId]) {
                    referralData[chatId].balance = 0;
                }
                sendOrEditMessage(chatId, 
                    `✅ *Withdrawal Request Submitted!*\n\n` +
                    `We’ve received your request to withdraw *${withdrawalAmount.toFixed(2)} USDT* via ${paymentMethod}.\n\n` +
                    `We’ll process it shortly. Check your remaining balance with \`/referral\`.`
                );
            } catch (error) {
                console.error("Referral withdrawal error:", error);
                sendOrEditMessage(chatId, "❌ Sorry — we couldn’t submit your withdrawal right now. Please try again later.");
            }
            
            delete userStates[chatId];
        }
    }
});

console.log("Bot is running...");
