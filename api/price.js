const https = require('https');
 
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
      }
    };
    https.get(url, options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}
 
function extractEbaySoldPrices(html) {
  const prices = [];
 
  // eBay sold listings use specific class patterns for the sold price
  // These are the most reliable patterns from eBay's HTML structure
  const patterns = [
    // eBay's s-item__price inside sold listings
    /class="[^"]*s-item__price[^"]*"[^>]*>\s*<span[^>]*>\$([0-9,]+\.?[0-9]{0,2})<\/span>/g,
    // eBay SOLD price label pattern
    /SOLD\s*<\/span>\s*<\/div>\s*<div[^>]*>\s*\$([0-9,]+\.?[0-9]{0,2})/g,
    // eBay notranslate price spans
    /class="[^"]*notranslate[^"]*"[^>]*>\$([0-9,]+\.?[0-9]{0,2})<\/span>/g,
    // JSON-LD structured data prices
    /"price"\s*:\s*"([0-9,]+\.?[0-9]{0,2})"/g,
    // eBay item price in search results
    /\/sch\/.*?SOLD.*?\$([0-9,]+\.?[0-9]{0,2})/g,
    // Generic sold price patterns with context
    /sold.*?\$([0-9]{2,6}\.?[0-9]{0,2})/gi,
    /\$([0-9]{2,6}\.[0-9]{2})\s*(?:sold|Sale ends)/gi,
  ];
 
  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(html)) !== null) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      // Filter: must be between $5 and $500,000, and not a "junk" value
      if (val >= 5 && val <= 500000) {
        // Avoid duplicates
        if (!prices.includes(val)) {
          prices.push(val);
        }
      }
      if (prices.length >= 10) break;
    }
    if (prices.length >= 3) break;
  }
 
  return prices;
}
 
function extractPricesSmarter(html, query) {
  // First try to find the structured price data eBay embeds
  const prices = [];
  
  // Look for eBay's window.__PRELOADED_STATE__ or similar JSON blobs
  const jsonMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*({.{100,}}?);?\s*<\/script>/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      // Navigate the state tree to find prices
      const str = JSON.stringify(data);
      const priceMatches = str.match(/"price":\s*"?\$?([0-9,]+\.?[0-9]{0,2})"?/g);
      if (priceMatches) {
        priceMatches.forEach(m => {
          const val = parseFloat(m.replace(/[^0-9.]/g, ''));
          if (val >= 5 && val <= 500000 && !prices.includes(val)) {
            prices.push(val);
          }
        });
      }
    } catch(e) {}
  }
 
  if (prices.length >= 3) return prices;
 
  // Try to find prices near "Sold" text - these are the most reliable
  // Split HTML into chunks around sold indicators
  const soldChunks = [];
  const soldRegex = /(?:Sold\s+(?:for\s+)?\$|SOLD.*?\$|sold price.*?\$)([0-9,]+\.?[0-9]{0,2})/gi;
  let m;
  while ((m = soldRegex.exec(html)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val >= 5 && val <= 500000) {
      soldChunks.push(val);
    }
  }
  
  if (soldChunks.length >= 1) {
    prices.push(...soldChunks);
  }
 
  if (prices.length >= 3) return prices.slice(0, 10);
 
  // Last resort: find all prices in a reasonable range for sports cards
  // We'll use context to filter - prices near card-related keywords
  const allPrices = [];
  const priceRegex = /\$([0-9]{2,6}\.?[0-9]{0,2})/g;
  while ((m = priceRegex.exec(html)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val >= 10 && val <= 500000) {
      allPrices.push(val);
    }
  }
 
  // Filter out common non-card prices (shipping costs, fees, etc.)
  const filtered = allPrices.filter(p => 
    p !== 3.99 && p !== 4.99 && p !== 5.99 && 
    p !== 9.99 && p !== 14.99 && p !== 19.99 &&
    p % 0.99 !== 0 // Filter common retail pricing
  );
 
  return filtered.slice(0, 10);
}
 
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
 
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const { q, player, year, cardnum, grader, grade } = req.query;
 
  let searchQuery = q || '';
  if (!searchQuery && player) {
    searchQuery = player;
    if (year) searchQuery += ` ${year}`;
    if (cardnum && cardnum !== '0') searchQuery += ` ${cardnum}`;
    if (grader && grader !== 'Raw' && grader !== '0') {
      searchQuery += ` ${grader}`;
      if (grade && grade !== '0') searchQuery += ` ${grade}`;
    }
  }
 
  if (!searchQuery) {
    return res.status(400).json({ error: 'Missing ?q= parameter' });
  }
 
  const encodedQuery = encodeURIComponent(searchQuery);
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encodedQuery}&LH_Complete=1&LH_Sold=1&_sacat=212`;
 
  let prices = [];
  let rawHtmlLength = 0;
  let fetchStatus = 0;
 
  try {
    const result = await fetchUrl(url);
    fetchStatus = result.status;
    rawHtmlLength = result.body.length;
 
    if (result.status === 200) {
      // Try smart extraction first
      prices = extractPricesSmarter(result.body, searchQuery);
      
      // Fall back to pattern matching
      if (prices.length < 1) {
        prices = extractEbaySoldPrices(result.body);
      }
    }
  } catch (e) {
    return res.status(200).json({
      query: searchQuery,
      error: e.message,
      prices: [],
      average: null,
      count: 0
    });
  }
 
  const top3 = prices.slice(0, 3);
  const average = top3.length > 0
    ? Math.round((top3.reduce((a, b) => a + b, 0) / top3.length) * 100) / 100
    : null;
 
  return res.status(200).json({
    query: searchQuery,
    prices: top3,
    all_prices_found: prices,
    average,
    count: top3.length,
    source: fetchStatus === 200 ? 'ebay' : 'blocked',
    debug: {
      fetch_status: fetchStatus,
      html_length: rawHtmlLength,
    }
  });
};
