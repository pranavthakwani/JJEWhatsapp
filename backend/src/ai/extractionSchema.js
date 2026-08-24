const nullableString = { type: ['string', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const nullableNumber = { type: ['number', 'null'] };

export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isBusinessMessage', 'classification', 'actorType', 'condition', 'gstIncluded', 'dispatch', 'confidence', 'items'],
  properties: {
    isBusinessMessage: { type: 'boolean' },
    classification: { type: 'string', enum: ['lead', 'offering', 'ignored', 'reply', 'unknown'] },
    actorType: { type: 'string', enum: ['dealer', 'distributor', 'unknown'] },
    condition: { type: ['string', 'null'], enum: ['fresh', 'used', 'unknown', null] },
    gstIncluded: { type: ['boolean', 'null'] },
    dispatch: nullableString,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    items: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['brand', 'model', 'variant', 'ramGb', 'storageGb', 'colors', 'quantityMin', 'quantityMax', 'priceMin', 'priceMax', 'dispatchLocation'],
        properties: {
          brand: nullableString,
          model: nullableString,
          variant: nullableString,
          ramGb: nullableInteger,
          storageGb: nullableInteger,
          colors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'quantity'],
              properties: { name: { type: 'string' }, quantity: nullableInteger },
            },
          },
          quantityMin: nullableInteger,
          quantityMax: nullableInteger,
          priceMin: nullableNumber,
          priceMax: nullableNumber,
          dispatchLocation: nullableString,
        },
      },
    },
  },
};

export const EXTRACTION_PROMPT_VERSION = 'wholesale-v1';
