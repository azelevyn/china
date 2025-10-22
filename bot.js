require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

// --- BOT AND API INITIALIZATION ---

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.COINPAYMENTS_PUBLIC_KEY || !process.env.COINPAYMENTS_PRIVATE_KEY || !process.env.ADMIN_CHAT_ID) {
    console.error("FATAL ERROR: Missing required environment variables. Please check your .env file and ensure ADMIN_CHAT_ID is set.");
    process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const coinpayments = new CoinPayments({
    key: process.env.COINPAYMENTS_PUBLIC_KEY,
    secret: process.env.COINPAYMENTS_PRIVATE_KEY,
});

bot.setMyCommands([
    { command: 'start', description: '🚀 Start a new transaction' },
    { command: 'referral', description: '🤝 Check your referral status and link' },
    { command: 'help', description: '❓ How to use this bot (FAQ)' },
    { command: 'support', description: '💬 Contact a support agent' }
]);

// --- CONSTANTS AND CONFIGURATION ---

const MERCHANT_ID = '431eb6f352649dfdcde42b2ba8d5b6d8';
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MIN_USDT = 25;
const MAX_USDT = 50000;
const SUPPORT_CONTACT = '@DeanAbdullah';

const RATES = {
    USDT_TO_USD: 1 / 1.09,
    USD_TO_EUR: 1 / 1.12,
    USDT_TO_GBP: 1 / 0.89,
};

const REFERRAL_REWARD_USDT = 1.2;
const MIN_REFERRAL_WITHDRAWAL_USDT = 50;

// --- IN-MEMORY STATE (MOCK DATABASE) ---

const userStates = {};
const referralData = {};
const adminReplyMap = {};

// --- HELPER FUNCTIONS ---

function calculateFiat(usdtAmount, fiatCurrency) {
    if (fiatCurrency === 'USD') {
        return usdtAmount * RATES.USDT_TO_USD;
    }
    if (fiatCurrency === 'EUR') {
        const amountInUSD = usdtAmount * RATES.USDT_TO_USD;
        return amountInUSD * RATES.USD_TO_EUR;
    }
    if (fiatCurrency === 'GBP') {
        return usdtAmount * RATES.USDT_TO_GBP;
    }
    return 0;
}

function getCurrentUTCDateTime() {
    const now = new Date();
    const date = now.toUTCString().slice(5, 16); // e.g., "20 Oct 2025"
    const time = now.toUTCString().slice(17, 25); // e.g., "13:43:00"
    return `${date} - ${time} UTC`;
}

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

function rewardReferrer(referrerId, referredUserId) {
    if (referrerId && referralData[referrerId]) {
        referralData[referrerId].balance += REFERRAL_REWARD_USDT;
        referralData[referrerId].referredCount += 1;
        bot.sendMessage(referrerId, `🎉 *New Referral Reward!* You earned *${REFERRAL_REWARD_USDT.toFixed(1)} USDT* from user \`${referredUserId}\`. Your new balance is *${referralData[referrerId].balance.toFixed(2)} USDT*.`, { parse_mode: 'Markdown' });
        return true;
    }
    return false;
}

// --- BOT COMMANDS AND HANDLERS ---

bot.onText(/\/start\s?(\d+)?/, (msg, match) => {
    const chatId = msg.chat.id;
    const referredBy = match ? match[1] : null;
    const firstName = msg.from.first_name || '';
    const dateTime = getCurrentUTCDateTime();

    initializeReferralData(chatId);

    if (referredBy && referredBy !== chatId.toString()) {
        const referrerIdStr = referredBy.toString();
        if (referralData[referrerIdStr] && !referralData[chatId].referrerId) {
            referralData[chatId].referrerId = referrerIdStr;
            bot.sendMessage(chatId, `🤝 You've been referred by user ID \`${referrerIdStr}\`! Once you complete your first transaction, your referrer will be rewarded.`, { parse_mode: 'Markdown' });
        }
    }

    userStates[chatId] = {};

    const welcomeMsg = `Hello, *${firstName}*!\n\nWelcome to the USDT Seller Bot. Current time: *${dateTime}*.\n\nI can help you easily sell your USDT for fiat currency (USD, EUR, GBP).\n\nReady to start?`;

    bot.sendMessage(chatId, welcomeMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Yes, I want to sell USDT", callback_data: 'start_sell' }],
                [{ text: " GUIDE: How to use the Bot", callback_data: 'show_help' }]
            ]
        }
    });
});

// /referral command handler
bot.onText(/\/referral/, async (msg) => {
    const chatId = msg.chat.id;
    initializeReferralData(chatId);
    const { balance, referredCount } = referralData[chatId];

    let botUsername = 'USDT_Seller_Bot';
    try {
        const me = await bot.getMe();
        botUsername = me.username || botUsername;
    } catch {
        // fallback
    }

    const referralLink = `https://t.me/${botUsername}?start=${chatId}`;
    const isReadyToWithdraw = balance >= MIN_REFERRAL_WITHDRAWAL_USDT;
    const missingAmount = MIN_REFERRAL_WITHDRAWAL_USDT - balance;

    let withdrawalBtn = [];
    if (isReadyToWithdraw) {
        withdrawalBtn.push([{ text: `💰 Withdraw ${balance.toFixed(2)} USDT`, callback_data: 'withdraw_referral' }]);
    }

    const msgText = `
*🤝 Referral Program Status*

*Your ID:* \`${chatId}\`
*Your Referral Link:* \`${referralLink}\`

*Current Balance:* *${balance.toFixed(2)} USDT*
*Successful Referrals:* *${referredCount}*
*Reward per Referral:* *${REFERRAL_REWARD_USDT.toFixed(1)} USDT*

*Withdrawal Minimum:* ${MIN_REFERRAL_WITHDRAWAL_USDT} USDT
${isReadyToWithdraw ? "🎉 You are ready to withdraw your funds!" : `Keep going! You need *${missingAmount.toFixed(2)} USDT* more to reach the withdrawal minimum.`}
    `;

    bot.sendMessage(chatId, msgText, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                ...withdrawalBtn,
                [{ text: "🔙 Back to Main Menu", callback_data: 'start_sell' }]
            ]
        }
    });
});

// /help command handler
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpMsg = `
*❓ How to Use the USDT Seller Bot (FAQ)*

This bot helps you convert your USDT into USD, EUR, or GBP. Here is the step-by-step process:

*Step 1:* Start a transaction with /start.
*Step 2:* Select your fiat currency.
*Step 3:* Choose the blockchain network (TRC20 or ERC20).
*Step 4:* Enter the amount (min ${MIN_USDT} USDT).
*Step 5:* Choose payout method and provide details.
*Step 6:* Send USDT to the generated address.
`;

    bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
});

// Support command handler
bot.onText(/\/support/, (msg) => {
    const chatId = msg.chat.id;
    if (userStates[chatId]?.awaiting) {
        bot.sendMessage(chatId, "⚠️ You are in the middle of a transaction. Finish or restart with /start.");
        return;
    }
    userStates[chatId] = { awaiting: 'support_message' };
    bot.sendMessage(chatId, "💬 *Support Message*\n\nPlease type your question or issue. A support agent will reply soon.", {
        parse_mode: 'Markdown',
        reply_markup: { force_reply: true }
    });
});

// --- CALLBACK QUERY HANDLER ---

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    if (!userStates[chatId]) userStates[chatId] = {};
    initializeReferralData(chatId);

    // Support reply handling
    if (msg.reply_to_message && chatId.toString() === ADMIN_CHAT_ID) {
        const originalMsgId = msg.reply_to_message.message_id;
        const userChatId = adminReplyMap[originalMsgId];
        if (userChatId) {
            try {
                await bot.sendMessage(userChatId, `*📢 Support Reply from Admin:*\n\n${callbackQuery.message.text}`, { parse_mode: 'Markdown' });
                await bot.sendMessage(chatId, "✅ Reply sent.");
                delete adminReplyMap[originalMsgId];
            } catch {
                await bot.sendMessage(chatId, "❌ Error sending reply.");
            }
        } else {
            bot.sendMessage(chatId, "I can't match that reply to an active request.");
        }
        return;
    }

    if (data === 'show_help') {
        bot.processUpdate({ update_id: 0, message: { ...msg, text: '/help', entities: [{ type: 'bot_command', offset: 0, length: 5 }] } });
        return;
    }

    if (data === 'start_sell') {
        const ratesInfo = `*Current Exchange Rates:*\n- 1 USDT ≈ ${RATES.USDT_TO_USD.toFixed(3)} USD\n- 1 USDT ≈ ${(RATES.USDT_TO_USD * RATES.USD_TO_EUR).toFixed(3)} EUR\n- 1 USDT ≈ ${RATES.USDT_TO_GBP.toFixed(3)} GBP\n\nWhich currency would you like to receive?`;
        bot.sendMessage(chatId, ratesInfo, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🇺🇸 USD", callback_data: 'fiat_USD' },
                     { text: "🇪🇺 EUR", callback_data: 'fiat_EUR' },
                     { text: "🇬🇧 GBP", callback_data: 'fiat_GBP' }]
                ]
            }
        });
    } else if (data === 'cancel') {
        bot.sendMessage(chatId, "No problem! You can start again with /start.");
        delete userStates[chatId];
    } else if (data.startsWith('fiat_')) {
        const currency = data.split('_')[1];
        userStates[chatId].fiat = currency;
        const networkMsg = "Great! Now, select your USDT deposit network:";
        bot.sendMessage(chatId, networkMsg, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "TRC20 (Tron)", callback_data: 'net_TRC20' }],
                    [{ text: "ERC20 (Ethereum)", callback_data: 'net_ERC20' }]
                ]
            }
        });
    } else if (data.startsWith('net_')) {
        const network = data.split('_')[1];
        userStates[chatId].network = network;
        userStates[chatId].awaiting = 'amount';
        bot.sendMessage(chatId, `Please enter amount of USDT to sell (min ${MIN_USDT}):`, { parse_mode: 'Markdown' });
    } else if (data.startsWith('pay_')) {
        const method = data.split('_')[1];
        let prompt = '';

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
                bot.sendMessage(chatId, "Select your bank region:", {
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
                prompt = 'Please provide your *Visa or Mastercard* number.';
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
    } else if (data.startsWith('payout_')) {
        const method = data.split('_')[1];
        userStates[chatId].paymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
        userStates[chatId].awaiting = 'skrill_neteller_details';
        bot.sendMessage(chatId, `Please provide your *${userStates[chatId].paymentMethod}* email.`, { parse_mode: 'Markdown' });
    } else if (data.startsWith('bank_')) {
        const region = data.split('_')[1];
        userStates[chatId].paymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        if (region === 'eu') {
            userStates[chatId].awaiting = 'ref_bank_details_eu';
            const prompt = 'Please provide your bank details in one message:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        } else {
            userStates[chatId].awaiting = 'ref_bank_details_us';
            const prompt = 'Please provide your US bank details:\n\n`Account Holder Name:\nAccount Number:\nRouting Number:`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        }
    } else if (data === 'withdraw_referral') {
        const { balance } = referralData[chatId];
        if (balance < MIN_REFERRAL_WITHDRAWAL_USDT) {
            bot.sendMessage(chatId, `❌ You need at least ${MIN_REFERRAL_WITHDRAWAL_USDT} USDT to withdraw. Your current balance is ${balance.toFixed(2)} USDT.`, { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }
        userStates[chatId].awaiting = 'referral_withdrawal_payment_selection';
        userStates[chatId].withdrawalAmount = balance;

        const msgText = `*💰 Initiate Referral Withdrawal*\n\nYou are withdrawing your total balance of *${balance.toFixed(2)} USDT*. Please confirm and select your payout method:`;
        bot.sendMessage(chatId, msgText, {
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
    } else if (data.startsWith('refpayout_')) {
        // Referral payout method selection
        const method = data.split('_')[1];
        userStates[chatId].isReferralWithdrawal = true;
        userStates[chatId].referralPaymentMethod = method;

        let prompt = '';
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
                prompt = 'Please provide your *PayPal email*.';
                userStates[chatId].awaiting = 'ref_paypal_details';
                break;
            case 'bank':
                bot.sendMessage(chatId, "Select your bank region:", {
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
                prompt = 'Please provide your *Visa or Mastercard* number.';
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
    }

    // Handle bank region for referral
    else if (data.startsWith('refbank_')) {
        const region = data.split('_')[1];
        userStates[chatId].referralPaymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        if (region === 'eu') {
            userStates[chatId].awaiting = 'ref_bank_details_eu';
            const prompt = 'Please provide your bank details in one message:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        } else {
            userStates[chatId].awaiting = 'ref_bank_details_us';
            const prompt = 'Please provide your US bank details:\n\n`Account Holder Name:\nAccount Number:\nRouting Number:`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        }
    }

    // Finalize the callback
    bot.answerCallbackQuery(callbackQuery.id);
});

// --- MESSAGE HANDLER ---

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userState = userStates[chatId];
    initializeReferralData(chatId);

    // Admin reply
    if (msg.reply_to_message && chatId.toString() === ADMIN_CHAT_ID) {
        const originalMsgId = msg.reply_to_message.message_id;
        const userChatId = adminReplyMap[originalMsgId];
        if (userChatId) {
            try {
                await bot.sendMessage(userChatId, `*📢 Support Reply from Admin:*\n\n${text}`, { parse_mode: 'Markdown' });
                await bot.sendMessage(chatId, "✅ Reply sent.");
                delete adminReplyMap[originalMsgId];
            } catch {
                await bot.sendMessage(chatId, "❌ Error sending reply.");
            }
        } else {
            bot.sendMessage(chatId, "I can't match that reply to an active request.");
        }
        return;
    }

    // Ignore commands
    if (!text || text.startsWith('/')) return;

    // Support flow
    if (userState?.awaiting === 'support_message') {
        const supportMsg = `*🚨 NEW SUPPORT REQUEST*\n\nFrom: User ID ${msg.from.id}\nName: ${msg.from.first_name}\nMessage:\n${text}\n\n---\n_To reply, reply to this message._`;
        try {
            const sentMsg = await bot.sendMessage(ADMIN_CHAT_ID, supportMsg, { parse_mode: 'Markdown' });
            adminReplyMap[sentMsg.message_id] = chatId;
            bot.sendMessage(chatId, "✅ Your message to support has been sent. We'll reply here soon. Use /start to begin a new transaction.");
            delete userStates[chatId];
        } catch {
            bot.sendMessage(chatId, "❌ Could not send your support message. Try again later.");
        }
        return;
    }

    // Transaction / withdrawal flow
    if (userState?.awaiting) {
        const awaiting = userState.awaiting;

        if (awaiting === 'amount') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount < MIN_USDT || amount > MAX_USDT) {
                bot.sendMessage(chatId, `❌ Invalid amount. Enter between ${MIN_USDT} and ${MAX_USDT}.`);
                return;
            }
            userState.amount = amount;

            // Show summary and ask for confirmation
            const fiatAmount = calculateFiat(amount, userState.fiat);
            const summaryMsg = `📝 Please review:\n\n` +
                `*USDT Amount:* ${amount}\n` +
                `*Approximate ${userState.fiat}:* ${fiatAmount.toFixed(2)}\n\n` +
                `Click *Confirm* below to proceed or *Cancel* to abort.`;

            bot.sendMessage(chatId, summaryMsg, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Confirm", callback_data: 'confirm_transaction' }],
                        [{ text: "❌ Cancel", callback_data: 'cancel_transaction' }]
                    ]
                }
            });
            userState.awaiting = 'confirmation';
            return;
        }

        if (awaiting === 'confirmation') {
            // Should be handled by callback
            return;
        }

        // Collect main details and confirm before proceeding
        if ([
            'wise_details', 'revolut_details', 'paypal_details', 'card_details',
            'payeer_details', 'alipay_details', 'skrill_neteller_details',
            'ref_wise_details', 'ref_revolut_details', 'ref_paypal_details', 'ref_card_details',
            'ref_payeer_details', 'ref_alipay_details', 'ref_skrill_neteller_details',
            'bank_details_eu', 'bank_details_us'
        ].includes(awaiting)) {
            // Save details and ask for double confirmation
            userState.paymentDetails = text;

            const isRefWithdrawal = userState.isReferralWithdrawal;
            const totalAmount = isRefWithdrawal ? userState.withdrawalAmount : userState.amount;
            const paymentMethod = isRefWithdrawal ? userState.referralPaymentMethod : userState.paymentMethod;

            const confirmMsg = `Please review:\n\n` +
                `Amount: ${totalAmount} USDT\n` +
                `Method: ${paymentMethod}\n` +
                `Details: ${text}\n\n` +
                `Click *Confirm* to proceed or *Cancel* to abort.`;

            bot.sendMessage(chatId, confirmMsg, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Confirm", callback_data: 'finalize_action' }],
                        [{ text: "❌ Cancel", callback_data: 'cancel_action' }]
                    ]
                }
            });
            userState.awaiting = 'final_confirmation';
            return;
        }

        if (awaiting === 'final_confirmation') {
            // Should be handled by callback
            return;
        }
    }
});

// --- FINAL CONFIRMATION CALLBACK ---

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    if (!userStates[chatId]) userStates[chatId] = {};
    initializeReferralData(chatId);

    if (data === 'confirm_transaction' || data === 'finalize_action') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Processing your transaction...' });
        const userState = userStates[chatId];
        await processTransaction(chatId, userState);
        delete userStates[chatId];
    } else if (data === 'cancel') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Transaction cancelled.' });
        bot.sendMessage(chatId, 'Your transaction has been cancelled. Use /start to begin again.');
        delete userStates[chatId];
    } else if (data === 'cancel_action') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Action cancelled.' });
        bot.sendMessage(chatId, 'Action cancelled. Use /start to begin again.');
        delete userStates[chatId];
    } else if (data.startsWith('refpay_')) {
        // Handle referral payout method selection
        const method = data.split('_')[1];
        userStates[chatId].isReferralWithdrawal = true;
        userStates[chatId].referralPaymentMethod = method;

        let prompt = '';
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
                prompt = 'Please provide your *PayPal email*.';
                userStates[chatId].awaiting = 'ref_paypal_details';
                break;
            case 'bank':
                bot.sendMessage(chatId, "Select your bank region:", {
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
                prompt = 'Please provide your *Visa or Mastercard* number.';
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
        return;
    }

    // Handle referral bank region
    if (data.startsWith('refbank_')) {
        const region = data.split('_')[1];
        userStates[chatId].referralPaymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        if (region === 'eu') {
            userStates[chatId].awaiting = 'ref_bank_details_eu';
            const prompt = 'Please provide your bank details in one message:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        } else {
            userStates[chatId].awaiting = 'ref_bank_details_us';
            const prompt = 'Please provide your US bank details:\n\n`Account Holder Name:\nAccount Number:\nRouting Number:`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        }
        return;
    }
});

// --- PROCESS TRANSACTION FUNCTION ---

async function processTransaction(chatId, userState) {
    try {
        const networkMap = {
            'TRC20': 'USDT.TRC20',
            'ERC20': 'USDT.ERC20'
        };
        const coinCurrency = networkMap[userState.network];

        // Determine payment method for custom field
        let paymentMethodForCustom = userState.paymentMethod;
        if (!paymentMethodForCustom && userState.awaiting && userState.awaiting.startsWith('bank_details')) {
            paymentMethodForCustom = userState.awaiting.includes('_eu') ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        } else if (!paymentMethodForCustom && userState.awaiting && userState.awaiting.startsWith('ref_bank_details')) {
            paymentMethodForCustom = userState.awaiting.includes('_eu') ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        } else if (!paymentMethodForCustom && userState.awaiting && userState.awaiting.startsWith('skrill_neteller_details')) {
            paymentMethodForCustom = userState.paymentMethod || 'Skrill/Neteller';
        } else if (!paymentMethodForCustom) {
            paymentMethodForCustom = userState.paymentMethod || 'Unknown';
        }

        const transactionOptions = {
            currency1: 'USDT',
            currency2: coinCurrency,
            amount: userState.amount,
            buyer_email: BUYER_REFUND_EMAIL,
            custom: `Payout to ${paymentMethodForCustom}: ${userState.paymentDetails}`,
            item_name: `Sell ${userState.amount} USDT for ${userState.fiat}`,
            ipn_url: 'YOUR_IPN_WEBHOOK_URL'
        };

        const result = await coinpayments.createTransaction(transactionOptions);

        // Referral reward
        const referrerId = referralData[chatId]?.referrerId;
        if (referrerId && !referralData[chatId].isReferralRewardClaimed) {
            rewardReferrer(referrerId, chatId);
            referralData[chatId].isReferralRewardClaimed = true;
        }

        const depositMsg = `✅ *Deposit Address Generated! (ID: ${result.txn_id})*\n\n` +
            `Send exactly *${result.amount} USDT* (${userState.network}) to:\n\`${result.address}\`\n\n` +
            `*Status:* [Click here](${result.status_url})\n\n` +
            `*Method:* ${userState.paymentMethod}\nDetails: \`${userState.paymentDetails}\`\n\n` +
            `⚠️ Send only USDT on ${userState.network}. Sending other coins may result in loss.`;

        bot.sendMessage(chatId, depositMsg, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Error:', err);
        bot.sendMessage(chatId, '❌ Error generating deposit address. Please try again later.');
    }
}
});


console.log("Bot is running...");
// --- END OF CODE ---
