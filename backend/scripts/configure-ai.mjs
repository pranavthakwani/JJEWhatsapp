import { env } from '../src/config/env.js';

if (env.features.aiExtraction && (!env.ai.apiKey || !env.ai.model)) {
  throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL before enabling AI extraction.');
}

console.log(JSON.stringify({
  ok: true,
  enabled: env.features.aiExtraction,
  workflowTestEnabled: env.features.aiExtraction && env.features.aiWorkflowTest,
  configured: Boolean(env.ai.apiKey && env.ai.model),
  model: env.ai.model || null,
  note: 'Configuration is read from .env. Restart the API and worker after changing a toggle.',
}));
