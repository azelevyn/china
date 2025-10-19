require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

// --- BOT AND API INITIALIZATION ---

// Check for essential environment variables
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.COINPAYMENTS_PUBLIC_KEY || !process.env.COINPAYMENTS_PRIVATE_KEY) {
    console.error("FATAL ERROR: Missing required environment variables. Please check your .env file.");
    process.exit(1);
}

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Initialize CoinPayments Client
const coinpayments = new CoinPayments({
    key: process.env.COINPAYMENTS_PUBLIC_KEY,
    secret: process.env.COINPAYMENTS_PRIVATE_KEY,
});

// --- CONSTANTS AND CONFIGURATION ---

const MERCHANT_ID = '431eb6f352649dfdcde42b2ba8d5b6d8'; // Your Merchant ID
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com'; // Your refund email
const MIN_USDT = 25;
const MAX_USDT = 50000;

// Conversion Rates
const RATES = {
    USDT_TO_USD: 1 / 1.08, // Based on USD TO USDT 1.08
    USD_TO_EUR: 0.89,
    USDT_TO_GBP: 0.77,
};

// In-memory storage for user conversation state
const userStates = {};

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


// --- BOT COMMANDS AND MESSAGE HANDLERS ---

// Handler for the /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';

    // Reset user state
    userStates[chatId] = {};

    const welcomeMessage = `Hello, *${firstName} ${lastName}*!\n\nWelcome to the USDT Seller Bot. I can help you easily sell your USDT for fiat currency (USD, EUR, GBP).\n\nReady to start?`;

    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Yes, I want to sell USDT", callback_data: 'start_sell' }],
                [{ text: "❌ No, not now", callback_data: 'cancel' }]
            ]
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

    if (data === 'start_sell') {
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
        userStates[chatId].paymentMethod = method;

        let prompt = '';
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
                prompt = 'Please provide your bank details in the following format:\n\n`Firstname Lastname, IBAN, Swift Code`';
                userStates[chatId].awaiting = 'bank_details';
                break;
            case 'skrill':
                prompt = 'Please provide your *Skrill/Neteller email*.';
                userStates[chatId].awaiting = 'skrill_details';
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
        bot.sendMessage(chatId, prompt, { parse_mode: 'Markdown' });
    }

    // Acknowledge the button press
    bot.answerCallbackQuery(callbackQuery.id);
});

// Handler for text messages (for amount and payment details)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore commands
    if (text.startsWith('/')) return;

    // Check if we are waiting for a specific input from the user
    if (userStates[chatId] && userStates[chatId].awaiting) {
        const awaiting = userStates[chatId].awaiting;

        if (awaiting === 'amount') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount < MIN_USDT || amount > MAX_USDT) {
                bot.sendMessage(chatId, `❌ Invalid amount. Please enter a number between ${MIN_USDT} and ${MAX_USDT}.`);
                return;
            }
            userStates[chatId].amount = amount;

            const fiatToReceive = calculateFiat(amount, userStates[chatId].fiat);
            const confirmationMessage = `You will receive approximately *${fiatToReceive.toFixed(2)} ${userStates[chatId].fiat}*.\n\nPlease choose your preferred payment method:`;

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
            userStates[chatId].awaiting = null; // Wait for button press now
        } else if (awaiting.endsWith('_details')) {
            userStates[chatId].paymentDetails = text;
            bot.sendMessage(chatId, "⏳ Thank you! Generating your secure deposit address, please wait...");

            // --- COINPAYMENTS API CALL ---
            try {
                // Map network to CoinPayments currency code
                const networkMap = {
                    'BEP20': 'USDT.BEP20',
                    'TRC20': 'USDT.TRC20',
                    'ERC20': 'USDT.ERC20'
                };
                const coinCurrency = networkMap[userStates[chatId].network];

                const transactionOptions = {
                    currency1: 'USDT', // The currency the user is sending
                    currency2: coinCurrency, // The currency we want to receive on the network
                    amount: userStates[chatId].amount,
                    buyer_email: BUYER_REFUND_EMAIL,
                    custom: `Payout to ${userStates[chatId].paymentMethod}: ${userStates[chatId].paymentDetails}`,
                    item_name: `Sell ${userStates[chatId].amount} USDT for ${userStates[chatId].fiat}`,
                    ipn_url: 'YOUR_IPN_WEBHOOK_URL' // Optional: for server-to-server notifications
                };

                const result = await coinpayments.createTransaction(transactionOptions);

                const depositInfo = `✅ *Deposit Address Generated!*\n\nPlease send exactly *${result.amount} USDT* (${userStates[chatId].network}) to the address below:\n\n` +
                    `\`${result.address}\`\n\n` + // Backticks for easy copying
                    `*Status URL:* [Click to Track](${result.status_url})\n\n` +
                    `⚠️ *IMPORTANT:* Send only USDT on the ${userStates[chatId].network} network to this address. Sending any other coin or using a different network may result in the loss of your funds.`;

                bot.sendMessage(chatId, depositInfo, { parse_mode: 'Markdown' });

                // Reset state after successful transaction
                delete userStates[chatId];

            } catch (error) {
                console.error("CoinPayments API Error:", error);
                bot.sendMessage(chatId, "❌ Sorry, there was an error generating your deposit address. Please try again later or contact support.");
            }
        }
    }
});


console.log("Bot is running...");
