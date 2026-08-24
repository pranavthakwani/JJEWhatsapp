import axios from 'axios';
import { env } from '../config/env.js';
import { EXTRACTION_PROMPT_VERSION, EXTRACTION_SCHEMA } from './extractionSchema.js';

const SYSTEM_INSTRUCTIONS = `You extract structured wholesale mobile-electronics intent from WhatsApp messages.
Classify buying requests as lead, explicit stock/seller messages as offering, conversational follow-ups as reply,
and unrelated or ambiguous text as ignored. Trader shorthand: WTB/REQ means buying; WTS/AVL/STOCK means selling;
DISP means dispatch. A bare product name, price-only follow-up, or quantity-only follow-up is not a new offering.
Create one item per SKU. Preserve model numbers. Never invent missing fields. Return only the required schema.`;

function outputText(response) {
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && content.text) return content.text;
    }
  }
  return null;
}

function finite(value, { integer = false, min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const normalized = integer ? Math.trunc(number) : number;
  if (min !== null && normalized < min) return null;
  if (max !== null && normalized > max) return null;
  return normalized;
}

function cleanText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
}

export function normalizeExtraction(raw) {
  const allowed = new Set(['lead', 'offering', 'ignored', 'reply', 'unknown']);
  const classification = allowed.has(raw?.classification) ? raw.classification : 'unknown';
  const items = ['lead', 'offering'].includes(classification) && Array.isArray(raw?.items)
    ? raw.items.slice(0, 100).map((item) => ({
      brand: cleanText(item?.brand, 100),
      model: cleanText(item?.model, 160),
      variant: cleanText(item?.variant, 160),
      ramGb: finite(item?.ramGb, { integer: true, min: 0, max: 1024 }),
      storageGb: finite(item?.storageGb, { integer: true, min: 0, max: 1_000_000 }),
      colors: Array.isArray(item?.colors)
        ? item.colors.slice(0, 100).map((color) => ({ name: cleanText(color?.name, 80), quantity: finite(color?.quantity, { integer: true, min: 0 }) })).filter((color) => color.name)
        : Object.entries(item?.colors && typeof item.colors === 'object' ? item.colors : {}).slice(0, 100).map(([name, quantity]) => ({ name: cleanText(name, 80), quantity: finite(quantity, { integer: true, min: 0 }) })).filter((color) => color.name),
      quantityMin: finite(item?.quantityMin, { integer: true, min: 0 }),
      quantityMax: finite(item?.quantityMax, { integer: true, min: 0 }),
      priceMin: finite(item?.priceMin, { min: 0 }),
      priceMax: finite(item?.priceMax, { min: 0 }),
      dispatchLocation: cleanText(item?.dispatchLocation, 240),
    })).filter((item) => item.brand || item.model || item.variant)
    : [];
  return {
    isBusinessMessage: Boolean(raw?.isBusinessMessage && classification !== 'ignored'),
    classification,
    actorType: ['dealer', 'distributor'].includes(raw?.actorType) ? raw.actorType : 'unknown',
    condition: ['fresh', 'used', 'unknown'].includes(raw?.condition) ? raw.condition : null,
    gstIncluded: typeof raw?.gstIncluded === 'boolean' ? raw.gstIncluded : null,
    dispatch: cleanText(raw?.dispatch, 240),
    confidence: finite(raw?.confidence, { min: 0, max: 1 }) ?? 0,
    items,
  };
}

export async function extractWholesaleIntent(message) {
  if (!env.ai.apiKey || !env.ai.model) throw new Error('AI extraction is enabled but OPENAI_API_KEY or OPENAI_MODEL is missing.');
  const sourceText = String(message?.textBody || message?.caption || '').trim().slice(0, 4000);
  if (!sourceText) return { extraction: normalizeExtraction({ classification: 'ignored' }), usage: {}, model: env.ai.model, promptVersion: EXTRACTION_PROMPT_VERSION };
  let response;
  try {
    response = await axios.post('https://api.openai.com/v1/responses', {
      model: env.ai.model,
      store: false,
      max_output_tokens: env.ai.maxOutputTokens,
      instructions: SYSTEM_INSTRUCTIONS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: sourceText }] }],
      text: { format: { type: 'json_schema', name: 'wholesale_message_extraction', strict: true, schema: EXTRACTION_SCHEMA } },
    }, {
      timeout: env.ai.timeoutMs,
      proxy: env.ai.useEnvProxy ? undefined : false,
      headers: { Authorization: `Bearer ${env.ai.apiKey}`, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const status = error?.response?.status;
    const providerError = error?.response?.data?.error;
    const details = providerError?.message || error?.message || 'Unknown provider error';
    const code = providerError?.code || providerError?.type;
    const wrapped = new Error(`OpenAI request failed${status ? ` (${status}${code ? ` ${code}` : ''})` : ''}: ${details}`);
    wrapped.code = code || error?.code || 'OPENAI_REQUEST_FAILED';
    wrapped.retryable = !(
      [401, 403].includes(status)
      || ['credit_balance_exhausted', 'insufficient_quota', 'invalid_api_key'].includes(String(code || '').toLowerCase())
    );
    throw wrapped;
  }
  const text = outputText(response.data);
  if (!text) throw new Error(`OpenAI response did not contain output text (status: ${response.data?.status || 'unknown'}).`);
  return {
    extraction: normalizeExtraction(JSON.parse(text)),
    usage: { inputTokens: response.data?.usage?.input_tokens || 0, outputTokens: response.data?.usage?.output_tokens || 0 },
    model: response.data?.model || env.ai.model,
    promptVersion: EXTRACTION_PROMPT_VERSION,
  };
}
