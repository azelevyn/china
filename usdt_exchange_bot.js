require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');
const qrcode = require('qrcode');

// --- CONSTANTS AND CONFIGURATION ---

const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com'; // Your refund email
const IPN_WEBHOOK_URL = 'YOUR_IPN_WEBHOOK_URL_HERE'; // ⚠️ CRITICAL: Replace with your actual IPN URL
const MIN_USDT = 25;
const MAX_USDT = 50000;
const SUPPORT_CONTACT = '@YourSupportUsername'; // Placeholder for consistency, but the feature is now direct chat
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_ID; // ⚠️ CRITICAL: Must be set in .env to your Telegram Chat ID

// Conversion Rates
const RATES = {
    USDT_TO_USD: 1 / 1.08, // Based on USD TO USDT 1.08
    USD_TO_EUR: 0.89,
    USDT_TO_GBP: 0.77,
};

const NETWORK_MAP = {
    'TRC20': 'USDT.TRC20',
    'ERC20': 'USDT.ERC20'
};

// In-memory storage for user conversation state (volatile)
const userStates = {};

// --- BOT AND API INITIALIZATION ---

// Check for essential environment variables, including the Admin ID
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.COINPAYMENTS_PUBLIC_KEY || !process.env.COINPAYMENTS_PRIVATE_KEY || !ADMIN_CHAT_ID) {
    console.error("FATAL ERROR: Missing required environment variables (TELEGRAM_BOT_TOKEN, COINPAYMENTS_PUBLIC_KEY, COINPAYMENTS_PRIVATE_KEY, or TELEGRAM_ADMIN_ID). Please check your .env file.");
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
    { command: 'start', description: '🚀 Restart the Bot' },
    { command: 'help', description: '❓ How to use this bot (FAQ)' }
]);


// --- HELPER FUNCTIONS ---

/**
 * Calculates the fiat amount received based on USDT input and rates.
 * @param {number} usdtAmount - The amount of USDT the user is selling.
 * @param {string} fiatCurrency - The desired fiat currency ('USD', 'EUR', 'GBP').
 * @returns {number} The calculated fiat amount.
 */
function calculateFiat(usdtAmount, fiatCurrency) {
    let amountInUSD = usdtAmount * RATES.USDT_TO_USD;
    if (fiatCurrency === 'USD') return amountInUSD;
    if (fiatCurrency === 'EUR') return amountInUSD * RATES.USD_TO_EUR;
    if (fiatCurrency === 'GBP') return usdtAmount * RATES.USDT_TO_GBP; // Note: using direct GBP rate as defined
    return 0;
}

/**
 * Sends the welcome message and main menu.
 * @param {number} chatId - Telegram chat ID.
 * @param {string} firstName - User's first name.
 */
const sendWelcomeMessage = (chatId, firstName) => {
    // Reset user state
    userStates[chatId] = {};
    
    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'minute', timeZone: 'Asia/Kuala_Lumpur', hour12: false };
    const formattedDate = new Intl.DateTimeFormat('en-GB', options).format(now);

    const welcomeMessage = `✨ Greetings, *${firstName}*! Welcome to the USDT Exchanger of the future. ✨\n\n` +
    `Here, you can seamlessly convert your digital USDT into real-world currency. Let's begin your journey!\n\n` +
    `*Current Time:* ${formattedDate} (Malaysia Time)`;

    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [
                [{ text: "🚀 Sell USDT" }],
                [{ text: "❓ FAQ / Help" }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    });
};

/**
 * Sends the detailed help/FAQ message, updated to instruct direct messaging for support.
 * @param {number} chatId - Telegram chat ID.
 */
const sendHelpMessage = (chatId) => {
    const helpMessage = `
*❓ How to Use the USDT Seller Bot (FAQ)*

This bot helps you convert your USDT into USD, EUR, or GBP. Here is the step-by-step process:

*Step 1: Start a Transaction*
- Tap the \`🚀 Sell USDT\` button from the menu.
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
- The bot will generate a unique QR code and deposit address for you.
- Send the *exact* amount of USDT to this address.
- Once your transaction is confirmed on the blockchain, we will process your fiat payout.

*Need more help?*
Just send a direct message to this chat, and an administrator will get back to you shortly.
    `;
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
}

/**
 * Handles the "Sell USDT" menu option, asking for fiat currency.
 * @param {number} chatId - Telegram chat ID.
 */
function handleSellUSDTMenu(chatId) {
    const ratesInfo = `*Current Exchange Rates:*\n- 1 USDT ≈ ${RATES.USDT_TO_USD.toFixed(3)} USD\n- 1 USDT ≈ ${(RATES.USDT_TO_USD * RATES.USD_TO_EUR).toFixed(3)} EUR\n- 1 USDT ≈ ${RATES.USDT_TO_GBP.toFixed(3)} GBP\n\nWhich currency would you like to receive?`;
    userStates[chatId] = {}; // Reset state
    bot.sendMessage(chatId, ratesInfo, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "🇺🇸 USD", callback_data: 'fiat_USD' }, { text: "🇪🇺 EUR", callback_data: 'fiat_EUR' }, { text: "🇬🇧 GBP", callback_data: 'fiat_GBP' }]
            ]
        }
    });
}

/**
 * Handles the user input for the USDT amount.
 * @param {number} chatId - Telegram chat ID.
 * @param {string} text - The message text containing the amount.
 */
function handleAmountInput(chatId, text) {
    const state = userStates[chatId];
    const amount = parseFloat(text);

    if (isNaN(amount) || amount < MIN_USDT || amount > MAX_USDT) {
        bot.sendMessage(chatId, `❌ Invalid amount. Please enter a number between ${MIN_USDT} and ${MAX_USDT}.`);
        return;
    }
    state.amount = amount;

    const fiatToReceive = calculateFiat(amount, state.fiat);
    const confirmationMessage = `You will receive approximately *${fiatToReceive.toFixed(2)} ${state.fiat}*.\n\nPlease choose your preferred payment method:`;

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
    state.awaiting = null; // Wait for callback query next
}

/**
 * Processes the final payment details and initiates the CoinPayments transaction.
 * @param {number} chatId - Telegram chat ID.
 * @param {string} text - The message text containing the payment details.
 * @param {object} state - The current user state object.
 */
async function handlePaymentDetailsInput(chatId, text, state) {
    state.paymentDetails = text;
    state.awaiting = null; 
    bot.sendMessage(chatId, "⏳ Thank you! Generating your secure deposit address, please wait...");

    try {
        const coinCurrency = NETWORK_MAP[state.network];

        const transactionOptions = {
            currency1: 'USDT',
            currency2: coinCurrency,
            amount: state.amount,
            buyer_email: BUYER_REFUND_EMAIL,
            // Custom field used to store critical payout information for the merchant
            custom: `Payout to ${state.paymentMethod} (${state.fiat}): ${state.paymentDetails}`, 
            item_name: `Sell ${state.amount} USDT for ${state.fiat}`,
            ipn_url: IPN_WEBHOOK_URL
        };

        const result = await coinpayments.createTransaction(transactionOptions);
        const qrCodeBuffer = await qrcode.toBuffer(result.address);

        const depositInfo = `✅ *Deposit Address Generated!*\n\nPlease send exactly *${result.amount} USDT* (${state.network}) to the address below:\n\n` +
            `\`${result.address}\`\n\n` +
            `*Status URL:* [Click to Track](${result.status_url})\n\n` +
            `*Next Steps:*\nOnce the funds are received and confirmed, we will process the payout of approx. ${calculateFiat(state.amount, state.fiat).toFixed(2)} ${state.fiat} to your *${state.paymentMethod}* details.\n\n` +
            `⚠️ *IMPORTANT:* Send only USDT on the ${state.network} network. Sending any other coin may result in the loss of your funds.`;

        await bot.sendPhoto(chatId, qrCodeBuffer, { 
            caption: depositInfo,
            parse_mode: 'Markdown'
        });

        // Clear the state after a successful transaction initiation
        delete userStates[chatId]; 

    } catch (error) {
        console.error(`CoinPayments API Error for Chat ID ${chatId}:`, error);
        bot.sendMessage(chatId, "❌ Sorry, there was an error generating your deposit address. Please try again later or contact support.");
    }
}


// --- BOT COMMANDS AND MESSAGE HANDLERS ---

// Handler for the /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || 'Digital Voyager';
    sendWelcomeMessage(chatId, firstName);
});

// Handler for the /help command
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    sendHelpMessage(chatId);
});

// Handler for all callback queries from inline buttons
bot.on('callback_query', (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    // Initialize state if not present (shouldn't happen, but good safeguard)
    if (!userStates[chatId]) {
        userStates[chatId] = {};
    }
    const state = userStates[chatId];
    
    // Edit the message to prevent user from spamming buttons
    bot.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }, { chatId: chatId, messageId: msg.message_id });

    if (data === 'cancel') {
        bot.sendMessage(chatId, "Transaction cancelled. Feel free to start again whenever you're ready by sending /start.");
        delete userStates[chatId];
    } else if (data.startsWith('fiat_')) {
        const currency = data.split('_')[1];
        state.fiat = currency;
        const networkMessage = "Great! Now, please select the blockchain network for your USDT deposit:";
        bot.sendMessage(chatId, networkMessage, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "TRC20 (Tron)", callback_data: 'net_TRC20' }],
                    [{ text: "ERC20 (Ethereum)", callback_data: 'net_ERC20' }]
                ]
            }
        });
    } else if (data.startsWith('net_')) {
        const network = data.split('_')[1];
        state.network = network;
        state.awaiting = 'amount';
        bot.sendMessage(chatId, `You selected *${state.network}*. Please enter the amount of USDT you want to sell.\n\n*Minimum:* ${MIN_USDT} USDT\n*Maximum:* ${MAX_USDT} USDT`, { parse_mode: 'Markdown' });
    } else if (data.startsWith('pay_')) {
        const method = data.split('_')[1];
        let prompt = '';
        
        switch (method) {
            case 'wise':
                prompt = 'Please provide your *Wise email* or *@wisetag*.';
                state.awaiting = 'wise_details';
                state.paymentMethod = 'Wise';
                break;
            case 'revolut':
                prompt = 'Please provide your *Revolut tag* (e.g., @username).';
                state.awaiting = 'revolut_details';
                state.paymentMethod = 'Revolut';
                break;
            case 'paypal':
                prompt = 'Please provide your *PayPal email address*.';
                state.awaiting = 'paypal_details';
                state.paymentMethod = 'PayPal';
                break;
            case 'card':
                prompt = 'Please provide your *Visa or Mastercard number*.';
                state.awaiting = 'card_details';
                state.paymentMethod = 'Visa/Mastercard';
                break;
            case 'payeer':
                prompt = 'Please provide your *Payeer Number* (e.g., P12345678).';
                state.awaiting = 'payeer_details';
                state.paymentMethod = 'Payeer';
                break;
            case 'alipay':
                prompt = 'Please provide your *Alipay email*.';
                state.awaiting = 'alipay_details';
                state.paymentMethod = 'Alipay';
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
        }
        if (prompt) {
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        }
    } else if (data.startsWith('payout_')) { // Handles Skrill/Neteller choice
        const method = data.split('_')[1]; // 'skrill' or 'neteller'
        state.paymentMethod = method.charAt(0).toUpperCase() + method.slice(1);
        state.awaiting = 'generic_details'; // Use a generic state for detail collection
        bot.sendMessage(chatId, `Please provide your *${state.paymentMethod} email*.`, { parse_mode: 'Markdown' });
    
    } else if (data.startsWith('bank_')) { // Handles Bank region choice
        const region = data.split('_')[1]; // 'eu' or 'us'
        
        if (region === 'eu') {
            state.paymentMethod = 'Bank Transfer (EU)';
            state.awaiting = 'bank_details_eu';
            const prompt = 'Please provide your bank details. Reply with a single message in the following format:\n\n`First and Last Name:\nIBAN:\nSwift Code:`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        } else if (region === 'us') {
            state.paymentMethod = 'Bank Transfer (US)';
            state.awaiting = 'bank_details_us';
            const prompt = 'Please provide your US bank details. Reply with a single message in the following format:\n\n`Account Holder Name:\nAccount Number:\nRouting Number (ACH or ABA):`';
            bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
        }
    }

    // Acknowledge the button press
    bot.answerCallbackQuery(callbackQuery.id);
});

// Handler for all text messages, including transaction steps and support queries
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;
    const repliedToMessage = msg.reply_to_message;

    // --- 1. ADMIN REPLY HANDLER (Highest Priority) ---
    // This handles the admin replying to a forwarded user support message
    if (chatId === ADMIN_CHAT_ID.toString() && repliedToMessage) {
        
        // Try to extract the original user ID from the replied message's text (the header we sent)
        const match = repliedToMessage.text?.match(/Chat ID: `(\d+)`/);

        if (match && match[1]) {
            const targetUserId = match[1];
            const adminResponse = `👨‍💼 *Support Team Reply:*\n\n${msg.text}`;
            
            try {
                await bot.sendMessage(targetUserId, adminResponse, { parse_mode: 'Markdown' });
                bot.sendMessage(ADMIN_CHAT_ID, `✅ Reply sent successfully to user ID: \`${targetUserId}\``);
            } catch (error) {
                console.error(`Error sending reply to user ${targetUserId}:`, error);
                bot.sendMessage(ADMIN_CHAT_ID, `❌ Failed to send reply to user ID: \`${targetUserId}\`. Error: ${error.message}`);
            }
            return; 
        } else {
            // Only warn the admin if the text is long enough to suggest a reply attempt
            if (msg.text.length > 5 && !repliedToMessage.caption) { 
                bot.sendMessage(ADMIN_CHAT_ID, "⚠️ Could not identify the original user's ID. Please ensure you are replying to the *header message* (the one that starts with '✉️ New Support Message' and contains the Chat ID).");
            }
            return; // Ignore other non-critical admin messages
        }
    }

    // Ignore commands being typed manually, except /start and /help, and ignore messages from the admin that aren't replies
    if (!text || (text.startsWith('/') && !['/start', '/help'].includes(text))) return;
    if (chatId === ADMIN_CHAT_ID.toString()) return;

    // --- 2. MENU BUTTON HANDLERS ---
    if (text === '🚀 Sell USDT') {
        return handleSellUSDTMenu(msg.chat.id);
    }
    if (text === '❓ FAQ / Help') {
        return sendHelpMessage(msg.chat.id);
    }

    // --- 3. CONVERSATION STATE HANDLERS ---
    if (userStates[msg.chat.id] && userStates[msg.chat.id].awaiting) {
        const awaiting = userStates[msg.chat.id].awaiting;

        if (awaiting === 'amount') {
            return handleAmountInput(msg.chat.id, text);
        }

        // States requiring payment details before generating transaction
        if ([
            'wise_details', 'revolut_details', 'paypal_details', 'card_details', 
            'payeer_details', 'alipay_details', 'generic_details', 
            'bank_details_eu', 'bank_details_us'
        ].includes(awaiting)) {
            return handlePaymentDetailsInput(msg.chat.id, text, userStates[msg.chat.id]);
        }
    }
    
    // --- 4. USER SUPPORT FORWARDING (Final Catch-all) ---
    // If the message is not a command, not a menu option, and not part of an active transaction, treat it as a support query.

    // 1. Send confirmation to user
    bot.sendMessage(msg.chat.id, "Thank you for reaching out! Your support message has been forwarded to our team. We'll get back to you shortly.");

    // 2. Send header message to admin (containing the ID for reply context)
    const senderInfo = `✉️ *New Support Message* from [${msg.from.first_name}](tg://user?id=${msg.chat.id}) (Chat ID: \`${msg.chat.id}\`):`;
    await bot.sendMessage(ADMIN_CHAT_ID, senderInfo, { parse_mode: 'Markdown' });

    // 3. Forward the user's message
    await bot.forwardMessage(ADMIN_CHAT_ID, msg.chat.id, msg.message_id);

    // 4. Prompt admin to reply
    await bot.sendMessage(ADMIN_CHAT_ID, "👆 *Reply* to the message that contains the 'Chat ID' above to send your response back to the user.", { parse_mode: 'Markdown' });
});


console.log("Bot is running...");
