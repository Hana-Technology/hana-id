// Names a partner label may not use besides Journear's own lists (D892 after PR 114's review): common currency and
// token names and tickers (fiat and crypto), wallets, exchanges, payment brands and banks. A first filter, not a
// guarantee: there are always more names than any list holds, and a name missing here is not thereby allowed in any
// sense that matters (piece 3 shows partner words as the partner's, never Journear's). Lower case, compared after
// folding (accents, digits for letters, i/l and u/v read as one). Everyday English words that are also tickers or
// brands (sol, dot, link, atom, wise, chase, rainbow, meta, won, rand) are left out on purpose: the
// list would refuse honest labels for little gain ("real" is a claim word); so are "coin" and "token", which an
// honest row label needs ("Token"). "Phantom" is in, as a wallet, since the review of the address book's names, as are Bitget and Wend (a
// wallet of the team's own). Pure data, no imports.

export const OTHER_NAMES: readonly string[] = Object.freeze([
  // fiat
  'usd', 'eur', 'gbp', 'jpy', 'cny', 'rmb', 'myr', 'sgd', 'idr', 'thb', 'php', 'inr', 'aud', 'cad', 'chf', 'hkd', 'krw', 'brl', 'mxn', 'ngn', 'zar',
  'dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'sterling', 'yen', 'yuan', 'renminbi', 'ringgit', 'rupee', 'rupees', 'rupiah', 'baht', 'peso',
  'pesos', 'franc', 'francs', 'reais', 'naira', 'bucks', 'quid', 'cents',
  // crypto tickers and names
  'usdt', 'tether', 'busd', 'tusd', 'pyusd', 'fdusd', 'dai', 'frax', 'lusd', 'gusd', 'usde', 'bnusd', 'soda', 'xsoda', 'stablecoin', 'stablecoins',
  'eth', 'ether', 'ethereum', 'weth', 'steth', 'btc', 'wbtc', 'bitcoin', 'satoshi', 'satoshis', 'sats', 'solana', 'xrp', 'ripple', 'doge',
  'dogecoin', 'shib', 'bnb', 'matic', 'avax', 'trx', 'tron', 'ltc', 'litecoin', 'bch', 'xmr', 'monero', 'polkadot',
  'cosmos', 'chainlink', 'aave', 'xlm', 'stellar', 'lumen', 'lumens', 'near', 'wnear', 'aurora', 'usdc', 'eurc', 'circle',
  'crypto', 'cryptocurrency',
  // wallets
  'metamask', 'trezor', 'ledger', 'coinbase', 'argent', 'exodus', 'trustwallet', 'safewallet', 'lobstr', 'freighter', 'herewallet', 'mynearwallet', 'phantom',
  'wend',
  // exchanges
  'binance', 'kraken', 'okx', 'bybit', 'kucoin', 'gemini', 'bitstamp', 'bitfinex', 'huobi', 'htx', 'gateio', 'upbit', 'bithumb', 'robinhood', 'uniswap',
  'bitget',
  // payment brands and big platforms
  'paypal', 'venmo', 'stripe', 'visa', 'mastercard', 'amex', 'americanexpress', 'applepay', 'googlepay', 'alipay', 'wechat', 'wechatpay', 'grabpay',
  'touchngo', 'shopeepay', 'revolut', 'klarna', 'zelle', 'cashapp', 'google', 'apple', 'microsoft', 'amazon', 'facebook',
  // banks
  'bank', 'banks', 'banking', 'maybank', 'cimb', 'hsbc', 'citibank', 'citi', 'jpmorgan', 'barclays', 'santander', 'dbs', 'ocbc', 'uob',
  'wellsfargo', 'bofa',
]);
