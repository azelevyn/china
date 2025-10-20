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
    { command: 'help', description: '❓ How to use this bot (FAQ)' },
    { command: 'support', description: '💬 Contact a support agent' }
]);


// --- CONSTANTS AND CONFIGURATION ---

const MERCHANT_ID = '431eb6f352649dfdcde42b2ba8d5b6d8'; // Your Merchant ID
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com'; // Your refund email
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ID of the admin receiving support requests
const MIN_USDT = 25;
const MAX_USDT = 50000;
const SUPPORT_CONTACT = '@DeanAbdullah'; // REPLACE WITH YOUR SUPPORT USERNAME

// Conversion Rates (Rates are simplified for demonstration; in production, use a real-time oracle)
const RATES = {
    // USDT rates
    USDT_TO_USD: 1 / 1.08, 
    USD_TO_EUR: 0.89,
    USDT_TO_GBP: 0.77,

    // NEW Crypto Rates (Example/Placeholder - based on conversion to USDT equivalent)
    BTC_TO_USDT: 65000, // Example: 1 BTC = 65000 USDT
    ETH_TO_USDT: 3500,  // Example: 1 ETH = 3500 USDT
};

// NEW REFERRAL CONSTANTS
const REFERRAL_REWARD_USDT = 1.2;
const MIN_REFERRAL_WITHDRAWAL_USDT = 50;


// --- IN-MEMORY STATE (MOCK DATABASE) ---

// In-memory storage for user conversation state (for current transaction/support)
const userStates = {};

// In-memory storage for referral tracking (THIS SHOULD BE A PERSISTENT DATABASE IN PRODUCTION)
// Structure: { [userId]: { referrerId: string|null, balance: number, referredCount: number, isReferralRewardClaimed: boolean } }
const referralData = {}; 

// Map to link forwarded admin message ID back to the original user's chat ID
const adminReplyMap = {};


// --- HELPER FUNCTIONS ---

// Function to calculate the received amount for any crypto
function calculateFiat(amount, cryptoCurrency, fiatCurrency) {
    let amountInUSDT;

    if (cryptoCurrency === 'USDT') {
        amountInUSDT = amount;
    } else if (cryptoCurrency === 'BTC') {
        amountInUSDT = amount * RATES.BTC_TO_USDT;
    } else if (cryptoCurrency === 'ETH') {
        amountInUSDT = amount * RATES.ETH_TO_USDT;
    } else {
        return 0;
    }

    if (fiatCurrency === 'USD') {
        return amountInUSDT * RATES.USDT_TO_USD;
    }
    if (fiatCurrency === 'EUR') {
        // Convert total USD equivalent to EUR
        const amountInUSD = amountInUSDT * RATES.USDT_TO_USD;
        return amountInUSD * RATES.USD_TO_EUR;
    }
    if (fiatCurrency === 'GBP') {
        return amountInUSDT * RATES.USDT_TO_GBP;
    }
    return 0;
}

// Function to get current formatted date and time (24-hour format)
function getCurrentDateTime() {
    const now = new Date();
    const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${date} - ${time}`;
}

// Function to initialize referral data if user is new
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

// Function to update referrer's balance and count and notify them
function rewardReferrer(referrerId, referredUserId) {
    if (referrerId && referralData[referrerId]) {
        referralData[referrerId].balance += REFERRAL_REWARD_USDT;
        referralData[referrerId].referredCount += 1;
        
        // Notify the referrer
        bot.sendMessage(referrerId, `🎉 *New Referral Reward!* You earned *${REFERRAL_REWARD_USDT.toFixed(1)} USDT* from a successful transaction by user \`${referredUserId}\`. Your new balance is *${referralData[referrerId].balance.toFixed(2)} USDT*.`, { parse_mode: 'Markdown' });
        return true;
    }
    return false;
}


// --- BOT COMMANDS AND MESSAGE HANDLERS ---

// Handler for the /start command (now supports deep linking for referrals)
bot.onText(/\/start\s?(\d+)?/, (msg, match) => { 
    const chatId = msg.chat.id;
    const referredBy = match ? match[1] : null; // Captured referral ID (referrer's chatId)
    const firstName = msg.from.first_name || '';
    const dateTime = getCurrentDateTime(); 

    // 1. Initialize user's referral data
    initializeReferralData(chatId);

    // 2. Check for referral link
    if (referredBy && referredBy !== chatId.toString()) {
        const referrerIdStr = referredBy.toString();
        // Check if referrer exists and user hasn't been linked already
        if (referralData[referrerIdStr] && !referralData[chatId].referrerId) {
            referralData[chatId].referrerId = referrerIdStr;
            bot.sendMessage(chatId, `🤝 You've been referred by user ID \`${referrerIdStr}\`! Once you complete your first transaction, your referrer will be rewarded.`, { parse_mode: 'Markdown' });
        }
    }
    
    // 3. Reset user transaction state
    userStates[chatId] = {};

    const welcomeMessage = `Hello, *${firstName}*!\n\nWelcome to the Crypto Seller Bot. Current time: *${dateTime}*.\n\nI can help you easily sell your crypto for fiat currency (USD, EUR, GBP).\n\nReady to start?`;

    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Yes, I want to sell Crypto", callback_data: 'start_sell' }],
                [{ text: " GUIDE: How to use the Bot", callback_data: 'show_help' }]
            ]
        }
    });
});

// Handler for the /referral command
bot.onText(/\/referral/, async (msg) => {
    const chatId = msg.chat.id;
    initializeReferralData(chatId); // Ensure data exists

    const { balance, referredCount } = referralData[chatId];
    
    // Fetch bot's username for accurate link generation
    let botUsername = 'USDT_Seller_Bot'; // Default placeholder
    try {
        const me = await bot.getMe();
        botUsername = me.username;
    } catch (e) {
        console.error("Could not fetch bot username:", e);
    }
    
    const referralLink = `https://t.me/${botUsername}?start=${chatId}`;
    
    // Check withdrawal readiness
    const isReadyToWithdraw = balance >= MIN_REFERRAL_WITHDRAWAL_USDT;
    const missingAmount = MIN_REFERRAL_WITHDRAWAL_USDT - balance;
    
    let withdrawalButton = [];
    if (isReadyToWithdraw) {
        withdrawalButton.push([{ text: `💰 Withdraw ${balance.toFixed(2)} USDT`, callback_data: 'withdraw_referral' }]);
    } 

    const message = `
*🤝 Referral Program Status*

*Your ID:* \`${chatId}\`
*Your Referral Link:* \`${referralLink}\`

*Current Balance:* *${balance.toFixed(2)} USDT*
*Successful Referrals:* *${referredCount}*
*Reward per Referral:* *${REFERRAL_REWARD_USDT.toFixed(1)} USDT*

*Withdrawal Minimum:* ${MIN_REFERRAL_WITHDRAWAL_USDT} USDT
${isReadyToWithdraw 
    ? "🎉 You are ready to withdraw your funds!" 
    : `Keep going! You need *${missingAmount.toFixed(2)} USDT* more to reach the withdrawal minimum.`}
    `;

    bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                ...withdrawalButton,
                [{ text: "🔙 Back to Main Menu", callback_data: 'start_sell' }]
            ]
        }
    });
});

// Handler for the /help command
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `
*❓ How to Use the Crypto Seller Bot (FAQ)*

This bot helps you convert your BTC, ETH, or USDT into USD, EUR, or GBP. Here is the step-by-step process:

*Step 1: Start a Transaction*
- Use the \`/start\` command to begin.
- Choose the cryptocurrency and the fiat currency you wish to receive.

*Step 2: Select the Network (USDT only)*
- If selling USDT, you will choose between TRC20 or ERC20.
- ⚠️ *CRITICAL:* You *must* choose the same network that your wallet uses. Sending on the wrong network will result in a loss of funds.

*Step 3: Enter the Amount*
- Enter the amount of crypto you want to sell (e.g., 0.001 BTC or 100 USDT).
- The transaction amount must be equivalent to a minimum of *${MIN_USDT} USDT* and a maximum of *${MAX_USDT} USDT*.

*Step 4: Choose Payout Method & Details*
- Select how you'd like to receive your money (Wise, PayPal, Bank Transfer, etc.).
- Provide the necessary payment details when prompted.

*Step 5: Deposit Crypto*
- The bot will generate a unique deposit address for you.
- Send the *exact* amount of crypto to this address.
- Once your transaction is confirmed on the blockchain, we will process your fiat payout.

*Need more help?*
Please write a direct message to our support team using the \`/support\` command.
    `;
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});


// New handler for the /support command
bot.onText(/\/support/, (msg) => {
    const chatId = msg.chat.id;
    // Check if user is already in a transaction flow
    if (userStates[chatId] && userStates[chatId].awaiting) {
        bot.sendMessage(chatId, "⚠️ You are currently in the middle of a transaction. Please finish or start a new transaction using `/start` before contacting support.");
        return;
    }
    
    userStates[chatId] = { awaiting: 'support_message' };
    bot.sendMessage(chatId, "💬 *Support Message*\n\nPlease type your question or issue in a single message. A support agent will reply to you as soon as possible.", {
        parse_mode: 'Markdown',
        reply_markup: {
            // Use Reply Keyboard to ensure the next message is handled correctly
            force_reply: true, 
            selective: true
        }
    });
});


// Handler for all callback queries from inline buttons
bot.on('callback_query', (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    // Initialize state if not present
    if (!userStates[chatId]) {
        userStates[chatId] = {};
    }
    initializeReferralData(chatId); // Ensure referral data exists

    // Clear any pending support state if the user clicks a transaction button
    if (userStates[chatId].awaiting === 'support_message') {
        delete userStates[chatId].awaiting;
    }

    if (data === 'show_help') {
        // Use the existing /help command handler
        bot.getMe().then(() => {
             bot.processUpdate({ update_id: 0, message: { ...msg, text: '/help', entities: [{type: 'bot_command', offset: 0, length: 5}]}});
        });
    } else if (data === 'start_sell') {
        // NEW: Step 1 - Choose Crypto
        const cryptoMessage = `🚀 Which cryptocurrency would you like to sell?`;
        bot.sendMessage(chatId, cryptoMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "₿ Bitcoin (BTC)", callback_data: 'crypto_BTC' }],
                    [{ text: "Ξ Ethereum (ETH)", callback_data: 'crypto_ETH' }],
                    [{ text: "₮ Tether (USDT)", callback_data: 'crypto_USDT' }]
                ]
            }
        });
    } else if (data === 'cancel') {
        bot.sendMessage(chatId, "No problem! Feel free to start again whenever you're ready by sending /start.");
        delete userStates[chatId]; // Clear all state
    } else if (data.startsWith('crypto_')) {
        // NEW: Step 2 - Store Crypto, Choose Fiat
        const crypto = data.split('_')[1];
        userStates[chatId].crypto = crypto;

        const ratesInfo = `You selected *${crypto}*.\n\n*Current Exchange Rates (Approximate):*\n- 1 USDT ≈ ${RATES.USDT_TO_USD.toFixed(3)} USD\n- 1 USDT ≈ ${(RATES.USDT_TO_USD * RATES.USD_TO_EUR).toFixed(3)} EUR\n- 1 USDT ≈ ${RATES.USDT_TO_GBP.toFixed(3)} GBP\n\nWhich currency would you like to receive?`;
        
        bot.sendMessage(chatId, ratesInfo, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🇺🇸 USD", callback_data: 'fiat_USD' }, { text: "🇪🇺 EUR", callback_data: 'fiat_EUR' }, { text: "🇬🇧 GBP", callback_data: 'fiat_GBP' }]
                ]
            }
        });

    } else if (data.startsWith('fiat_')) {
        // Step 3 - Store Fiat, Determine Next Step (Network or Amount)
        const currency = data.split('_')[1];
        userStates[chatId].fiat = currency;
        const crypto = userStates[chatId].crypto;

        if (crypto === 'USDT') {
            const networkMessage = "Great! Now, please select the network for your *USDT* deposit:";
            bot.sendMessage(chatId, networkMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "TRC20 (Tron)", callback_data: 'net_TRC20' }],
                        [{ text: "ERC20 (Ethereum)", callback_data: 'net_ERC20' }]
                    ]
                }
            });
        } else if (crypto === 'BTC' || crypto === 'ETH') {
            // Skip network selection for BTC/ETH
            userStates[chatId].awaiting = 'amount';
            bot.sendMessage(chatId, `Please enter the amount of *${crypto}* you want to sell.\n\n*Note:* Minimum transaction is equivalent to ${MIN_USDT} USDT.`, { parse_mode: 'Markdown' });
        }
        
    } else if (data.startsWith('net_')) {
        // Step 4 (USDT only) - Store Network, Go to Amount
        const network = data.split('_')[1];
        userStates[chatId].network = network;
        userStates[chatId].awaiting = 'amount';
        bot.sendMessage(chatId, `Please enter the amount of *USDT* you want to sell.\n\n*Minimum:* ${MIN_USDT} USDT\n*Maximum:* ${MAX_USDT} USDT`, { parse_mode: 'Markdown' });
    } else if (data.startsWith('pay_')) {
        // Step 6 - Select Payout Method (existing logic remains)
        const method = data.split('_')[1];
        let prompt = '';
        
        // Don't set payment method yet for multi-step choices
        if (method !== 'bank' && method !== 'skrill') {
            userStates[chatId].paymentMethod = method;
        }

        switch (method) {
            case 'wise':
                prompt = 'Please provide your *Wise email* or *@wisetag*.';
                userStates[chatId].awaiting = 'wise_details';
                break;
            case 'revolut':
                prompt = 'Please provide your *Revolut tag* (e.g., @username).';
                userStates[chatId].awaiting = 'revolut_details';
                break;
            case 'paypal':
                prompt = 'Please provide your *PayPal email address*.';
                userStates[chatId].awaiting = 'paypal_details';
                break;
            case 'bank':
                bot.sendMessage(chatId, "Please select your bank's region:", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🇪🇺 European Bank", callback_data: 'bank_eu' }],
                            [{ text: "🇺🇸 US Bank", callback_data: 'bank_us' }]
                        ]
                    }
                });
                break;
            case 'skrill':
                bot.sendMessage(chatId, "Are you using Skrill or Neteller?", {
                   reply_markup: {
                        inline_keyboard: [
                            [{ text: "Skrill", callback_data: 'payout_skrill' }],
                            [{ text: "Neteller", callback_data: 'payout_neteller' }]
                        ]
                   }
                });
                break;
            case 'card':
                prompt = 'Please provide your *Visa or Mastercard number*.';
                userStates[chatId].awaiting = 'card_details';
                break;
            case 'payeer':
                prompt = 'Please provide your *Payeer Number* (e.g., P12345678).';
                userStates[chatId].awaiting = 'payeer_details';
                break;
            case 'alipay':
                prompt = 'Please provide your *Alipay email*.';
                userStates[chatId].awaiting = 'alipay_details';
                break;
        }
        if (prompt) {
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        }
    } else if (data.startsWith('payout_')) { // Handles Skrill/Neteller choice
        const method = data.split('_')[1]; // 'skrill' or 'neteller'
        userStates[chatId].paymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
        userStates[chatId].awaiting = 'skrill_neteller_details';
        bot.sendMessage(chatId, `Please provide your *${userStates[chatId].paymentMethod} email*.`, { parse_mode: 'Markdown' });
    
    } else if (data.startsWith('bank_')) { // Handles Bank region choice
        const region = data.split('_')[1]; // 'eu' or 'us'
        userStates[chatId].paymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        if (region === 'eu') {
            userStates[chatId].awaiting = 'bank_details_eu';
            const prompt = 'Please provide your bank details. Reply with a single message in the following format:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        } else if (region === 'us') {
            userStates[chatId].awaiting = 'bank_details_us';
            const prompt = 'Please provide your US bank details. Reply with a single message in the following format:\n\n`Account Holder Name:\nAccount Number:\nRouting Number (ACH or ABA):`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        }
    } else if (data === 'withdraw_referral') { // Initiate referral withdrawal
        const { balance } = referralData[chatId];
        
        if (balance < MIN_REFERRAL_WITHDRAWAL_USDT) {
             bot.sendMessage(chatId, `❌ You must have at least *${MIN_REFERRAL_WITHDRAWAL_USDT} USDT* to withdraw. Your current balance is *${balance.toFixed(2)} USDT*.`, { parse_mode: 'Markdown' });
             bot.answerCallbackQuery(callbackQuery.id);
             return;
        }

        userStates[chatId].awaiting = 'referral_withdrawal_payment_selection'; 
        userStates[chatId].withdrawalAmount = balance; 

        const message = `*💰 Initiate Referral Withdrawal*\n\nYou are withdrawing your total balance of *${balance.toFixed(2)} USDT*. Please select how you wish to receive the funds:`;

        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Wise", callback_data: 'refpay_wise' }, { text: "Revolut", callback_data: 'refpay_revolut' }],
                    [{ text: "PayPal", callback_data: 'refpay_paypal' }, { text: "Bank Transfer", callback_data: 'refpay_bank' }],
                    [{ text: "Skrill/Neteller", callback_data: 'refpay_skrill' }, { text: "Visa/Mastercard", callback_data: 'refpay_card' }],
                    [{ text: "Payeer", callback_data: 'refpay_payeer' }, { text: "Alipay", callback_data: 'refpay_alipay' }]
                ]
            }
        });

    } else if (data.startsWith('refpay_')) { // Handle payment selection for referral withdrawal
        const method = data.split('_')[1];
        let prompt = '';
        
        userStates[chatId].isReferralWithdrawal = true;
        userStates[chatId].referralPaymentMethod = method; 

        switch (method) {
            case 'wise':
                prompt = 'Please provide your *Wise email* or *@wisetag*.';
                userStates[chatId].awaiting = 'ref_wise_details';
                break;
            case 'revolut':
                prompt = 'Please provide your *Revolut tag* (e.g., @username).';
                userStates[chatId].awaiting = 'ref_revolut_details';
                break;
            case 'paypal':
                prompt = 'Please provide your *PayPal email address*.';
                userStates[chatId].awaiting = 'ref_paypal_details';
                break;
            case 'bank':
                bot.sendMessage(chatId, "Please select your bank's region:", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🇪🇺 European Bank", callback_data: 'refbank_eu' }],
                            [{ text: "🇺🇸 US Bank", callback_data: 'refbank_us' }]
                        ]
                    }
                });
                break;
            case 'skrill':
                bot.sendMessage(chatId, "Are you using Skrill or Neteller?", {
                   reply_markup: {
                        inline_keyboard: [
                            [{ text: "Skrill", callback_data: 'refpayout_skrill' }],
                            [{ text: "Neteller", callback_data: 'refpayout_neteller' }]
                        ]
                   }
                });
                break;
            case 'card':
                prompt = 'Please provide your *Visa or Mastercard number*.';
                userStates[chatId].awaiting = 'ref_card_details';
                break;
            case 'payeer':
                prompt = 'Please provide your *Payeer Number* (e.g., P12345678).';
                userStates[chatId].awaiting = 'ref_payeer_details';
                break;
            case 'alipay':
                prompt = 'Please provide your *Alipay email*.';
                userStates[chatId].awaiting = 'ref_alipay_details';
                break;
        }
        if (prompt) {
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        }
        
    } else if (data.startsWith('refpayout_')) { // Handles Skrill/Neteller choice for referral
        const method = data.split('_')[1]; // 'skrill' or 'neteller'
        userStates[chatId].referralPaymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
        userStates[chatId].awaiting = 'ref_skrill_neteller_details';
        bot.sendMessage(chatId, `Please provide your *${userStates[chatId].referralPaymentMethod} email*.`, { parse_mode: 'Markdown' });

    } else if (data.startsWith('refbank_')) { // Handles Bank region choice for referral
        const region = data.split('_')[1]; // 'eu' or 'us'
        userStates[chatId].referralPaymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        if (region === 'eu') {
            userStates[chatId].awaiting = 'ref_bank_details_eu';
            const prompt = 'Please provide your bank details. Reply with a single message in the following format:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        } else if (region === 'us') {
            userStates[chatId].awaiting = 'ref_bank_details_us';
            const prompt = 'Please provide your US bank details. Reply with a single message in the following format:\n\n`Account Holder Name:\nAccount Number:\nRouting Number (ACH or ABA):`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        }
    }


    // Acknowledge the button press
    bot.answerCallbackQuery(callbackQuery.id);
});

// Handler for text messages (for amount, payment details, and support messages)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userState = userStates[chatId];
    initializeReferralData(chatId); // Ensure user has referral data initialized

    // 1. ADMIN REPLY LOGIC
    if (msg.reply_to_message && chatId.toString() === ADMIN_CHAT_ID) {
        const forwardedMessageId = msg.reply_to_message.message_id;
        const originalUserChatId = adminReplyMap[forwardedMessageId];

        if (originalUserChatId) {
            try {
                // Send the admin's response back to the original user
                await bot.sendMessage(originalUserChatId, `*📢 Support Reply from Admin:*\n\n${text}`, { parse_mode: 'Markdown' });
                await bot.sendMessage(chatId, "✅ Reply successfully sent to the user.");
                delete adminReplyMap[forwardedMessageId]; 
            } catch (e) {
                console.error("Error sending reply back to user:", e);
                await bot.sendMessage(chatId, "❌ Error sending reply back to the user. User may have blocked the bot.");
            }
        } else {
            bot.sendMessage(chatId, "I can't match that reply to an active support request.");
        }
        return;
    }

    // Ignore commands
    if (!text || text.startsWith('/')) return;

    // --- USER FLOW LOGIC ---

    if (userState && userState.awaiting === 'support_message') {
        // 2. USER SENDS SUPPORT MESSAGE
        const supportText = text;
        const userInfo = `User ID: ${msg.from.id}, Name: ${msg.from.first_name || ''} ${msg.from.last_name || ''}, Username: @${msg.from.username || 'N/A'}`;
        const forwardedMessage = `*🚨 NEW SUPPORT REQUEST*\n\nFrom: ${userInfo}\n\n*Message:* \n${supportText}\n\n--- \n_To reply to this user, simply reply to this message._`;
        
        try {
            const sentMessage = await bot.sendMessage(ADMIN_CHAT_ID, forwardedMessage, { parse_mode: 'Markdown' });
            adminReplyMap[sentMessage.message_id] = chatId;

            bot.sendMessage(chatId, "✅ Your message has been sent to support. We will reply to you here as soon as possible. You can use `/start` to begin a transaction while you wait.");
            delete userStates[chatId]; 
        } catch (error) {
            console.error("Error forwarding support message:", error);
            bot.sendMessage(chatId, "❌ Sorry, I couldn't send your message to support right now. Please try again later.");
        }
        return;
    }


    // 3. TRANSACTION / WITHDRAWAL FLOW LOGIC
    if (userState && userState.awaiting) {
        const awaiting = userState.awaiting;

        if (awaiting === 'amount') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount <= 0) {
                bot.sendMessage(chatId, `❌ Invalid amount. Please enter a valid positive number for ${userState.crypto}.`);
                return;
            }
            userState.amount = amount;
            
            // Calculate equivalent fiat amount
            const fiatToReceive = calculateFiat(amount, userState.crypto, userState.fiat);
            
            // Perform MIN/MAX check based on USDT equivalent
            const amountInUSDT = calculateFiat(amount, userState.crypto, 'USDT') / RATES.USDT_TO_USD;
            if (amountInUSDT < MIN_USDT || amountInUSDT > MAX_USDT) {
                bot.sendMessage(chatId, `❌ The amount of ${userState.crypto} you entered is outside the accepted range. The transaction value must be between ${MIN_USDT} USDT and ${MAX_USDT} USDT.`);
                return;
            }

            const confirmationMessage = `You will receive approximately *${fiatToReceive.toFixed(2)} ${userState.fiat}*.\n\nPlease choose your preferred payment method:`;

            bot.sendMessage(chatId, confirmationMessage, {
                parse_mode: 'Markdown',
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

            // --- MAIN TRANSACTION DETAILS HANDLER ---
            userState.paymentDetails = text;
            userState.awaiting = null;
            bot.sendMessage(chatId, "⏳ Thank you! Generating your secure deposit address, please wait...");

            // --- COINPAYMENTS API CALL ---
            try {
                // Determine the CoinPayments currency code (currency2)
                let coinCurrency;
                if (userState.crypto === 'USDT') {
                    const networkMap = {
                        'TRC20': 'USDT.TRC20',
                        'ERC20': 'USDT.ERC20'
                    };
                    coinCurrency = networkMap[userState.network];
                } else {
                    // BTC and ETH use their standard CoinPayments codes
                    coinCurrency = userState.crypto; // 'BTC' or 'ETH'
                }
                
                // Ensure payment method is set for the custom field
                let paymentMethodForCustom = userState.paymentMethod;
                if (!paymentMethodForCustom && awaiting.includes('bank_details_')) {
                    paymentMethodForCustom = awaiting.includes('_eu') ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
                } else if (!paymentMethodForCustom && awaiting === 'skrill_neteller_details') {
                     paymentMethodForCustom = userState.paymentMethod;
                } else if (!paymentMethodForCustom) {
                    paymentMethodForCustom = awaiting.split('_')[0];
                }
                userState.paymentMethod = paymentMethodForCustom;


                const transactionOptions = {
                    currency1: userState.crypto, // Set to BTC, ETH, or USDT
                    currency2: coinCurrency, // Set the final CoinPayments code
                    amount: userState.amount,
                    buyer_email: BUYER_REFUND_EMAIL,
                    custom: `Payout to ${userState.paymentMethod}: ${userState.paymentDetails}`,
                    item_name: `Sell ${userState.amount} ${userState.crypto} for ${userState.fiat}`,
                    ipn_url: 'YOUR_IPN_WEBHOOK_URL'
                };

                const result = await coinpayments.createTransaction(transactionOptions);

                // --- REFERRAL REWARD SIMULATION ---
                const referrerId = referralData[chatId]?.referrerId;
                if (referrerId) {
                    // Reward if user has a referrer and hasn't triggered the reward before
                    if (!referralData[chatId].isReferralRewardClaimed) {
                        rewardReferrer(referrerId, chatId);
                        referralData[chatId].isReferralRewardClaimed = true; // Mark as rewarded
                    }
                }
                // --- END REFERRAL REWARD SIMULATION ---

                let networkText = '';
                if (userState.crypto === 'USDT') {
                    networkText = ` (${userState.network})`;
                }

                const depositInfo = `✅ *Deposit Address Generated! (ID: ${result.txn_id})*\n\nPlease send exactly *${result.amount} ${userState.crypto}*${networkText} to the address below:\n\n` +
                    `\`${result.address}\`\n\n` + 
                    `*Status URL:* [Click to Track](${result.status_url})\n\n` +
                    `*Payout Method:* ${userState.paymentMethod}\n` +
                    `*Payout Details:* \n\`${userState.paymentDetails}\`\n\n` +
                    `⚠️ *IMPORTANT:* Send only ${userState.crypto} to this address.`;
                    
                bot.sendMessage(chatId, depositInfo, { parse_mode: 'Markdown' });
                delete userStates[chatId];

            } catch (error) {
                console.error("CoinPayments API Error:", error);
                bot.sendMessage(chatId, "❌ Sorry, there was an error generating your deposit address. Please try again later or contact support.");
            }
        } else if ([
            'ref_wise_details', 'ref_revolut_details', 'ref_paypal_details', 'ref_card_details',
            'ref_payeer_details', 'ref_alipay_details', 'ref_skrill_neteller_details',
            'ref_bank_details_eu', 'ref_bank_details_us'
        ].includes(awaiting)) {

            // --- REFERRAL WITHDRAWAL DETAILS HANDLER ---
            const withdrawalAmount = userState.withdrawalAmount;
            
            // Set payment method
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
            
            // 1. Send admin notification
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
                // Send notification to admin
                await bot.sendMessage(ADMIN_CHAT_ID, adminNotification, { parse_mode: 'Markdown' });

                // 2. Clear user's referral balance
                if (referralData[chatId]) {
                    referralData[chatId].balance = 0;
                }
                
                // 3. Confirm to user
                bot.sendMessage(chatId, 
                    `✅ *Withdrawal Request Submitted!*\n\n` +
                    `We have successfully received your request to withdraw *${withdrawalAmount.toFixed(2)} USDT* via ${paymentMethod}.\n\n` +
                    `The payment will be processed to your provided details shortly. You can check your remaining balance with \`/referral\`.`, 
                    { parse_mode: 'Markdown' }
                );

            } catch (error) {
                console.error("Referral withdrawal error:", error);
                bot.sendMessage(chatId, "❌ Sorry, there was an error submitting your withdrawal request. Please try again later.");
            }
            
            delete userStates[chatId]; // Clean up state for withdrawal flow
        }
    }
});


console.log("Bot is running...");
