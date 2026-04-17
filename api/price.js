const https = require('https');
const http = require('http');
 
function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      }
    };
    protocol.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}
 
function extractPrices(html) {
  const prices = [];
  
  // eBay sold price patterns
  const patterns = [
    /\$([0-9,]+\.[0-9]{2})/g,
    /"price":\s*"?\$?([0-9,]+\.?[0-9]{0,2})"?/g,
    /soldPrice[^>]*>\$?([0-9,]+\.?[0-9]{0,2})/g,
    /SOLD[^$]*\$([0-9,]+\.?[0-9]{0,2})/g,
  ];
 
  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(html)) !== null) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (val >= 1 && val <= 500000) {
        prices.push(val);
      }
      if (prices.length >= 20) break;
    }
    if (prices.length >= 3) break;
  }
 
  return prices;
}
 
module.exports = async (req, res) => {
  // CORS headers so Excel VBA can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
 
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
 
  const { q, player, year, cardnum, grader, grade } = req.query;
 
  // Build search query from either raw q param or individual fields
  let searchQuery = q || '';
  if (!searchQuery && player) {
    searchQuery = player;
    if (year) searchQuery += ` ${year}`;
    if (cardnum) searchQuery += ` ${cardnum}`;
    if (grader && grader !== 'Raw') {
      searchQuery += ` ${grader}`;
      if (grade) searchQuery += ` ${grade}`;
    }
  }
 
  if (!searchQuery) {
    return res.status(400).json({ error: 'Missing search query. Use ?q=player+name+details' });
  }
 
  const encodedQuery = encodeURIComponent(searchQuery);
  
  // Try multiple sources
  const sources = [
    `https://www.ebay.com/sch/i.html?_nkw=${encodedQuery}&LH_Complete=1&LH_Sold=1&_sacat=212&LH_ItemCondition=3000`,
    `https://www.ebay.com/sch/i.html?_nkw=${encodedQuery}&LH_Sold=1&LH_Complete=1`,
  ];
 
  let allPrices = [];
  let sourceUsed = '';
 
  for (const url of sources) {
    try {
      const result = await fetchUrl(url);
      if (result.status === 200) {
        const prices = extractPrices(result.body);
        if (prices.length >= 1) {
          allPrices = prices;
          sourceUsed = 'ebay';
          break;
        }
      }
    } catch (e) {
      continue;
    }
  }
 
  if (allPrices.length === 0) {
    return res.status(200).json({
      query: searchQuery,
      prices: [],
      average: null,
      count: 0,
      message: 'No prices found. Try a more specific search query.',
      source: 'none'
    });
  }
 
  // Take up to 3 most recent prices and average them
  const top3 = allPrices.slice(0, 3);
  const average = top3.reduce((a, b) => a + b, 0) / top3.length;
 
  return res.status(200).json({
    query: searchQuery,
    prices: top3,
    average: Math.round(average * 100) / 100,
    count: top3.length,
    source: sourceUsed
  });
};
