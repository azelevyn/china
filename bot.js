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
    { command: 'support', description: '💬 Contact a support agent' },
    { command: 'transfer', description: '🔄 Internal transfer between accounts' }
]);


// --- CONSTANTS AND CONFIGURATION ---

const MERCHANT_ID = '431eb6f352649dfdcde42b2ba8d5b6d8'; // Your Merchant ID
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com'; // Your refund email
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ID of the admin receiving support requests
const MIN_USDT = 25;
const MAX_USDT = 50000;
const SUPPORT_CONTACT = '@DeanAbdullah'; // REPLACE WITH YOUR SUPPORT USERNAME

// UPDATED: Conversion Rates
const RATES = {
    USD_TO_USDT: 1.24, // UPDATED: 1 USDT = 1.24 USD
    USDT_TO_EUR: 1.09, // UPDATED: 1 USDT = 1.09 EUR
    USDT_TO_GBP: 0.92, // UPDATED: 1 USDT = 0.92 GBP
};

// NEW REFERRAL CONSTANTS
const REFERRAL_REWARD_USDT = 1.2;
const MIN_REFERRAL_WITHDRAWAL_USDT = 50;

// NEW: INTERNAL TRANSFER CONSTANTS
const MIN_INTERNAL_TRANSFER_USDT = 10;
const TRANSFER_FEE_PERCENTAGE = 0.5; // 0.5% transfer fee

// NEW: Track new users who haven't been notified to admin yet
const newUsersToNotify = new Set();

// NEW: Track last message IDs for each chat to enable message editing
const lastMessageIds = {};

// NEW: Order number tracking
let orderCounter = 1000;
const transactionRecords = {}; // Store transaction records by order number

// NEW: Account number system
let accountCounter = 100000;
const userAccounts = {}; // Structure: { [userId]: { accountNumber: string, balance: number } }
const accountToUserMap = {}; // Structure: { [accountNumber]: userId }


// --- IN-MEMORY STATE (MOCK DATABASE) ---

// In-memory storage for user conversation state (for current transaction/support)
const userStates = {};

// In-memory storage for referral tracking (THIS SHOULD BE A PERSISTENT DATABASE IN PRODUCTION)
// Structure: { [userId]: { referrerId: string|null, balance: number, referredCount: number, isReferralRewardClaimed: boolean } }
const referralData = {}; 

// Map to link forwarded admin message ID back to the original user's chat ID
const adminReplyMap = {};


// --- HELPER FUNCTIONS ---

// NEW: Function to generate unique order number
function generateOrderNumber() {
    const timestamp = Date.now().toString().slice(-6);
    const orderNumber = `ORD${orderCounter++}${timestamp}`;
    return orderNumber;
}

// NEW: Function to generate unique account number
function generateAccountNumber() {
    const accountNumber = `ACC${accountCounter++}`;
    return accountNumber;
}

// NEW: Function to initialize user account
function initializeUserAccount(userId) {
    if (!userAccounts[userId]) {
        const accountNumber = generateAccountNumber();
        userAccounts[userId] = {
            accountNumber: accountNumber,
            balance: 0
        };
        accountToUserMap[accountNumber] = userId;
        console.log(`Created account ${accountNumber} for user ${userId}`);
    }
    return userAccounts[userId];
}

// NEW: Function to get user by account number
function getUserByAccountNumber(accountNumber) {
    return accountToUserMap[accountNumber];
}

// NEW: Function to process internal transfer
function processInternalTransfer(senderId, recipientAccountNumber, amount) {
    const recipientId = getUserByAccountNumber(recipientAccountNumber);
    
    if (!recipientId) {
        return { success: false, error: 'Account number not found' };
    }
    
    if (!userAccounts[senderId] || userAccounts[senderId].balance < amount) {
        return { success: false, error: 'Insufficient balance' };
    }
    
    const fee = amount * (TRANSFER_FEE_PERCENTAGE / 100);
    const netAmount = amount - fee;
    
    // Deduct from sender
    userAccounts[senderId].balance -= amount;
    
    // Add to recipient
    userAccounts[recipientId].balance += netAmount;
    
    return { 
        success: true, 
        recipientId: recipientId,
        fee: fee,
        netAmount: netAmount
    };
}

// NEW: Function to store transaction record
function storeTransactionRecord(orderNumber, transactionData) {
    transactionRecords[orderNumber] = {
        ...transactionData,
        orderNumber: orderNumber,
        timestamp: new Date().toISOString(),
        status: 'pending'
    };
}

// NEW: Function to find transaction by order number
function findTransactionByOrderNumber(orderNumber) {
    return transactionRecords[orderNumber];
}

// UPDATED: Function to calculate the received amount
function calculateFiat(usdtAmount, fiatCurrency) {
    if (fiatCurrency === 'USD') {
        return usdtAmount / RATES.USD_TO_USDT; // UPDATED: Convert USDT to USD using the new rate
    }
    if (fiatCurrency === 'EUR') {
        return usdtAmount * RATES.USDT_TO_EUR; // UPDATED: Convert USDT to EUR
    }
    if (fiatCurrency === 'GBP') {
        return usdtAmount * RATES.USDT_TO_GBP; // UPDATED: Convert USDT to GBP
    }
    return 0;
}

// Function to get current formatted date and time (24-hour format)
function getCurrentDateTime() {
    const now = new Date();
    // Example: 20 Oct 2025 - 13:43:00
    const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${date} - ${time}`;
}

// NEW: Function to initialize referral data if user is new
function initializeReferralData(userId) {
    if (!referralData[userId]) {
        referralData[userId] = {
            referrerId: null,
            balance: 0,
            referredCount: 0,
            isReferralRewardClaimed: false, // Prevents rewarding referrer multiple times
        };
    }
}

// NEW: Function to update referrer's balance and count and notify them
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

// NEW: Function to send new user notification to admin
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

// UPDATED: Function to format payment details for review (now includes order number)
function formatPaymentDetails(userState, orderNumber = null) {
    const { amount, fiat, network, paymentMethod, paymentDetails } = userState;
    const fiatToReceive = calculateFiat(amount, fiat);
    
    const orderInfo = orderNumber ? `*Order Number:* #${orderNumber}\n\n` : '';
    
    return `
📋 *TRANSACTION SUMMARY*

${orderInfo}*Amount to Sell:* ${amount} USDT
*Network:* ${network}
*Currency to Receive:* ${fiat}
*Amount to Receive:* ${fiatToReceive.toFixed(2)} ${fiat}
*Payment Method:* ${paymentMethod}
*Payment Details:* 
\`${paymentDetails}\`

*Exchange Rates:*
- 1 USDT = ${RATES.USD_TO_USDT} USD
- 1 USDT = ${RATES.USDT_TO_EUR} EUR
- 1 USDT = ${RATES.USDT_TO_GBP} GBP
    `;
}

// NEW: Function to send or edit message with tracking
async function sendOrEditMessage(chatId, text, options = {}) {
    try {
        if (lastMessageIds[chatId]) {
            // Edit existing message
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: lastMessageIds[chatId],
                parse_mode: 'Markdown',
                ...options
            });
        } else {
            // Send new message and track its ID
            const sentMessage = await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                ...options
            });
            lastMessageIds[chatId] = sentMessage.message_id;
        }
    } catch (error) {
        // If editing fails (message content same or message not found), send new message
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

// NEW: Function to clear last message ID (for starting new flows)
function clearLastMessage(chatId) {
    delete lastMessageIds[chatId];
}

// NEW: Function to show loading message
async function showLoadingMessage(chatId, duration = 2000) {
    const loadingMessage = await bot.sendMessage(chatId, "⏳ Processing, please wait...");
    
    return new Promise((resolve) => {
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, loadingMessage.message_id);
            } catch (error) {
                // Ignore deletion errors
            }
            resolve();
        }, duration);
    });
}


// --- BOT COMMANDS AND MESSAGE HANDLERS ---

// Handler for the /start command (now supports deep linking for referrals)
bot.onText(/\/start\s?(\d+)?/, async (msg, match) => { 
    const chatId = msg.chat.id;
    const referredBy = match ? match[1] : null; // Captured referral ID (referrer's chatId)
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username ? `@${msg.from.username}` : 'N/A';
    const dateTime = getCurrentDateTime(); 

    // NEW: Check if this is a new user who needs admin notification
    const isNewUser = !referralData[chatId];
    
    // 1. Initialize user's referral data
    initializeReferralData(chatId);

    // NEW: Initialize user's account
    initializeUserAccount(chatId);

    // 2. Check for referral link
    if (referredBy && referredBy !== chatId.toString()) {
        const referrerIdStr = referredBy.toString();
        // Check if referrer exists and user hasn't been linked already
        if (referralData[referrerIdStr] && !referralData[chatId].referrerId) {
            referralData[chatId].referrerId = referrerIdStr;
            bot.sendMessage(chatId, `🤝 You've been referred by user ID \`${referrerIdStr}\`! Once you complete your first transaction, your referrer will be rewarded.`, { parse_mode: 'Markdown' });
        }
    }
    
    // 3. Reset user transaction state and clear last message
    userStates[chatId] = {};
    clearLastMessage(chatId);

    // NEW: Send admin notification for new users
    if (isNewUser) {
        const userInfo = `${firstName} ${lastName} (${username})`;
        notifyAdminNewUser(chatId, userInfo, referredBy);
    }

    const welcomeMessage = `Hello, *${firstName}*!\n\nWelcome to the USDT Seller Bot. Current time: *${dateTime}*.\n\nI can help you easily sell your USDT for fiat currency (USD, EUR, GBP).\n\nReady to start?`;

    await sendOrEditMessage(chatId, welcomeMessage, {
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Yes, I want to sell USDT", callback_data: 'start_sell' }],
                [{ text: "🔄 Internal Transfer", callback_data: 'internal_transfer' }],
                [{ text: "🔍 Find Transaction", callback_data: 'find_transaction' }],
                [{ text: "📖 GUIDE: How to use the Bot", callback_data: 'show_help' }]
            ]
        }
    });
});

// NEW: Handler for the /transfer command
bot.onText(/\/transfer/, (msg) => {
    const chatId = msg.chat.id;
    // Initialize user account if not exists
    initializeUserAccount(chatId);
    
    userStates[chatId] = { awaiting: 'transfer_amount' };
    
    const accountInfo = userAccounts[chatId];
    const message = `💰 *Internal Transfer*\n\n*Your Account Number:* \`${accountInfo.accountNumber}\`\n*Available Balance:* ${accountInfo.balance.toFixed(2)} USDT\n\nPlease enter the amount of USDT you want to transfer:\n\n*Minimum:* ${MIN_INTERNAL_TRANSFER_USDT} USDT\n*Transfer Fee:* ${TRANSFER_FEE_PERCENTAGE}%`;
    
    sendOrEditMessage(chatId, message);
});

// NEW: Handler for the /find command
bot.onText(/\/find/, (msg) => {
    const chatId = msg.chat.id;
    userStates[chatId] = { awaiting: 'order_number_search' };
    sendOrEditMessage(chatId, "🔍 *Find Transaction*\n\nPlease enter your order number (e.g., ORD1000123456):");
});

// NEW: Handler for the /referral command
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

    sendOrEditMessage(chatId, message, {
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
*❓ How to Use the USDT Seller Bot (FAQ)*

This bot helps you convert your USDT into USD, EUR, or GBP. Here is the step-by-step process:

*Step 1: Start a Transaction*
- Use the \`/start\` command to begin.
- Choose the fiat currency you wish to receive.

*Step 2: Select the Network*
- You will be asked to select the blockchain network for your USDT deposit.
- ⚠️ *CRITICAL:* You *must* choose the same network that your wallet uses (e.g., if your USDT is on the Tron network, select TRC20). Sending on the wrong network will result in a loss of funds.

*Step 3: Enter the Amount*
- Enter the amount of USDT you want to sell.
- The minimum is *${MIN_USDT} USDT* and the maximum is *${MAX_USDT} USDT*.

*Step 4: Choose Payout Method & Details*
- Select how you'd like to receive your money (Wise, PayPal, Bank Transfer, etc.).
- Provide the necessary payment details when prompted.

*Step 5: Review and Confirm*
- Review all your transaction details before proceeding.

*Step 6: Deposit USDT*
- The bot will generate a unique deposit address for you.
- Send the *exact* amount of USDT to this address.
- Once your transaction is confirmed on the blockchain, we will process your fiat payout.

*Internal Transfers*
- Use \`/transfer\` to send USDT to other bot users
- Each user has a unique account number
- Transfer fee: ${TRANSFER_FEE_PERCENTAGE}%
- Minimum transfer: ${MIN_INTERNAL_TRANSFER_USDT} USDT

*Order Numbers*
- Each transaction gets a unique order number (e.g., ORD1000123456)
- Use \`/find\` command to search for your transaction by order number
- Provide order number to support for faster assistance

*Need more help?*
Please write a direct message to our support team using the \`/support\` command.
    `;
    sendOrEditMessage(chatId, helpMessage);
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
    sendOrEditMessage(chatId, "💬 *Support Message*\n\nPlease type your question or issue in a single message. A support agent will reply to you as soon as possible.", {
        reply_markup: {
            force_reply: true, 
            selective: true
        }
    });
});


// Handler for all callback queries from inline buttons
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    // Initialize state if not present
    if (!userStates[chatId]) {
        userStates[chatId] = {};
    }
    initializeReferralData(chatId); // Ensure referral data exists
    initializeUserAccount(chatId); // Ensure account exists

    // Clear any pending support state if the user clicks a transaction button
    if (userStates[chatId].awaiting === 'support_message') {
        delete userStates[chatId].awaiting;
    }

    if (data === 'show_help') {
        // Use the existing /help command handler
        bot.getMe().then(() => {
             bot.processUpdate({ update_id: 0, message: { ...msg, text: '/help', entities: [{type: 'bot_command', offset: 0, length: 5}]}});
        });
    } else if (data === 'find_transaction') {
        // Trigger the find transaction flow
        bot.getMe().then(() => {
             bot.processUpdate({ update_id: 0, message: { ...msg, text: '/find', entities: [{type: 'bot_command', offset: 0, length: 5}]}});
        });
    } else if (data === 'internal_transfer') {
        // Trigger the internal transfer flow
        bot.getMe().then(() => {
             bot.processUpdate({ update_id: 0, message: { ...msg, text: '/transfer', entities: [{type: 'bot_command', offset: 0, length: 9}]}});
        });
    } else if (data === 'start_sell') {
        // Show loading before showing exchange rates
        await showLoadingMessage(chatId);
        
        // UPDATED: Exchange rates display - EDIT CURRENT MESSAGE
        const ratesInfo = `*💰 Current Exchange Rates*\n\n- 1 USD = ${RATES.USD_TO_USDT} USDT\n- 1 USDT = ${RATES.USDT_TO_EUR} EUR\n- 1 USDT = ${RATES.USDT_TO_GBP} GBP\n\nWhich currency would you like to receive?`;
        sendOrEditMessage(chatId, ratesInfo, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🇺🇸 USD", callback_data: 'fiat_USD' }, { text: "🇪🇺 EUR", callback_data: 'fiat_EUR' }, { text: "🇬🇧 GBP", callback_data: 'fiat_GBP' }]
                ]
            }
        });
    } else if (data === 'cancel') {
        sendOrEditMessage(chatId, "No problem! Feel free to start again whenever you're ready by sending /start.");
        delete userStates[chatId]; // Clear all state
    } else if (data.startsWith('fiat_')) {
        await showLoadingMessage(chatId);
        
        const currency = data.split('_')[1];
        userStates[chatId].fiat = currency;
        const networkMessage = `✅ You selected *${currency}*\n\nNow, please select the network for your USDT deposit:`;
        sendOrEditMessage(chatId, networkMessage, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "TRC20 (Tron)", callback_data: 'net_TRC20' }],
                    [{ text: "ERC20 (Ethereum)", callback_data: 'net_ERC20' }]
                ]
            }
        });
    } else if (data.startsWith('net_')) {
        await showLoadingMessage(chatId);
        
        const network = data.split('_')[1];
        userStates[chatId].network = network;
        userStates[chatId].awaiting = 'amount';
        const amountMessage = `✅ You selected *${network}*\n\nPlease enter the amount of USDT you want to sell.\n\n*Minimum:* ${MIN_USDT} USDT\n*Maximum:* ${MAX_USDT} USDT`;
        sendOrEditMessage(chatId, amountMessage);
    } else if (data.startsWith('pay_')) {
        await showLoadingMessage(chatId);
        
        const method = data.split('_')[1];
        let prompt = '';
        
        // Don't set payment method yet for multi-step choices
        if (method !== 'bank' && method !== 'skrill') {
            userStates[chatId].paymentMethod = method;
        }

        switch (method) {
            case 'wise':
                prompt = '✅ *Wise Selected*\n\nPlease provide your *Wise email* or *@wisetag*:';
                userStates[chatId].awaiting = 'wise_details';
                break;
            case 'revolut':
                prompt = '✅ *Revolut Selected*\n\nPlease provide your *Revolut tag* (e.g., @username):';
                userStates[chatId].awaiting = 'revolut_details';
                break;
            case 'paypal':
                prompt = '✅ *PayPal Selected*\n\nPlease provide your *PayPal email address*:';
                userStates[chatId].awaiting = 'paypal_details';
                break;
            case 'bank':
                sendOrEditMessage(chatId, "✅ *Bank Transfer Selected*\n\nPlease select your bank's region:", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🇪🇺 European Bank", callback_data: 'bank_eu' }],
                            [{ text: "🇺🇸 US Bank", callback_data: 'bank_us' }]
                        ]
                    }
                });
                break;
            case 'skrill':
                sendOrEditMessage(chatId, "✅ *Skrill/Neteller Selected*\n\nAre you using Skrill or Neteller?", {
                   reply_markup: {
                        inline_keyboard: [
                            [{ text: "Skrill", callback_data: 'payout_skrill' }],
                            [{ text: "Neteller", callback_data: 'payout_neteller' }]
                        ]
                   }
                });
                break;
            case 'card':
                prompt = '✅ *Card Payment Selected*\n\nPlease provide your *Visa or Mastercard number*:';
                userStates[chatId].awaiting = 'card_details';
                break;
            case 'payeer':
                prompt = '✅ *Payeer Selected*\n\nPlease provide your *Payeer Number* (e.g., P12345678):';
                userStates[chatId].awaiting = 'payeer_details';
                break;
            case 'alipay':
                prompt = '✅ *Alipay Selected*\n\nPlease provide your *Alipay email*:';
                userStates[chatId].awaiting = 'alipay_details';
                break;
        }
        if (prompt) {
            sendOrEditMessage(chatId, prompt);
        }
    } else if (data.startsWith('payout_')) { // Handles Skrill/Neteller choice
        await showLoadingMessage(chatId);
        
        const method = data.split('_')[1]; // 'skrill' or 'neteller'
        userStates[chatId].paymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
        userStates[chatId].awaiting = 'skrill_neteller_details';
        sendOrEditMessage(chatId, `✅ *${userStates[chatId].paymentMethod} Selected*\n\nPlease provide your *${userStates[chatId].paymentMethod} email*:`);
    
    } else if (data.startsWith('bank_')) { // Handles Bank region choice
        await showLoadingMessage(chatId);
        
        const region = data.split('_')[1]; // 'eu' or 'us'
        userStates[chatId].paymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        if (region === 'eu') {
            userStates[chatId].awaiting = 'bank_details_eu';
            const prompt = '✅ *European Bank Transfer Selected*\n\nPlease provide your bank details. Reply with a single message in the following format:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            sendOrEditMessage(chatId, prompt);
        } else if (region === 'us') {
            userStates[chatId].awaiting = 'bank_details_us';
            const prompt = '✅ *US Bank Transfer Selected*\n\nPlease provide your US bank details. Reply with a single message in the following format:\n\n`Account Holder Name:\nAccount Number:\nRouting Number (ACH or ABA):`';
            sendOrEditMessage(chatId, prompt);
        }
    } else if (data === 'confirm_transaction') { // NEW: User confirms transaction details
        await showLoadingMessage(chatId);
        
        userStates[chatId].awaiting = null;
        sendOrEditMessage(chatId, "⏳ Thank you! Generating your secure deposit address, please wait...");
        generateDepositAddress(chatId);
        
    } else if (data === 'edit_transaction') { // NEW: User wants to edit transaction details
        await showLoadingMessage(chatId);
        
        sendOrEditMessage(chatId, "No problem! Let's start over. Use /start to begin a new transaction.");
        delete userStates[chatId];
        
    } else if (data === 'withdraw_referral') { // NEW: Initiate referral withdrawal
        await showLoadingMessage(chatId);
        
        const { balance } = referralData[chatId];
        
        if (balance < MIN_REFERRAL_WITHDRAWAL_USDT) {
             sendOrEditMessage(chatId, `❌ You must have at least *${MIN_REFERRAL_WITHDRAWAL_USDT} USDT* to withdraw. Your current balance is *${balance.toFixed(2)} USDT*.`);
             bot.answerCallbackQuery(callbackQuery.id);
             return;
        }

        userStates[chatId].awaiting = 'referral_withdrawal_payment_selection'; // A placeholder state, detail prompt comes next
        userStates[chatId].withdrawalAmount = balance; // Store the full balance for withdrawal

        const message = `*💰 Initiate Referral Withdrawal*\n\nYou are withdrawing your total balance of *${balance.toFixed(2)} USDT*. Please select how you wish to receive the funds:`;

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

    } else if (data.startsWith('refpay_')) { // NEW: Handle payment selection for referral withdrawal
        await showLoadingMessage(chatId);
        
        const method = data.split('_')[1];
        let prompt = '';
        
        userStates[chatId].isReferralWithdrawal = true; // Flag to differentiate from main transaction
        userStates[chatId].referralPaymentMethod = method; // Store the base method

        switch (method) {
            case 'wise':
                prompt = '✅ *Wise Selected*\n\nPlease provide your *Wise email* or *@wisetag*:';
                userStates[chatId].awaiting = 'ref_wise_details';
                break;
            case 'revolut':
                prompt = '✅ *Revolut Selected*\n\nPlease provide your *Revolut tag* (e.g., @username):';
                userStates[chatId].awaiting = 'ref_revolut_details';
                break;
            case 'paypal':
                prompt = '✅ *PayPal Selected*\n\nPlease provide your *PayPal email address*:';
                userStates[chatId].awaiting = 'ref_paypal_details';
                break;
            case 'bank':
                sendOrEditMessage(chatId, "✅ *Bank Transfer Selected*\n\nPlease select your bank's region:", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🇪🇺 European Bank", callback_data: 'refbank_eu' }],
                            [{ text: "🇺🇸 US Bank", callback_data: 'refbank_us' }]
                        ]
                    }
                });
                break;
            case 'skrill':
                sendOrEditMessage(chatId, "✅ *Skrill/Neteller Selected*\n\nAre you using Skrill or Neteller?", {
                   reply_markup: {
                        inline_keyboard: [
                            [{ text: "Skrill", callback_data: 'refpayout_skrill' }],
                            [{ text: "Neteller", callback_data: 'refpayout_neteller' }]
                        ]
                   }
                });
                break;
            case 'card':
                prompt = '✅ *Card Payment Selected*\n\nPlease provide your *Visa or Mastercard number*:';
                userStates[chatId].awaiting = 'ref_card_details';
                break;
            case 'payeer':
                prompt = '✅ *Payeer Selected*\n\nPlease provide your *Payeer Number* (e.g., P12345678):';
                userStates[chatId].awaiting = 'ref_payeer_details';
                break;
            case 'alipay':
                prompt = '✅ *Alipay Selected*\n\nPlease provide your *Alipay email*:';
                userStates[chatId].awaiting = 'ref_alipay_details';
                break;
        }
        if (prompt) {
            sendOrEditMessage(chatId, prompt);
        }
        
    } else if (data.startsWith('refpayout_')) { // NEW: Handles Skrill/Neteller choice for referral
        await showLoadingMessage(chatId);
        
        const method = data.split('_')[1]; // 'skrill' or 'neteller'
        userStates[chatId].referralPaymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
        userStates[chatId].awaiting = 'ref_skrill_neteller_details';
        sendOrEditMessage(chatId, `✅ *${userStates[chatId].referralPaymentMethod} Selected*\n\nPlease provide your *${userStates[chatId].referralPaymentMethod} email*:`);

    } else if (data.startsWith('refbank_')) { // NEW: Handles Bank region choice for referral
        await showLoadingMessage(chatId);
        
        const region = data.split('_')[1]; // 'eu' or 'us'
        userStates[chatId].referralPaymentMethod = region === 'eu' ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        if (region === 'eu') {
            userStates[chatId].awaiting = 'ref_bank_details_eu';
            const prompt = '✅ *European Bank Transfer Selected*\n\nPlease provide your bank details. Reply with a single message in the following format:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            sendOrEditMessage(chatId, prompt);
        } else if (region === 'us') {
            userStates[chatId].awaiting = 'ref_bank_details_us';
            const prompt = '✅ *US Bank Transfer Selected*\n\nPlease provide your US bank details. Reply with a single message in the following format:\n\n`Account Holder Name:\nAccount Number:\nRouting Number (ACH or ABA):`';
            sendOrEditMessage(chatId, prompt);
        }
    }

    // Acknowledge the button press
    bot.answerCallbackQuery(callbackQuery.id);
});

// UPDATED: Function to generate deposit address after confirmation (now with order number)
async function generateDepositAddress(chatId) {
    const userState = userStates[chatId];
    
    try {
        const networkMap = {
            'TRC20': 'USDT.TRC20',
            'ERC20': 'USDT.ERC20'
        };
        const coinCurrency = networkMap[userState.network];
        
        // Ensure payment method is set for the custom field
        let paymentMethodForCustom = userState.paymentMethod;
        if (!paymentMethodForCustom && userState.awaiting && userState.awaiting.includes('bank_details_')) {
            paymentMethodForCustom = userState.awaiting.includes('_eu') ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
        } else if (!paymentMethodForCustom && userState.awaiting === 'skrill_neteller_details') {
             // paymentMethod would have been set in the `payout_` callback
             paymentMethodForCustom = userState.paymentMethod;
        } else if (!paymentMethodForCustom && userState.awaiting) {
            paymentMethodForCustom = userState.awaiting.split('_')[0]; // Fallback (wise, revolut, etc.)
        }
        userState.paymentMethod = paymentMethodForCustom;

        // NEW: Generate order number
        const orderNumber = generateOrderNumber();
        
        const transactionOptions = {
            currency1: 'USDT',
            currency2: coinCurrency,
            amount: userState.amount,
            buyer_email: BUYER_REFUND_EMAIL,
            custom: `Order: ${orderNumber} | Payout to ${userState.paymentMethod}: ${userState.paymentDetails}`,
            item_name: `Sell ${userState.amount} USDT for ${userState.fiat}`,
            ipn_url: 'YOUR_IPN_WEBHOOK_URL'
        };

        const result = await coinpayments.createTransaction(transactionOptions);

        // NEW: Store transaction record
        storeTransactionRecord(orderNumber, {
            userId: chatId,
            amount: userState.amount,
            fiat: userState.fiat,
            network: userState.network,
            paymentMethod: userState.paymentMethod,
            paymentDetails: userState.paymentDetails,
            coinpaymentsTxnId: result.txn_id,
            depositAddress: result.address,
            timestamp: new Date().toISOString()
        });

        // --- REFERRAL REWARD SIMULATION (NEW) ---
        const referrerId = referralData[chatId]?.referrerId;
        if (referrerId) {
            // Reward if user has a referrer and hasn't triggered the reward before
            if (!referralData[chatId].isReferralRewardClaimed) {
                rewardReferrer(referrerId, chatId);
                referralData[chatId].isReferralRewardClaimed = true; // Mark as rewarded
            }
        }
        // --- END REFERRAL REWARD SIMULATION ---

        const depositInfo = `✅ *Deposit Address Generated!*\n\n*Order Number:* #${orderNumber}\n*Transaction ID:* ${result.txn_id}\n\nPlease send exactly *${result.amount} USDT* (${userState.network}) to the address below:\n\n` +
            `\`${result.address}\`\n\n` + 
            `⏳ *Awaiting payment confirmation...*\n\n` +
            `*Payout Method:* ${userState.paymentMethod}\n` +
            `*Payout Details:* \n\`${userState.paymentDetails}\`\n\n` +
            `⚠️ *IMPORTANT:* Send only USDT on the ${userState.network} network to this address. Sending any other coin or using a different network may result in the loss of your funds.\n\n` +
            `💡 *Tip:* Save your order number (#${orderNumber}) for future reference. Use \`/find\` command to check your transaction status.`;

        sendOrEditMessage(chatId, depositInfo);
        delete userStates[chatId];

    } catch (error) {
        console.error("CoinPayments API Error:", error);
        sendOrEditMessage(chatId, "❌ Sorry, there was an error generating your deposit address. Please try again later or contact support.");
    }
}

// Handler for text messages (for amount, payment details, support messages, order number search, and internal transfers)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userState = userStates[chatId];
    initializeReferralData(chatId); // Ensure user has referral data initialized
    initializeUserAccount(chatId); // Ensure user has account initialized

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

            sendOrEditMessage(chatId, "✅ Your message has been sent to support. We will reply to you here as soon as possible. You can use `/start` to begin a transaction while you wait.");
            delete userStates[chatId]; 
        } catch (error) {
            console.error("Error forwarding support message:", error);
            sendOrEditMessage(chatId, "❌ Sorry, I couldn't send your message to support right now. Please try again later.");
        }
        return;
    }

    // NEW: ORDER NUMBER SEARCH LOGIC
    if (userState && userState.awaiting === 'order_number_search') {
        const orderNumber = text.trim().toUpperCase();
        const transaction = findTransactionByOrderNumber(orderNumber);
        
        if (transaction) {
            const transactionInfo = `
🔍 *Transaction Found*

*Order Number:* #${transaction.orderNumber}
*Transaction ID:* ${transaction.coinpaymentsTxnId}
*Amount:* ${transaction.amount} USDT
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
                        [{ text: "🔙 Back to Main Menu", callback_data: 'start_sell' }]
                    ]
                }
            });
        } else {
            sendOrEditMessage(chatId, `❌ No transaction found with order number *${orderNumber}*. Please check the order number and try again.`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔄 Try Again", callback_data: 'find_transaction' }],
                        [{ text: "🔙 Back to Main Menu", callback_data: 'start_sell' }]
                    ]
                }
            });
        }
        delete userStates[chatId];
        return;
    }

    // NEW: INTERNAL TRANSFER LOGIC
    if (userState && userState.awaiting === 'transfer_amount') {
        const amount = parseFloat(text);
        const accountInfo = userAccounts[chatId];
        
        if (isNaN(amount) || amount < MIN_INTERNAL_TRANSFER_USDT) {
            sendOrEditMessage(chatId, `❌ Invalid amount. Please enter a number greater than or equal to ${MIN_INTERNAL_TRANSFER_USDT} USDT.`);
            return;
        }
        
        if (amount > accountInfo.balance) {
            sendOrEditMessage(chatId, `❌ Insufficient balance. You have ${accountInfo.balance.toFixed(2)} USDT available.`);
            return;
        }
        
        userState.transferAmount = amount;
        userState.awaiting = 'transfer_account';
        
        sendOrEditMessage(chatId, `✅ Transfer amount: *${amount} USDT*\n\nPlease enter the recipient's account number (e.g., ACC100000):`);
        return;
    }
    
    if (userState && userState.awaiting === 'transfer_account') {
        const recipientAccount = text.trim().toUpperCase();
        const amount = userState.transferAmount;
        
        // Check if transferring to own account
        if (recipientAccount === userAccounts[chatId].accountNumber) {
            sendOrEditMessage(chatId, "❌ You cannot transfer to your own account.");
            delete userStates[chatId];
            return;
        }
        
        const transferResult = processInternalTransfer(chatId, recipientAccount, amount);
        
        if (!transferResult.success) {
            sendOrEditMessage(chatId, `❌ Transfer failed: ${transferResult.error}`);
            delete userStates[chatId];
            return;
        }
        
        // Transfer successful
        const fee = transferResult.fee;
        const netAmount = transferResult.netAmount;
        const recipientId = transferResult.recipientId;
        
        // Notify sender
        const senderMessage = `✅ *Transfer Successful!*\n\n*Amount Sent:* ${amount} USDT\n*Transfer Fee:* ${fee.toFixed(2)} USDT (${TRANSFER_FEE_PERCENTAGE}%)\n*Net Amount Received:* ${netAmount.toFixed(2)} USDT\n*Recipient Account:* ${recipientAccount}\n*Your New Balance:* ${userAccounts[chatId].balance.toFixed(2)} USDT`;
        
        sendOrEditMessage(chatId, senderMessage, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔄 Make Another Transfer", callback_data: 'internal_transfer' }],
                    [{ text: "🔙 Back to Main Menu", callback_data: 'start_sell' }]
                ]
            }
        });
        
        // Notify recipient
        try {
            const recipientMessage = `💰 *You Received a Transfer!*\n\n*Amount Received:* ${netAmount.toFixed(2)} USDT\n*From Account:* ${userAccounts[chatId].accountNumber}\n*Your New Balance:* ${userAccounts[recipientId].balance.toFixed(2)} USDT`;
            await bot.sendMessage(recipientId, recipientMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error("Could not notify recipient:", error);
        }
        
        delete userStates[chatId];
        return;
    }

    // 3. TRANSACTION / WITHDRAWAL FLOW LOGIC
    if (userState && userState.awaiting) {
        const awaiting = userState.awaiting;

        if (awaiting === 'amount') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount < MIN_USDT || amount > MAX_USDT) {
                sendOrEditMessage(chatId, `❌ Invalid amount. Please enter a number between ${MIN_USDT} and ${MAX_USDT}.`);
                return;
            }
            userState.amount = amount;

            const fiatToReceive = calculateFiat(amount, userState.fiat);
            const confirmationMessage = `✅ *Amount Confirmed: ${amount} USDT*\n\nYou will receive approximately *${fiatToReceive.toFixed(2)} ${userState.fiat}*.\n\nPlease choose your preferred payment method:`;

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

            // --- MAIN TRANSACTION DETAILS HANDLER ---
            userState.paymentDetails = text;
            userState.awaiting = null;
            
            // NEW: Generate order number for the review step
            const orderNumber = generateOrderNumber();
            
            // Show review and confirmation step with payment details and order number
            const reviewMessage = formatPaymentDetails(userState, orderNumber);
            
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

            // --- REFERRAL WITHDRAWAL DETAILS HANDLER (NEW) ---
            const withdrawalAmount = userState.withdrawalAmount;
            
            // Set payment method if it was decided in a nested step
            let paymentMethod = userState.referralPaymentMethod;
            if (awaiting.includes('ref_bank_details_')) {
                paymentMethod = awaiting.includes('_eu') ? 'Bank Transfer (EU)' : 'Bank Transfer (US)';
            } else if (awaiting === 'ref_skrill_neteller_details') {
                paymentMethod = userState.referralPaymentMethod;
            } else {
                paymentMethod = awaiting.split('_')[1]; // Wise, PayPal, etc.
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
                sendOrEditMessage(chatId, 
                    `✅ *Withdrawal Request Submitted!*\n\n` +
                    `We have successfully received your request to withdraw *${withdrawalAmount.toFixed(2)} USDT* via ${paymentMethod}.\n\n` +
                    `The payment will be processed to your provided details shortly. You can check your remaining balance with \`/referral\`.`
                );

            } catch (error) {
                console.error("Referral withdrawal error:", error);
                sendOrEditMessage(chatId, "❌ Sorry, there was an error submitting your withdrawal request. Please try again later.");
            }
            
            delete userStates[chatId]; // Clean up state for withdrawal flow
        }
    }
});


console.log("Bot is running...");
