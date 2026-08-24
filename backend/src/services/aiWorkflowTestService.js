import crypto from 'node:crypto';
import { getDefaultBusinessNumber } from '../repositories/businessRepository.js';
import { getAiWorkflowTestStatus } from '../repositories/aiWorkflowTestRepository.js';
import { isAiExtractionEnabled } from '../repositories/jobRepository.js';
import { handleMetaWebhook } from './webhookService.js';
import { env } from '../config/env.js';

export async function startAiWorkflowTest({ text, io }) {
  const sourceText = String(text || '').trim();
  if (sourceText.length < 10 || sourceText.length > 4000) {
    const error = new Error('Test message must contain between 10 and 4,000 characters.');
    error.statusCode = 400;
    error.code = 'INVALID_WORKFLOW_TEST_MESSAGE';
    throw error;
  }
  if (!(await isAiExtractionEnabled()) || !env.ai.apiKey || !env.ai.model) {
    const error = new Error('AI extraction must be enabled and configured before running this test.');
    error.statusCode = 409;
    error.code = 'AI_EXTRACTION_UNAVAILABLE';
    throw error;
  }

  const number = await getDefaultBusinessNumber();
  if (!number?.phoneNumberId) {
    const error = new Error('No active WhatsApp business number is configured.');
    error.statusCode = 409;
    error.code = 'NO_ACTIVE_WHATSAPP_NUMBER';
    throw error;
  }

  const testId = `workflow-test-${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: number.wabaId || 'workflow-test',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: number.phoneNumber, phone_number_id: number.phoneNumberId },
          contacts: [{ profile: { name: 'AI Workflow Test' }, wa_id: '999000000001' }],
          messages: [{ from: '999000000001', id: testId, timestamp, type: 'text', text: { body: sourceText } }],
        },
      }],
    }],
  };

  const outcome = await handleMetaWebhook(payload, io);
  if (outcome.messagesProcessed !== 1) throw new Error('The synthetic inbound message was not accepted by the webhook pipeline.');
  return getAiWorkflowTestStatus(testId);
}

export { getAiWorkflowTestStatus };
