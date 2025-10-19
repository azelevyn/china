require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

// --- BOT AND API INITIALIZATION ---

// Check for essential environment variables, including the new ADMIN_CHAT_ID
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
    { command: 'help', description: '❓ How to use this bot (FAQ)' },
    { command: 'support', description: '💬 Contact a support agent' } // New command
]);


// --- CONSTANTS AND CONFIGURATION ---

const MERCHANT_ID = '431eb6f352649dfdcde42b2ba8d5b6d8'; // Your Merchant ID
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com'; // Your refund email
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // New: ID of the admin receiving support requests
const MIN_USDT = 25;
const MAX_USDT = 50000;
const SUPPORT_CONTACT = '@DeanAbdullah'; // REPLACE WITH YOUR SUPPORT USERNAME

// Conversion Rates
const RATES = {
    USDT_TO_USD: 1 / 1.08, // Based on USD TO USDT 1.08
    USD_TO_EUR: 0.89,
    USDT_TO_GBP: 0.77,
};

// In-memory storage for user conversation state
const userStates = {};

// New: Map to link forwarded admin message ID back to the original user's chat ID
const adminReplyMap = {};


// --- HELPER FUNCTIONS ---

// Function to calculate the received amount
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

// Function to get current formatted date and time (24-hour format)
function getCurrentDateTime() {
    const now = new Date();
    // Example: 20 Oct 2025 - 13:43:00
    const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${date} - ${time}`;
}


// --- BOT COMMANDS AND MESSAGE HANDLERS ---

// Handler for the /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || '';
    const dateTime = getCurrentDateTime(); // Get current date and time

    // Reset user state
    userStates[chatId] = {};

    const welcomeMessage = `Hello, *${firstName}*!\n\nWelcome to the USDT Seller Bot. Current time: *${dateTime}*.\n\nI can help you easily sell your USDT for fiat currency (USD, EUR, GBP).\n\nReady to start?`;

    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Yes, I want to sell USDT", callback_data: 'start_sell' }],
                [{ text: " GUIDE: How to use the Bot", callback_data: 'show_help' }]
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

*Step 5: Deposit USDT*
- The bot will generate a unique deposit address for you.
- Send the *exact* amount of USDT to this address.
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
        const ratesInfo = `*Current Exchange Rates:*\n- 1 USDT ≈ ${RATES.USDT_TO_USD.toFixed(3)} USD\n- 1 USDT ≈ ${(RATES.USDT_TO_USD * RATES.USD_TO_EUR).toFixed(3)} EUR\n- 1 USDT ≈ ${RATES.USDT_TO_GBP.toFixed(3)} GBP\n\nWhich currency would you like to receive?`;
        bot.sendMessage(chatId, ratesInfo, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🇺🇸 USD", callback_data: 'fiat_USD' }, { text: "🇪🇺 EUR", callback_data: 'fiat_EUR' }, { text: "🇬🇧 GBP", callback_data: 'fiat_GBP' }]
                ]
            }
        });
    } else if (data === 'cancel') {
        bot.sendMessage(chatId, "No problem! Feel free to start again whenever you're ready by sending /start.");
        delete userStates[chatId]; // Clear all state
    } else if (data.startsWith('fiat_')) {
        const currency = data.split('_')[1];
        userStates[chatId].fiat = currency;
        const networkMessage = "Great! Now, please select the network for your USDT deposit:";
        bot.sendMessage(chatId, networkMessage, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "BEP20 (BSC)", callback_data: 'net_BEP20' }],
                    [{ text: "TRC20 (Tron)", callback_data: 'net_TRC20' }],
                    [{ text: "ERC20 (Ethereum)", callback_data: 'net_ERC20' }]
                ]
            }
        });
    } else if (data.startsWith('net_')) {
        const network = data.split('_')[1];
        userStates[chatId].network = network;
        userStates[chatId].awaiting = 'amount';
        bot.sendMessage(chatId, `Please enter the amount of USDT you want to sell.\n\n*Minimum:* ${MIN_USDT} USDT\n*Maximum:* ${MAX_USDT} USDT`, { parse_mode: 'Markdown' });
    } else if (data.startsWith('pay_')) {
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
    }

    // Acknowledge the button press
    bot.answerCallbackQuery(callbackQuery.id);
});

// Handler for text messages (for amount, payment details, and support messages)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userState = userStates[chatId];

    // 1. ADMIN REPLY LOGIC
    if (msg.reply_to_message && chatId.toString() === ADMIN_CHAT_ID) {
        const forwardedMessageId = msg.reply_to_message.message_id;
        const originalUserChatId = adminReplyMap[forwardedMessageId];

        if (originalUserChatId) {
            try {
                // Send the admin's response back to the original user
                await bot.sendMessage(originalUserChatId, `*📢 Support Reply from Admin:*\n\n${text}`, { parse_mode: 'Markdown' });
                await bot.sendMessage(chatId, "✅ Reply successfully sent to the user.");
                // Remove the mapping after successful reply
                delete adminReplyMap[forwardedMessageId]; 
            } catch (e) {
                console.error("Error sending reply back to user:", e);
                await bot.sendMessage(chatId, "❌ Error sending reply back to the user. User may have blocked the bot.");
            }
        } else {
            bot.sendMessage(chatId, "I can't match that reply to an active support request.");
        }
        return; // Exit message handler if it was an admin reply
    }

    // Ignore commands (non-admin replies to forwarded messages are also ignored)
    if (!text || text.startsWith('/')) return;

    // --- USER FLOW LOGIC ---

    if (userState && userState.awaiting === 'support_message') {
        // 2. USER SENDS SUPPORT MESSAGE
        
        const supportText = text;
        const userInfo = `User ID: ${msg.from.id}, Name: ${msg.from.first_name || ''} ${msg.from.last_name || ''}, Username: @${msg.from.username || 'N/A'}`;
        const forwardedMessage = `*🚨 NEW SUPPORT REQUEST*\n\nFrom: ${userInfo}\n\n*Message:* \n${supportText}\n\n--- \n_To reply to this user, simply reply to this message._`;
        
        try {
            // Send the request to the admin chat
            const sentMessage = await bot.sendMessage(ADMIN_CHAT_ID, forwardedMessage, { parse_mode: 'Markdown' });

            // Store the mapping: Admin's message ID -> Original User's Chat ID
            adminReplyMap[sentMessage.message_id] = chatId;

            // Confirm to the user
            bot.sendMessage(chatId, "✅ Your message has been sent to support. We will reply to you here as soon as possible. You can use `/start` to begin a transaction while you wait.");
            
            delete userStates[chatId]; // Clean up state
            
        } catch (error) {
            console.error("Error forwarding support message:", error);
            bot.sendMessage(chatId, "❌ Sorry, I couldn't send your message to support right now. Please try again later.");
        }
        return; // Exit handler
    }


    // 3. TRANSACTION FLOW LOGIC
    if (userState && userState.awaiting) {
        const awaiting = userState.awaiting;

        if (awaiting === 'amount') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount < MIN_USDT || amount > MAX_USDT) {
                bot.sendMessage(chatId, `❌ Invalid amount. Please enter a number between ${MIN_USDT} and ${MAX_USDT}.`);
                return;
            }
            userState.amount = amount;

            const fiatToReceive = calculateFiat(amount, userState.fiat);
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
            userState.awaiting = null; // Wait for button press now
        } else if ([
            'wise_details', 'revolut_details', 'paypal_details', 'card_details', 
            'payeer_details', 'alipay_details', 'skrill_neteller_details', 
            'bank_details_eu', 'bank_details_us'
        ].includes(awaiting)) {
            userState.paymentDetails = text;
            userState.awaiting = null; // Stop waiting for messages
            bot.sendMessage(chatId, "⏳ Thank you! Generating your secure deposit address, please wait...");

            // --- COINPAYMENTS API CALL ---
            try {
                const networkMap = {
                    'BEP20': 'USDT.BEP20',
                    'TRC20': 'USDT.TRC20',
                    'ERC20': 'USDT.ERC20'
                };
                const coinCurrency = networkMap[userState.network];

                const transactionOptions = {
                    currency1: 'USDT',
                    currency2: coinCurrency,
                    amount: userState.amount,
                    buyer_email: BUYER_REFUND_EMAIL,
                    custom: `Payout to ${userState.paymentMethod}: ${userState.paymentDetails}`,
                    item_name: `Sell ${userState.amount} USDT for ${userState.fiat}`,
                    ipn_url: 'YOUR_IPN_WEBHOOK_URL'
                };

                const result = await coinpayments.createTransaction(transactionOptions);

                const depositInfo = `✅ *Deposit Address Generated!*\n\nPlease send exactly *${result.amount} USDT* (${userState.network}) to the address below:\n\n` +
                    `\`${result.address}\`\n\n` + // Backticks for easy copying
                    `*Status URL:* [Click to Track](${result.status_url})\n\n` +
                    `*Payout Method:* ${userState.paymentMethod}\n` +
                    `*Payout Details:* \n\`${userState.paymentDetails}\`\n\n` +
                    `⚠️ *IMPORTANT:* Send only USDT on the ${userState.network} network to this address. Sending any other coin or using a different network may result in the loss of your funds.`;

                bot.sendMessage(chatId, depositInfo, { parse_mode: 'Markdown' });
                delete userStates[chatId];

            } catch (error) {
                console.error("CoinPayments API Error:", error);
                bot.sendMessage(chatId, "❌ Sorry, there was an error generating your deposit address. Please try again later or contact support.");
            }
        }
    }
});


console.log("Bot is running...");
