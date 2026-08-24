const K_PRICE_PATTERN = /(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*k\b/ig;
const FULL_PRICE_PATTERN = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{3})+|\d{4,6})(?!\s*(?:pcs?|pieces|units?|qty|quantity)\b)/ig;
const ALLOWED_FOLLOWUP_WORDS = new Set([
  'final', 'fixed', 'best', 'last', 'net', 'only', 'ok', 'okay', 'rate', 'price',
  'confirm', 'confirmed', 'pls', 'please', 'with', 'without', 'gst', 'fresh', 'used',
  'today', 'tomorrow', 'dispatch', 'checking', 'check', 'pcs', 'pc', 'pieces',
  'units', 'qty', 'quantity',
]);

function amount(value, multiplier = 1) {
  const parsed = Number.parseFloat(String(value).replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.round(parsed * multiplier);
  return normalized >= 1_000 ? normalized : null;
}

export function extractPrices(text) {
  const source = String(text || '');
  const matches = [];
  for (const [pattern, multiplier] of [[K_PRICE_PATTERN, 1_000], [FULL_PRICE_PATTERN, 1]]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const normalized = amount(match[1], multiplier);
      if (normalized) matches.push({ amount: normalized, position: match.index });
    }
  }
  return matches.sort((left, right) => left.position - right.position).map((match) => match.amount);
}

export function isLikelyPriceFollowup(text) {
  const source = String(text || '').trim();
  if (!source || extractPrices(source).length === 0) return false;
  K_PRICE_PATTERN.lastIndex = 0;
  FULL_PRICE_PATTERN.lastIndex = 0;
  const words = source
    .replace(K_PRICE_PATTERN, ' ')
    .replace(FULL_PRICE_PATTERN, ' ')
    .replace(/[₹,/@\-–—]/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z]/g, ''))
    .filter(Boolean);
  return words.every((word) => ALLOWED_FOLLOWUP_WORDS.has(word));
}
