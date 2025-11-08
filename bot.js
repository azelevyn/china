require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');

// --- ENV / BOOT ---
const { TELEGRAM_BOT_TOKEN, COINPAYMENTS_PUBLIC_KEY, COINPAYMENTS_PRIVATE_KEY, ADMIN_CHAT_ID } = process.env;
if (!TELEGRAM_BOT_TOKEN || !COINPAYMENTS_PUBLIC_KEY || !COINPAYMENTS_PRIVATE_KEY || !ADMIN_CHAT_ID) {
  console.error("FATAL ERROR: Missing env. Check .env and ADMIN_CHAT_ID."); process.exit(1);
}
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const coinpayments = new CoinPayments({ key: COINPAYMENTS_PUBLIC_KEY, secret: COINPAYMENTS_PRIVATE_KEY });

bot.setMyCommands([
  { command: 'start', description: '🚀 Start' },
  { command: 'help', description: '❓ Help' },
  { command: 'find', description: '🔍 Find order' },
  { command: 'referral', description: '🤝 Referral' },
  { command: 'language', description: '🌐 Language' },
  { command: 'admin', description: '🛠 Admin' },
]);

// --- CONSTANTS / IN-MEMORY ---
const ADMIN = ADMIN_CHAT_ID;
const BUYER_REFUND_EMAIL = 'azelchillexa@gmail.com';
const MIN_USD_EQ = 25, MAX_USD_EQ = 50000;
const FIXED = { USD: 1.12, EUR: 0.98, GBP: 0.86 };          // USDT fixed quotes
const COINS = ['USDT','BTC','ETH'];
const NETS = { USDT: { TRC20: 'USDT.TRC20', ERC20: 'USDT.ERC20' }, BTC:{ MAIN:'BTC' }, ETH:{ MAIN:'ETH' } };
const REF_REWARD = 1.2, REF_MIN_WD = 50;

let orderSeq = 1000, lastMsg = {}, lastRates = null, lastRatesAt = 0;
const RATES_TTL = 60_000;

const users = {};      // chatId -> { lang, awaiting, ...flow state }
const referrals = {};  // chatId -> { referrerId,balance,referredCount,isReferralRewardClaimed }
const txs = {};        // orderNumber -> tx
const adminReplyMap = {};
const store = { nextId: 1, products: {} };

// --- I18N (compact) ---
const LANGS = [
  { code:'en', label:'🇬🇧 English' }, { code:'de', label:'🇩🇪 Deutsch' }, { code:'zh', label:'🇨🇳 中文' },
  { code:'es', label:'🇪🇸 Español' }, { code:'ru', label:'🇷🇺 Русский' }, { code:'hi', label:'🇮🇳 हिन्दी' },
];

const I18N = {
  en: {
    welcome:(n,dt)=>`Hey *${n||'there'}*! 👋\n\nSell *BTC/ETH/USDT* → receive *USD/EUR/GBP*.\n\n*Now:* _${dt}_\n\nChoose an option:`,
    btns:{ start:'✅ Start selling', store:'🛍 Digital Store', about:'ℹ️ About & Safety', help:'📖 GUIDE / FAQ', find:'🔍 Find Transaction', support:'💬 Contact Support', admin:'🛠 Admin Panel', lang:'🌐 Language', back:'🏠 Main Menu', refresh:'🔄 Refresh rates' },
    about:`🛡️ *About & Safety*\n• Non-custodial per-order address\n• Unique order number\n• Reputable rails & tools\n• Human support via /support\n• Transparent quotes with Refresh rates\n\n_Always verify coin & network before sending._`,
    guide:(min,max)=>`*1)* Start selling → pick coin & currency\n*2)* Network: USDT TRC20/ERC20; BTC/ETH mainnet\n*3)* Amount (min $${min}, max $${max})\n*4)* Payout: Wise/Rev/PayPal/Bank/Skrill/Neteller/Card/Payeer/Alipay\n*5)* Review & confirm\n*6)* Send & track with order number`,
    ratesHdr:'Rates (approx)',
    coinChosen:c=>`✅ *${c}* selected.\n\nPick payout currency:`,
    chooseNet:c=>`✅ *${c}* selected.\n\nPick network:`,
    enterAmt:(c,net,min,max)=>`✅ ${c}${net?` on *${net}*`:''}.\nEnter amount of *${c}*.\n*Min:* $${min} | *Max:* $${max}`,
    invalid:'❌ Invalid number.',
    priceNA:c=>`❌ Pricing unavailable for ${c}.`,
    oor:(amt,coin,usd,min,max)=>`❌ Amount out of range.\nYour ${amt} ${coin} ≈ $${usd}.\nAllowed: $${min}–$${max}.`,
    approx:(amt,coin,fiat,val)=>`✅ *Amount confirmed:* ${amt} ${coin}\nYou’ll receive about *${val} ${fiat}*.\n\nChoose payout method:`,
    payoutBtns:[['Wise','Revolut'],['PayPal','Bank Transfer'],['Skrill/Neteller','Visa/Mastercard'],['Payeer','Alipay']],
    prompts:{
      wise:'Share your Wise email or @tag:',
      revolut:'Share your Revolut @tag:',
      paypal:'Share your PayPal email:',
      card:'Share your Visa/Mastercard number:',
      payeer:'Share your Payeer number (e.g., P12345678):',
      alipay:'Share your Alipay email:',
      bankRegion:'Pick your bank region:',
      bankEU:'Reply:\n`First Last\nIBAN:\nSwift:`',
      bankUS:'Reply:\n`Account Name:\nAccount No:\nRouting (ACH/ABA):`',
      skrillOrNeteller:'Which one are you using?',
    },
    bankEU:'🇪🇺 European Bank', bankUS:'🇺🇸 US Bank', skrill:'Skrill', neteller:'Neteller',
    review:'📋 *TRANSACTION SUMMARY*',
    cont:'✅ Continue & Generate Address', edit:'✏️ Edit Payment Details',
    creating:'🔐 Creating a secure deposit address…',
    addr:(ord,txn,amt,coin,net,addr,pm,det)=>`✅ *Deposit Address Ready!*\n\n*Order:* #${ord}\n*Txn:* ${txn}\n\nSend *${amt} ${coin}* (${net}) to:\n\`${addr}\`\n\n⏳ Waiting for confirmations…\n\n*Payout:* ${pm}\n*Details:* \`${det}\`\n\n⚠️ Send only ${coin} on ${net}.`,
    findPrompt:'🔎 Enter your order number (e.g., ORD1000123456):',
    txFound:'🔍 *Transaction Found*',
    txNA:o=>`❌ No transaction *${o}* found.`,
    support:'💬 Tell us your issue in one message. A human will reply here.',
    thanks:'✅ Thanks! Your message is with support.',
    startOver:'Restart with /start when you’re ready.',
    adminOnly:'🚫 Admins only.',
    admin:(u,t,p)=>`🛠 *Admin Panel*\n• Users: *${u}*\n• Tx: *${t}*\n• Pending: *${p}*`,
    adminBtns:{ refresh:'📊 Refresh Stats', recent:'🧾 Recent Transactions', find:'🔎 Find / Update Order', store:'🛍 Store: Manage', bc:'📣 Broadcast', back:'⬅️ Back' },
    adminRecent:'🧾 *Recent Transactions (last 5)*',
    adminFind:'🔎 Send order number (e.g., ORD1000123456).',
    orderCard:t=>`📦 *Order:* #${t.orderNumber}\n*Status:* ${t.status}\n*User:* \`${t.userId}\`\n*${t.coin}/${t.network}* • ${t.amount}\n*Payout:* ${t.fiat} via ${t.paymentMethod}\n*Details:* \`${t.paymentDetails}\`\n*Txn:* ${t.coinpaymentsTxnId}\n*Deposit:* \`${t.depositAddress}\`\n*Date:* ${new Date(t.timestamp).toLocaleString()}`,
    mark:{ paid:'✅ Mark Paid', done:'🎉 Mark Completed', cancel:'🛑 Cancel' },
    storeTitle:c=>`🛍 *Digital Store*\n\nProducts: ${c}`,
    browse:'📦 Browse Products', products:'📦 *Products*', prodNA:'❌ Product not found.',
    langTitle:'🌐 *Language*\n\nChoose your language:', langSet:l=>`✅ Language set to *${l}*.`,
  }
};
// Minimal non-English overrides (fallback to English for missing keys)
['de','zh','es','ru','hi'].forEach(c=>I18N[c]=Object.assign({},I18N.en));

// --- TINY HELPERS ---
const nowStr = () => {
  const d = new Date();
  return `${d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})} - ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}`;
};
const oid = () => `ORD${orderSeq++}${Date.now().toString().slice(-6)}`;
const isAdmin = id => id.toString()===ADMIN.toString();
const U = id => users[id] ||= { lang:'en' };
const T = (id,key,...a)=>{ const L=I18N[U(id).lang]||I18N.en; const v=L[key]??I18N.en[key]; return typeof v==='function'?v(...a):v; };
const msgOpts = (extra={})=>({ parse_mode:'Markdown', ...extra });

async function sendOrEdit(chatId, text, options={}) {
  try {
    if (lastMsg[chatId]) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: lastMsg[chatId], ...msgOpts(options) });
    } else {
      const s = await bot.sendMessage(chatId, text, msgOpts(options)); lastMsg[chatId]=s.message_id;
    }
  } catch (e) {
    const s = await bot.sendMessage(chatId, text, msgOpts(options)); lastMsg[chatId]=s.message_id;
  }
}
const clearPane = id => delete lastMsg[id];

// --- REFERRALS / USERS ---
function initReferral(id){ referrals[id] ||= { referrerId:null, balance:0, referredCount:0, isReferralRewardClaimed:false }; }
function rewardReferrer(ref, child){
  if (!referrals[ref]) return;
  referrals[ref].balance += REF_REWARD; referrals[ref].referredCount++;
  bot.sendMessage(ref, `🎉 *Referral Reward:* +${REF_REWARD.toFixed(1)} USDT from \`${child}\`. Balance: *${referrals[ref].balance.toFixed(2)} USDT*.`, msgOpts());
}
function notifyAdminNewUser(id, info, ref=null){
  bot.sendMessage(ADMIN, `🆕 *NEW USER*\n\n*ID:* \`${id}\`\n*Info:* ${info}\n*Joined:* ${nowStr()}${ref?`\n*Referred by:* \`${ref}\``:''}\n\nUsers: ${Object.keys(referrals).length}`, msgOpts());
}

// --- STORE (catalog) ---
const listProducts = () => {
  const ids = Object.keys(store.products); if (!ids.length) return '_No products yet._';
  return ids.map(pid => {
    const p = store.products[pid]; return `#${p.id} — *${p.name}* • ${p.priceUSDT} USDT • Stock: ${p.payloads.length}`;
  }).join('\n');
};

// --- RATES / PRICING ---
async function fetchRates() {
  const now = Date.now();
  if (lastRates && now-lastRatesAt<RATES_TTL) return lastRates;

  const raw = await coinpayments.rates({ short:1 });
  const rb = k => raw[k]?.rate_btc ? +raw[k].rate_btc : null;
  const usd=rb('USD'), eur=rb('EUR'), gbp=rb('GBP'); if(!usd||!eur||!gbp) throw new Error('Missing fiat anchors');

  const price = (sym, anchor)=> (raw[sym]?.rate_btc ? (+raw[sym].rate_btc)/anchor : null);
  const res = {
    USD:{ BTC:price('BTC',usd), ETH:price('ETH',usd), USDT:FIXED.USD },
    EUR:{ BTC:price('BTC',eur), ETH:price('ETH',eur), USDT:FIXED.EUR },
    GBP:{ BTC:price('BTC',gbp), ETH:price('ETH',gbp), USDT:FIXED.GBP },
  };
  lastRates=res; lastRatesAt=now; return res;
}
async function fiatValue(coin, amt, fiat){
  if (coin==='USDT') return amt*FIXED[fiat];
  const r = await fetchRates(); const px = r[fiat]?.[coin]; return px?amt*px:0;
}

// --- RENDER ---
async function mainMenu(id){
  const L = T(id,'btns');
  await sendOrEdit(id, T(id,'welcome', U(id).firstName||'', nowStr()), {
    reply_markup:{ inline_keyboard:[
      [{ text:L.start, callback_data:'sell' }],
      [{ text:'🛍 Digital Store', callback_data:'store' }, { text:L.lang, callback_data:'lang' }],
      [{ text:L.about, callback_data:'about' }, { text:L.help, callback_data:'help' }],
      [{ text:L.find, callback_data:'find' }],
      [{ text:L.support, callback_data:'support' }],
      [{ text:L.admin, callback_data:'admin' }],
    ] }
  });
}
const backBtn = id => [[{ text:T(id,'btns').back, callback_data:'menu' }]];

// --- START / COMMANDS ---
bot.onText(/\/start\s?(\d+)?/, async (m,match)=>{
  const id=m.chat.id; const ref=match?.[1]; clearPane(id);
  const first = m.from.first_name||''; const last=m.from.last_name||''; const usern=m.from.username?`@${m.from.username}`:'N/A';
  const newUser = !referrals[id]; initReferral(id); U(id).firstName=first; U(id).lang=U(id).lang||'en';
  if (ref && ref!==id.toString() && referrals[ref] && !referrals[id].referrerId) { referrals[id].referrerId=ref; bot.sendMessage(id, `🤝 Referrer: \`${ref}\` — they’ll be rewarded after your first transaction.`, msgOpts()); }
  if (newUser) notifyAdminNewUser(id, `${first} ${last} (${usern})`, ref);
  mainMenu(id);
});
bot.onText(/\/help/, m=>sendOrEdit(m.chat.id, `*${T(m.chat.id,'btns').help}*\n\n${I18N[U(m.chat.id).lang].guide?.(MIN_USD_EQ,MAX_USD_EQ) || I18N.en.guide(MIN_USD_EQ,MAX_USD_EQ)}\n\n${T(m.chat.id,'about')}`, { reply_markup:{ inline_keyboard:backBtn(m.chat.id) } }));
bot.onText(/\/find/, m=>sendOrEdit(m.chat.id, T(m.chat.id,'findPrompt'), { reply_markup:{ inline_keyboard:backBtn(m.chat.id) }, ...(U(m.chat.id).awaiting={...U(m.chat.id), awaiting:'find'}) }));
bot.onText(/\/support/, m=>{ if(U(m.chat.id).awaiting) return sendOrEdit(m.chat.id,"⚠️ Finish current transaction or /start, then contact support.",{ reply_markup:{ inline_keyboard:backBtn(m.chat.id) }});
  U(m.chat.id).awaiting='support'; sendOrEdit(m.chat.id, T(m.chat.id,'support'), { reply_markup:{ inline_keyboard:backBtn(m.chat.id) } }); });
bot.onText(/\/admin/, m=>renderAdmin(m.chat.id));
bot.onText(/\/language/, m=>renderLang(m.chat.id));

bot.onText(/\/referral/, async m=>{
  const id=m.chat.id; initReferral(id);
  let botUser='Crypto_Seller_Bot'; try{ botUser=(await bot.getMe()).username; }catch{}
  const r=referrals[id]; const link=`https://t.me/${botUser}?start=${id}`;
  const ready=r.balance>=REF_MIN_WD;
  const msg=`*🤝 Referral Program*\n\n• *Your ID:* \`${id}\`\n• *Your Link:* \`${link}\`\n\n• *Balance:* *${r.balance.toFixed(2)} USDT*\n• *Referrals:* *${r.referredCount}*\n• *Per Referral:* *${REF_REWARD.toFixed(1)} USDT*\n\n*Withdrawal Min:* ${REF_MIN_WD} USDT\n${ready?"🎉 Ready to withdraw (contact support).":`Need *${(REF_MIN_WD-r.balance).toFixed(2)} USDT* more.`}`;
  sendOrEdit(id, msg, { reply_markup:{ inline_keyboard:backBtn(id) } });
});

// --- ADMIN UI (compact) ---
async function renderAdmin(id){
  if(!isAdmin(id)) return sendOrEdit(id, T(id,'adminOnly'), { reply_markup:{ inline_keyboard:backBtn(id) } });
  const L=T(id,'adminBtns'), P=Object.values(txs).filter(t=>t.status==='pending').length;
  await sendOrEdit(id, T(id,'admin')(Object.keys(referrals).length, Object.keys(txs).length, P), {
    reply_markup:{ inline_keyboard:[
      [{ text:L.refresh, callback_data:'admin' }],
      [{ text:L.recent, callback_data:'a_recent' }],
      [{ text:L.find, callback_data:'a_find' }],
      [{ text:L.store, callback_data:'a_store' }],
      [{ text:L.bc, callback_data:'a_bc' }],
      [{ text:L.back, callback_data:'menu' }],
    ] }
  });
}
const recentTx = (n=5)=> {
  const list=Object.values(txs).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,n);
  return list.length? list.map(t=>`#${t.orderNumber} • ${t.coin}/${t.network} • ${t.amount} • ${t.fiat} • *${t.status}*\nID: \`${t.coinpaymentsTxnId}\` • ${new Date(t.timestamp).toLocaleString()}`).join('\n\n') : '_No transactions yet._';
};

// --- STORE UI (compact) ---
async function renderStore(id){
  await sendOrEdit(id, T(id,'storeTitle')(Object.keys(store.products).length), {
    reply_markup:{ inline_keyboard:[
      [{ text:T(id,'browse'), callback_data:'s_browse' }],
      ...backBtn(id)
    ] }
  });
}
async function renderBrowse(id){
  const rows = Object.values(store.products).map(p=>[{ text:`${p.name} — ${p.priceUSDT} USDT`, callback_data:`s_view_${p.id}` }]);
  await sendOrEdit(id, `${T(id,'products')}\n\n${listProducts()}`, { reply_markup:{ inline_keyboard:[...rows, ...backBtn(id)] } });
}

// --- LANG UI ---
async function renderLang(id){
  const rows = [...LANGS].filter(l=>l.code!==U(id).lang).map(l=>[{ text:l.label, callback_data:`lang_${l.code}` }]);
  await sendOrEdit(id, T(id,'langTitle'), { reply_markup:{ inline_keyboard:[...rows, ...backBtn(id)] } });
}

// --- SELL FLOW HELPERS ---
async function startSell(id){
  let prices;
  try {
    const r=await fetchRates();
    prices=`*${T(id,'ratesHdr')}*\n• 1 BTC ≈ $${(r.USD.BTC??0).toFixed(2)}\n• 1 ETH ≈ $${(r.USD.ETH??0).toFixed(2)}\n• 1 USDT = $${FIXED.USD.toFixed(2)} *(fixed)*\n• 1 USDT = €${FIXED.EUR.toFixed(2)} *(fixed)*\n• 1 USDT = £${FIXED.GBP.toFixed(2)} *(fixed)*`;
  } catch {
    prices=`_Live BTC/ETH unavailable._\n• 1 USDT = $${FIXED.USD.toFixed(2)} *(fixed)*\n• 1 USDT = €${FIXED.EUR.toFixed(2)} *(fixed)*\n• 1 USDT = £${FIXED.GBP.toFixed(2)} *(fixed)*`;
  }
  await sendOrEdit(id, `What are you selling today? 😊\n\n${prices}`, {
    reply_markup:{ inline_keyboard:[
      [{ text:"₿ BTC", callback_data:'c_BTC' }, { text:"Ξ ETH", callback_data:'c_ETH' }],
      [{ text:"💎 USDT", callback_data:'c_USDT' }],
      [{ text:T(id,'btns').refresh, callback_data:'sell' }],
      ...backBtn(id)
    ] }
  });
}
async function promptAmount(id, coin, net=null){
  U(id).awaiting='amt'; U(id).coin=coin; if(net) U(id).network=net;
  await sendOrEdit(id, T(id,'enterAmt')(coin, net, MIN_USD_EQ, MAX_USD_EQ), { reply_markup:{ inline_keyboard:backBtn(id) } });
}
async function reviewAndConfirm(id){
  const s=U(id); const orderTmp=oid();
  const val = await fiatValue(s.coin||'USDT', s.amount, s.fiat);
  const r = `${T(id,'review')}\n\n*Order:* #${orderTmp}\n\n*Selling:* ${s.amount} ${s.coin}\n*Network:* ${s.network}\n*Receive:* ${val.toFixed(2)} ${s.fiat}\n*Payout:* ${s.paymentMethod}\n*Details:*\n\`${s.paymentDetails}\``;
  await sendOrEdit(id, r, { reply_markup:{ inline_keyboard:[
    [{ text:T(id,'cont'), callback_data:'confirm' }],
    [{ text:T(id,'edit'), callback_data:'edit' }],
    ...backBtn(id)
  ] } });
}
async function createAddress(id){
  const s=U(id);
  try{
    const coin=s.coin||'USDT', net=s.network||'MAIN';
    const cpCur = coin==='USDT'? NETS.USDT[net] : NETS[coin].MAIN;
    const order = oid();
    const result = await coinpayments.createTransaction({
      currency1: coin, currency2: cpCur, amount: s.amount, buyer_email: BUYER_REFUND_EMAIL,
      custom: `Order:${order} | ${coin}/${net} | Payout ${s.paymentMethod}: ${s.paymentDetails}`,
      item_name:`Sell ${s.amount} ${coin} for ${s.fiat}`, ipn_url:'YOUR_IPN_WEBHOOK_URL'
    });
    txs[order]={ userId:id, amount:s.amount, fiat:s.fiat, network:net, coin, paymentMethod:s.paymentMethod, paymentDetails:s.paymentDetails, coinpaymentsTxnId:result.txn_id, depositAddress:result.address, timestamp:new Date().toISOString(), orderNumber:order, status:'pending' };

    const ref=referrals[id]?.referrerId; if(ref && !referrals[id].isReferralRewardClaimed){ rewardReferrer(ref,id); referrals[id].isReferralRewardClaimed=true; }

    await sendOrEdit(id, T(id,'addr')(order,result.txn_id,result.amount,coin,net,result.address,s.paymentMethod,s.paymentDetails), { reply_markup:{ inline_keyboard:backBtn(id) } });
    users[id]={ lang:U(id).lang, firstName:U(id).firstName }; // reset flow but keep lang/name
  }catch(e){
    console.error('CoinPayments Error:',e);
    await sendOrEdit(id,"❌ Error creating deposit address. Try again or /support.",{ reply_markup:{ inline_keyboard:backBtn(id) } });
  }
}

// --- CALLBACKS ---
bot.on('callback_query', async cq=>{
  const id = cq.message.chat.id; const d = cq.data; U(id); initReferral(id);
  const done=()=>bot.answerCallbackQuery(cq.id).catch(()=>{});
  try{
    if(d==='menu') return mainMenu(id);
    if(d==='about') return sendOrEdit(id, I18N[U(id).lang].about, { reply_markup:{ inline_keyboard:backBtn(id) } });
    if(d==='help')  return bot.emit('text', { chat:{id}, text:'/help' }); // reuse
    if(d==='find')  return sendOrEdit(id, T(id,'findPrompt'), { reply_markup:{ inline_keyboard:backBtn(id) } , ...(U(id).awaiting='find')});
    if(d==='support') return bot.emit('text', { chat:{id}, text:'/support' });

    if(d==='lang') return renderLang(id);
    if(d.startsWith('lang_')){ const code=d.split('_')[1]; const L=LANGS.find(x=>x.code===code); if(L){ U(id).lang=code; await sendOrEdit(id, T(id,'langSet')(L.label), { reply_markup:{ inline_keyboard:backBtn(id) } }); } }

    if(d==='store') return renderStore(id);
    if(d==='s_browse') return renderBrowse(id);
    if(d.startsWith('s_view_')){ const pid=+d.split('_')[2]; const p=store.products[pid]; return sendOrEdit(id, p?`🧩 *${p.name}*\n\nPrice: *${p.priceUSDT} USDT*\nStock: ${p.payloads.length}`:T(id,'prodNA'), { reply_markup:{ inline_keyboard:[[{ text:T(id,'browse'), callback_data:'s_browse' }], ...backBtn(id)] } }); }

    if(d==='admin'||d==='admin_stats') return renderAdmin(id);
    if(d==='a_recent') return sendOrEdit(id, `${T(id,'adminRecent')}\n\n${recentTx(5)}`, { reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'admin' }]] } });
    if(d==='a_find'){ U(id).awaiting='a_find'; return sendOrEdit(id, T(id,'adminFind'), { reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'admin' }]] } }); }
    if(d.startsWith('a_mark:')){
      if(!isAdmin(id)) return;
      const [_,status,order]=d.split(':'); if(!txs[order]) return;
      txs[order].status=status; try{ await bot.sendMessage(txs[order].userId, `🔔 *Order Update*\n\n*Order:* #${order}\n*Status:* ${status}`, msgOpts()); }catch{}
      return sendOrEdit(id, T(id,'orderCard')(txs[order]), { reply_markup:{ inline_keyboard:[
        [{ text:T(id,'mark').paid, callback_data:`a_mark:paid:${order}` }, { text:T(id,'mark').done, callback_data:`a_mark:completed:${order}` }],
        [{ text:T(id,'mark').cancel, callback_data:`a_mark:canceled:${order}` }],
        [{ text:T(id,'adminBtns').back, callback_data:'admin' }]
      ] } });
    }
    if(d==='sell' || d==='refresh_rates') return startSell(id);

    if(d.startsWith('c_')){ U(id).coin=d.split('_')[1]; return sendOrEdit(id, T(id,'coinChosen')(U(id).coin), { reply_markup:{ inline_keyboard:[
      [{ text:"🇺🇸 USD", callback_data:'f_USD' }, { text:"🇪🇺 EUR", callback_data:'f_EUR' }, { text:"🇬🇧 GBP", callback_data:'f_GBP' }],
      ...backBtn(id)
    ] } }); }

    if(d.startsWith('f_')){
      U(id).fiat=d.split('_')[1];
      const c=U(id).coin||'USDT';
      if(c==='USDT') return sendOrEdit(id, T(id,'chooseNet')(c), { reply_markup:{ inline_keyboard:[
        [{ text:"TRC20 (Tron)", callback_data:'n_TRC20' }],[{ text:"ERC20 (Ethereum)", callback_data:'n_ERC20' }], ...backBtn(id)
      ] } });
      U(id).network='MAIN'; return promptAmount(id,c);
    }
    if(d.startsWith('n_')){ U(id).network=d.split('_')[1]; return promptAmount(id,'USDT',U(id).network); }

    if(d.startsWith('pay_')){
      const k=d.split('_')[1]; const P=I18N[U(id).lang].prompts;
      const map={ wise:P.wise, revolut:P.revolut, paypal:P.paypal, bank:P.bankRegion, skrill:P.skrillOrNeteller, card:P.card, payeer:P.payeer, alipay:P.alipay };
      if(k==='bank') return sendOrEdit(id, P.bankRegion, { reply_markup:{ inline_keyboard:[
        [{ text:I18N.en.bankEU, callback_data:'bank_eu' }],[{ text:I18N.en.bankUS, callback_data:'bank_us' }], ...backBtn(id)
      ] } });
      if(k==='skrill') return sendOrEdit(id, P.skrillOrNeteller, { reply_markup:{ inline_keyboard:[
        [{ text:I18N.en.skrill, callback_data:'p_skrill' }],[{ text:I18N.en.neteller, callback_data:'p_neteller' }], ...backBtn(id)
      ] } });
      U(id).paymentMethod=k.charAt(0).toUpperCase()+k.slice(1);
      U(id).awaiting=`details_${k}`;
      return sendOrEdit(id, map[k], { reply_markup:{ inline_keyboard:backBtn(id) } });
    }
    if(d.startsWith('p_')){
      const name=d.split('_')[1]; U(id).paymentMethod=name.charAt(0).toUpperCase()+name.slice(1);
      U(id).awaiting='details_skrillneteller';
      return sendOrEdit(id, `Share your *${U(id).paymentMethod}* email:`, { reply_markup:{ inline_keyboard:backBtn(id) } });
    }
    if(d==='bank_eu'){ U(id).paymentMethod='Bank Transfer (EU)'; U(id).awaiting='details_bank_eu'; return sendOrEdit(id, I18N.en.prompts.bankEU, { reply_markup:{ inline_keyboard:backBtn(id) } }); }
    if(d==='bank_us'){ U(id).paymentMethod='Bank Transfer (US)'; U(id).awaiting='details_bank_us'; return sendOrEdit(id, I18N.en.prompts.bankUS, { reply_markup:{ inline_keyboard:backBtn(id) } }); }

    if(d==='confirm'){ await sendOrEdit(id, T(id,'creating'), { reply_markup:{ inline_keyboard:backBtn(id) } }); return createAddress(id); }
    if(d==='edit'){ users[id]={ lang:U(id).lang, firstName:U(id).firstName }; return sendOrEdit(id, T(id,'startOver'), { reply_markup:{ inline_keyboard:backBtn(id) } }); }
  } finally { done(); }
});

// --- MESSAGES ---
bot.on('message', async m=>{
  const id=m.chat.id, text=m.text||''; const st=U(id); initReferral(id);
  if (text.startsWith('/')) return;

  // Admin reply to support thread
  if (m.reply_to_message && isAdmin(id)) {
    const fwdId=m.reply_to_message.message_id, uid=adminReplyMap[fwdId];
    if (uid) { try{ await bot.sendMessage(uid, `📢 *Support Reply*\n\n${text}`, msgOpts()); await bot.sendMessage(id,"✅ Reply sent."); delete adminReplyMap[fwdId]; }catch{ await bot.sendMessage(id,"❌ Couldn’t deliver reply."); } }
    else bot.sendMessage(id,"Hmm, can’t match that reply.");
    return;
  }

  // Support message from user
  if (st.awaiting==='support') {
    const info=`User ID: ${m.from.id}, Name: ${m.from.first_name||''} ${m.from.last_name||''}, Username: @${m.from.username||'N/A'}`;
    const payload=`*🚨 NEW SUPPORT REQUEST*\n\nFrom: ${info}\n\n*Message:*\n${text}\n\n— Reply to this message to respond —`;
    try{ const sent=await bot.sendMessage(ADMIN, payload, msgOpts()); adminReplyMap[sent.message_id]=id; await sendOrEdit(id, T(id,'thanks'), { reply_markup:{ inline_keyboard:backBtn(id) } }); users[id]={ lang:st.lang, firstName:st.firstName }; } 
    catch{ await sendOrEdit(id, "❌ Couldn’t reach support. Try later.", { reply_markup:{ inline_keyboard:backBtn(id) } }); }
    return;
  }

  // Admin — broadcast text
  if (st.awaiting==='a_bc' && isAdmin(id)) {
    const rcpts=Object.keys(referrals); let ok=0,fail=0; for(const uid of rcpts){ try{ await bot.sendMessage(uid, `📣 *Announcement*\n\n${text}`, msgOpts()); ok++; }catch{ fail++; } }
    users[id].awaiting=null; return sendOrEdit(id, `✅ Broadcast done. Sent: *${ok}* | Failed: *${fail}*`, { reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'admin' }]] } });
  }

  // Admin — find order input
  if (st.awaiting==='a_find' && isAdmin(id)) { users[id].awaiting=null; const o=text.trim().toUpperCase();
    const t=txs[o]; if(!t) return sendOrEdit(id, `❌ Order *${o}* not found.`, { reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').find, callback_data:'a_find' }],[{ text:T(id,'adminBtns').back, callback_data:'admin' }]] } });
    return sendOrEdit(id, T(id,'orderCard')(t), { reply_markup:{ inline_keyboard:[
      [{ text:T(id,'mark').paid, callback_data:`a_mark:paid:${t.orderNumber}` },{ text:T(id,'mark').done, callback_data:`a_mark:completed:${t.orderNumber}` }],
      [{ text:T(id,'mark').cancel, callback_data:`a_mark:canceled:${t.orderNumber}` }],
      [{ text:T(id,'adminBtns').back, callback_data:'admin' }]
    ] } });
  }

  // User — find order
  if (st.awaiting==='find') {
    const ord=text.trim().toUpperCase(), t=txs[ord]; users[id].awaiting=null;
    if (t) return sendOrEdit(id, `${T(id,'txFound')}\n\n*Order:* #${t.orderNumber}\n*Txn:* ${t.coinpaymentsTxnId}\n*Coin:* ${t.coin}\n*Amount:* ${t.amount} ${t.coin}\n*Network:* ${t.network}\n*Currency:* ${t.fiat}\n*Method:* ${t.paymentMethod}\n*Status:* ${t.status}\n*Date:* ${new Date(t.timestamp).toLocaleString()}\n*Deposit:* \`${t.depositAddress}\``, { reply_markup:{ inline_keyboard:backBtn(id) } });
    return sendOrEdit(id, T(id,'txNA')(ord), { reply_markup:{ inline_keyboard:[[ { text:'🔄 Try Again', callback_data:'find' } ], ...backBtn(id)] } });
  }

  // Selling — amount
  if (st.awaiting==='amt'){
    const amt=+text; if(!(amt>0)) return sendOrEdit(id, T(id,'invalid'), { reply_markup:{ inline_keyboard:backBtn(id) } });
    const coin=st.coin||'USDT';
    let usd=0; try{ usd = coin==='USDT'? amt*FIXED.USD : (await fetchRates()).USD[coin]*amt; }catch{}
    if(!usd) return sendOrEdit(id, T(id,'priceNA')(coin), { reply_markup:{ inline_keyboard:backBtn(id) } });
    if(usd<MIN_USD_EQ || usd>MAX_USD_EQ) return sendOrEdit(id, T(id,'oor')(amt,coin,usd.toFixed(2),MIN_USD_EQ,MAX_USD_EQ), { reply_markup:{ inline_keyboard:backBtn(id) } });
    st.amount=amt;
    const val = await fiatValue(coin, amt, st.fiat||'USD');
    await sendOrEdit(id, T(id,'approx')(amt,coin,st.fiat,val.toFixed(2)), { reply_markup:{ inline_keyboard:[
      [{ text:"Wise", callback_data:'pay_wise' },{ text:"Revolut", callback_data:'pay_revolut' }],
      [{ text:"PayPal", callback_data:'pay_paypal' },{ text:"Bank Transfer", callback_data:'pay_bank' }],
      [{ text:"Skrill/Neteller", callback_data:'pay_skrill' },{ text:"Visa/Mastercard", callback_data:'pay_card' }],
      [{ text:"Payeer", callback_data:'pay_payeer' },{ text:"Alipay", callback_data:'pay_alipay' }],
      ...backBtn(id)
    ] } });
    users[id].awaiting=null; return;
  }

  // Collect payout details → review
  const detailKeys=['details_wise','details_revolut','details_paypal','details_card','details_payeer','details_alipay','details_skrillneteller','details_bank_eu','details_bank_us'];
  if (detailKeys.includes(st.awaiting)) {
    st.paymentDetails=text; st.awaiting=null; return reviewAndConfirm(id);
  }
});

// --- ADMIN ACTIONS (broadcast / store manage minimal endpoints) ---
bot.on('callback_query', async cq=>{
  const id=cq.message.chat.id, d=cq.data; if(d!=='a_store'&&d!=='a_bc') return;
  if(!isAdmin(id)) return;
  if(d==='a_bc'){ U(id).awaiting='a_bc'; return sendOrEdit(id, "Send the *broadcast message* now.", { reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'admin' }]] } }); }
  if(d==='a_store'){
    const lines=listProducts();
    await sendOrEdit(id, `🛍 *Store Manager*\n\n${lines}`, { reply_markup:{ inline_keyboard:[
      [{ text:'➕ Add Product', callback_data:'sm_add' }],
      [{ text:'📦 Add Stock', callback_data:'sm_stock' }],
      [{ text:'🗑 Remove Product', callback_data:'sm_rm' }],
      [{ text:T(id,'adminBtns').back, callback_data:'admin' }]
    ] } });
  }
});
bot.on('callback_query', async cq=>{
  const id=cq.message.chat.id, d=cq.data;
  if(!d.startsWith('sm_')) return;
  const setAwait = k=>{ U(id).awaiting=k; sendOrEdit(id, ({
    sm_add:'Send:\n`Name: Example\nPriceUSDT: 9.99`',
    sm_stock:'Send:\n`ProductID: 1\nPayloads:\nCODE-1\nCODE-2\nhttps://link/file.zip`',
    sm_rm:'Send: `ProductID: <id>`'
  })[d], { reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'a_store' }]] } }); };
  setAwait(d);
});
bot.on('message', async m=>{
  const id=m.chat.id, text=m.text||''; const st=U(id);
  if(!isAdmin(id)) return; // store admin below only for admins
  if(st.awaiting==='sm_add'){
    const name = (text.match(/Name:\s*(.+)/i)||[])[1];
    const price = +(text.match(/PriceUSDT:\s*([0-9.]+)/i)||[])[1];
    if(!name||!price) return sendOrEdit(id,'❌ Parse error. Follow the template.',{ reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'a_store' }]] } });
    const pid=store.nextId++; store.products[pid]={ id:pid, name, priceUSDT:price, payloads:[], createdAt:new Date().toISOString() };
    st.awaiting=null; return sendOrEdit(id, `✅ Added product #${pid}: *${name}* — ${price} USDT`, { reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'a_store' }]] } });
  }
  if(st.awaiting==='sm_stock'){
    const pid=+(text.match(/ProductID:\s*(\d+)/i)||[])[1];
    const payloads=(text.split('Payloads:')[1]||'').trim().split('\n').filter(Boolean);
    if(!pid||!store.products[pid]||!payloads.length) return sendOrEdit(id,'❌ Parse error. Follow the template.',{ reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'a_store' }]] } });
    store.products[pid].payloads.push(...payloads);
    st.awaiting=null; return sendOrEdit(id, `✅ Added *${payloads.length}* payload(s) to product #${pid}.`, { reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'a_store' }]] } });
  }
  if(st.awaiting==='sm_rm'){
    const pid=+(text.match(/ProductID:\s*(\d+)/i)||[])[1];
    if(!pid||!store.products[pid]) return sendOrEdit(id,'❌ Parse error. Follow the template.',{ reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'a_store' }]] } });
    delete store.products[pid]; st.awaiting=null;
    return sendOrEdit(id, `🗑 Removed product #${pid}.`, { reply_markup:{ inline_keyboard:[[{ text:T(id,'adminBtns').back, callback_data:'a_store' }]] } });
  }
});

// --- LOG ---
console.log('Bot is running…');
