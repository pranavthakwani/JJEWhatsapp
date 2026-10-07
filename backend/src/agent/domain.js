import { createHash } from 'node:crypto';

export const DEFAULT_POLICY = Object.freeze({ mode: 'shadow', allowlist: [], dailyBudgetUsd: 5, maxClarifications: 2, cooldownHours: 24, staleHours: 24 });
export const FIELD_NAMES = ['brand','model','variant','ramGb','storageGb','colors','quantityMin','quantityMax','priceMin','priceMax','currency','gstIncluded','condition','dispatchLocation','availability'];
export const SEND_KINDS = new Set(['clarification','verification']);
export function agentError(message, statusCode = 409, code = 'AGENT_CONFLICT') {
  return Object.assign(new Error(message), { statusCode, code });
}
export function validatePolicy(value) {
  if (!['shadow','review'].includes(value?.mode) || !Array.isArray(value.allowlist) || value.allowlist.length > 1000
    || !value.allowlist.every((id) => Number.isSafeInteger(id) && id > 0)
    || !Number.isFinite(value.dailyBudgetUsd) || value.dailyBudgetUsd < 0 || value.dailyBudgetUsd > 100
    || !Number.isInteger(value.maxClarifications) || value.maxClarifications < 0 || value.maxClarifications > 2
    || !Number.isFinite(value.cooldownHours) || value.cooldownHours < 24
    || !Number.isFinite(value.staleHours) || value.staleHours < 1 || value.staleHours > 168) {
    throw agentError('Invalid agent policy. Use shadow/review, a conversation allowlist, a $0–100 daily budget, at most two clarifications, and a minimum 24-hour cooldown.', 400);
  }
  return { ...DEFAULT_POLICY, ...value };
}
export function normalizeFields(raw = {}) {
  const result = {};
  for (const key of FIELD_NAMES) {
    let value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    if (['ramGb','storageGb','quantityMin','quantityMax','priceMin','priceMax'].includes(key)) {
      if(typeof value!=='number'&&typeof value!=='string')continue;
      value = Number(value);
      if (!Number.isFinite(value) || value < 0 || value > 1e9) continue;
      if (!key.startsWith('price')) value = Math.trunc(value);
    } else if (key === 'gstIncluded') {
      if (typeof value !== 'boolean') continue;
    } else if (key === 'colors') {
      if (!Array.isArray(value)) continue;
      value = value.slice(0,30).filter((c) => typeof c.name === 'string').map((c) => ({ name: c.name.trim().slice(0,80), quantity: Number.isInteger(c.quantity) && c.quantity >= 0 ? c.quantity : null }));
    } else {
      if (typeof value !== 'string') continue;
      value = value.trim().slice(0,key==='brand'?100:['model','variant'].includes(key)?160:240);
      if (key === 'brand') {
        const aliases = { apple:'Apple', iphone:'Apple', samsung:'Samsung', mi:'Xiaomi', redmi:'Xiaomi', xiaomi:'Xiaomi', vivo:'Vivo', oppo:'OPPO', realme:'Realme', oneplus:'OnePlus', motorola:'Motorola', moto:'Motorola' };
        value = aliases[value.toLowerCase()] || value;
      }
      if (key === 'condition' && !['fresh','used','unknown'].includes(value)) continue;
      if(key==='currency') { value=({ '₹':'INR',rs:'INR','rs.':'INR',rupees:'INR' })[value.toLowerCase()]||value.toUpperCase();if(!['INR','USD','AED','EUR','GBP'].includes(value))continue; }
      if (key === 'availability' && !['unverified','available','unavailable'].includes(value)) continue;
    }
    result[key] = value;
  }
  for (const [min,max] of [['quantityMin','quantityMax'],['priceMin','priceMax']]) {
    if (result[min] !== undefined && result[max] !== undefined && result[min] > result[max]) throw agentError(`Conflicting ${min}/${max} range.`,400);
  }
  return result;
}
export function missingFields(kind, fields) {
  const missing = [];
  if (!fields.model) missing.push('model');
  if (!(fields.quantityMin > 0 || fields.quantityMax > 0)) missing.push('quantity');
  if (kind === 'offering') {
    if (fields.priceMin === undefined && fields.priceMax === undefined) missing.push('price');
    if (!fields.availability || fields.availability === 'unverified') missing.push('availability');
  }
  return missing;
}
export function fingerprint(...values) { return createHash('sha256').update(JSON.stringify(values)).digest('hex'); }
export function supportedEvidence(field, messages) {
  const source = messages.find((message) => Number(message.message_id) === Number(field.messageId));
  const body = String(source?.text_body || source?.caption || '');
  return source?.direction === 'inbound' && field.evidence?.trim() && body.includes(field.evidence.trim()) ? source : null;
}
export function proposeChanges(existing, extracted, messages) {
  const fields = { ...(existing?.fields || {}) }, evidence = [], conflicts = [];
  const protectedFields = new Set(existing?.protectedFields || []);
  for (const item of extracted) {
    if (!FIELD_NAMES.includes(item.field) || !supportedEvidence(item,messages)) continue;
    const normalized = normalizeFields({ [item.field]: item.value });
    if (!(item.field in normalized)) continue;
    const value = normalized[item.field];
    if (!Number.isFinite(item.confidence)||item.confidence < .85||item.confidence>1) { conflicts.push({ ...item, reason:'Uncertain extraction' }); continue; }
    if (protectedFields.has(item.field) && fingerprint(fields[item.field]) !== fingerprint(value)) {
      conflicts.push({ ...item, reason:'Conflicts with a staff-confirmed field' }); continue;
    }
    if (fields[item.field] !== undefined && fingerprint(fields[item.field]) !== fingerprint(value) && ['priceMin','priceMax','quantityMin','quantityMax','availability'].includes(item.field)) {
      conflicts.push({ ...item, reason:'Commercial details changed; confirm the replacement' }); continue;
    }
    fields[item.field] = value;
    evidence.push({ ...item, value });
  }
  return { fields: normalizeFields(fields), evidence, conflicts };
}
export function matchOffering(buyer, seller, { staleHours = 24, now = Date.now() } = {}) {
  const reasons=[], missing=[];
  const token = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  if (!buyer.model || !seller.fields.model || token(buyer.model) !== token(seller.fields.model)) return null;
  reasons.push('Same model');
  for (const field of ['brand','variant','ramGb','storageGb','condition']) {
    const a=buyer[field], b=seller.fields[field];
    if (a != null && a !== 'unknown' && b != null && b !== 'unknown' && token(a)!==token(b)) return null;
    if (a != null && (b == null || b==='unknown')) missing.push(`Supplier ${field} not confirmed`);
  }
  const quantity=buyer.quantityMin || buyer.quantityMax;
  const availableQuantity=seller.fields.quantityMax ?? seller.fields.quantityMin;
  if (quantity && availableQuantity != null && availableQuantity < quantity) return null;
  if (quantity && seller.fields.quantityMin == null && seller.fields.quantityMax == null) missing.push('Supplier quantity unknown');
  if(buyer.currency&&seller.fields.currency&&buyer.currency!==seller.fields.currency)return null;
  if (buyer.priceMax != null && seller.fields.priceMin != null && buyer.currency&&buyer.currency===seller.fields.currency&&seller.fields.priceMin > buyer.priceMax) return null;
  if(seller.fields.priceMin!=null&&!seller.fields.currency)missing.push('Supplier currency unknown');
  if(buyer.priceMax!=null&&!buyer.currency)missing.push('Budget currency unknown');
  if (seller.fields.priceMin == null) missing.push('Supplier price unknown');
  const requestedColors=buyer.colors?.map(c=>token(c.name)) || [], offeredColors=seller.fields.colors?.map(c=>token(c.name)) || [];
  if(requestedColors.length && offeredColors.length && !requestedColors.some(c=>offeredColors.includes(c)))return null;
  if(requestedColors.length && !offeredColors.length)missing.push('Supplier color unknown');
  if (seller.control !== 'active' || ['closed','cancelled'].includes(seller.state) || seller.fields.availability==='unavailable') return null;
  const fresh = seller.confirmedAt && now-new Date(seller.confirmedAt).getTime() <= staleHours*3600000;
  if (!fresh) missing.push(seller.confirmedAt ? 'Availability stale' : 'Availability unverified');
  return { caseId:seller.id, caseVersion:seller.version, score:Math.max(30,100-missing.length*15), provisional:missing.length>0, reasons, uncertainty:missing };
}
export function assertSendAllowed({ action, caseRecord, conversation, policy, sendingEnabled, latestMessageId, unanswered=0, lastClarificationAt=null, now=Date.now() }) {
  if (!sendingEnabled || policy.mode!=='review' || !policy.allowlist.includes(action.conversationId)) throw agentError('Agent sending is disabled or this conversation is outside the pilot allowlist.');
  if (!SEND_KINDS.has(action.kind)) throw agentError('This action requires internal review, not a customer message.');
  if (action.status!=='approved' || !(action.approvedActor||action.approvedBy) || action.content!==action.approvedContent) throw agentError('The exact message must be approved by staff.');
  if (caseRecord.control!=='active' || ['closed','cancelled'].includes(caseRecord.state)) throw agentError('This case is paused, handed over, or closed.');
  if (action.caseVersion!==caseRecord.version || action.sourceMessageId!==latestMessageId) throw agentError('Conversation or case changed; review a new proposal.');
  if (!action.approvedAt || now-new Date(action.approvedAt).getTime()>30*60000) throw agentError('Approval expired; review again.');
  if (conversation.contactWaId!==action.recipient || conversation.contactOptInStatus==='opted_out') throw agentError('Recipient changed or opted out.');
  if ((!conversation.contactLastInboundAt || now-new Date(conversation.contactLastInboundAt).getTime()>=24*3600000) && !action.template) throw agentError('Customer-service window closed. Select an eligible approved template for separate review.',409,'CUSTOMER_WINDOW_CLOSED');
  if(action.template && conversation.contactOptInStatus!=='opted_in')throw agentError('An approved template still requires a consenting recipient.',409,'CONTACT_OPTED_OUT');
  if (unanswered>=policy.maxClarifications || (lastClarificationAt && now-new Date(lastClarificationAt).getTime()<policy.cooldownHours*3600000)) throw agentError('Follow-up limit or cooldown reached. Staff intervention required.');
}
