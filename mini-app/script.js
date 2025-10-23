let tg = null;
let currentUser = null;
const API_BASE_URL = window.location.origin.replace('/mini-app', '');

// Initialize Telegram Web App
function initTelegramApp() {
    tg = window.Telegram.WebApp;
    tg.expand();
    
    // Get user data
    currentUser = tg.initDataUnsafe.user;
    
    // Set theme
    document.body.style.background = tg.themeParams.bg_color || 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    
    console.log('Telegram Web App initialized:', currentUser);
}

// Navigation between steps
function showStep(stepNumber) {
    document.querySelectorAll('.step').forEach(step => {
        step.classList.remove('active');
    });
    document.getElementById(`step${stepNumber}`).classList.add('active');
    
    if (stepNumber === 2) {
        updateTransactionSummary();
    }
}

// Update transaction summary
function updateTransactionSummary() {
    const fiatCurrency = document.getElementById('fiatCurrency').value;
    const network = document.getElementById('network').value;
    const amount = document.getElementById('amount').value;
    const paymentMethod = document.getElementById('paymentMethod').value;
    const paymentDetails = document.getElementById('paymentDetails').value;

    const rates = {
        USD: 1.09,
        EUR: 1.09,
        GBP: 0.89
    };

    const receivedAmount = (fiatCurrency === 'USD') 
        ? (amount / rates.USD).toFixed(2)
        : (amount * rates[fiatCurrency]).toFixed(2);

    const summaryHTML = `
        <div class="summary-item">
            <span class="summary-label">Sell Amount:</span>
            <span class="summary-value">${amount} USDT</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Receive Amount:</span>
            <span class="summary-value">${receivedAmount} ${fiatCurrency}</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Network:</span>
            <span class="summary-value">${network}</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Payout Method:</span>
            <span class="summary-value">${paymentMethod}</span>
        </div>
        <div class="summary-item">
            <span class="summary-label">Payment Details:</span>
            <span class="summary-value">${paymentDetails}</span>
        </div>
        <div class="rate-display" style="margin-top: 16px;">
            Exchange Rates: 1 USD = ${rates.USD} USDT | 1 USDT = ${rates.EUR} EUR | 1 USDT = ${rates.GBP} GBP
        </div>
    `;

    document.getElementById('transactionSummary').innerHTML = summaryHTML;
}

// Process transaction
async function processTransaction() {
    showStep(3);

    const transactionData = {
        amount: parseFloat(document.getElementById('amount').value),
        fiat: document.getElementById('fiatCurrency').value,
        network: document.getElementById('network').value,
        paymentMethod: document.getElementById('paymentMethod').value,
        paymentDetails: document.getElementById('paymentDetails').value
    };

    try {
        const chatId = currentUser?.id || getChatIdFromUrl();
        
        if (!chatId) {
            throw new Error('Cannot identify user. Please open from Telegram bot.');
        }

        const response = await fetch(`${API_BASE_URL}/webhook/mini-app-transaction`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chatId: chatId,
                transactionData: transactionData
            })
        });

        const result = await response.json();

        if (result.success) {
            document.getElementById('finalDepositAddress').textContent = result.depositAddress;
            document.getElementById('finalAmount').textContent = `${result.amount} USDT`;
            document.getElementById('finalNetwork').textContent = transactionData.network;
            showStep(4);
            
            // Notify Telegram app about success
            if (tg) {
                tg.HapticFeedback.impactOccurred('heavy');
            }
        } else {
            throw new Error(result.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
        showStep(1);
    }
}

// Helper function to get chat ID from URL parameters
function getChatIdFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('startapp');
}

// Close the Mini App
function closeApp() {
    if (tg) {
        tg.close();
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', function() {
    initTelegramApp();
    
    // Add real-time amount calculation
    document.getElementById('amount').addEventListener('input', function() {
        if (document.getElementById('step2').classList.contains('active')) {
            updateTransactionSummary();
        }
    });
    
    // Add input validation
    document.getElementById('amount').addEventListener('blur', function() {
        const amount = parseFloat(this.value);
        if (amount < 25) {
            this.value = 25;
        } else if (amount > 50000) {
            this.value = 50000;
        }
    });
});
