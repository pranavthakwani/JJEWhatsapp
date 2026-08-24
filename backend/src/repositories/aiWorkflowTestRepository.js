import { input, parseJson, query, sql } from './sqlHelpers.js';

export async function getAiWorkflowTestStatus(testId) {
  const result = await query(`
    SELECT message.message_id,message.conversation_id,message.provider_message_id,message.text_body,message.created_at,
      COALESCE(contact.business_name,contact.profile_name,contact.phone_number,contact.wa_id) contact_name,
      job.status job_status,job.attempt_count,job.last_error,job.created_at job_created_at,job.completed_at,
      analysis.message_analysis_id,analysis.classification,analysis.confidence,analysis.model_name,
      analysis.extracted_json,analysis.status analysis_status,analysis.error_message analysis_error,
      (SELECT COUNT_BIG(*) FROM jje.leads lead WHERE lead.message_analysis_id=analysis.message_analysis_id) lead_count,
      (SELECT COUNT_BIG(*) FROM jje.offerings offering WHERE offering.message_analysis_id=analysis.message_analysis_id) offering_count
    FROM jje.messages message
    INNER JOIN jje.contacts contact ON contact.contact_id=message.contact_id
    LEFT JOIN jje.background_jobs job ON job.aggregate_type='message' AND job.aggregate_id=message.message_id AND job.job_type='analyze_message'
    LEFT JOIN jje.message_analysis analysis ON analysis.message_id=message.message_id AND analysis.analysis_version=1
    WHERE message.provider_message_id=@testId AND message.provider_message_id LIKE 'workflow-test-%';`, [
    input('testId', sql.VarChar(255), testId),
  ]);

  const row = result.recordset[0];
  if (!row) return null;
  const extraction = parseJson(row.extracted_json, null);
  let stage = 'received';
  if (row.job_status === 'queued') stage = 'queued';
  if (row.job_status === 'processing') stage = 'processing';
  if (row.job_status === 'failed' || row.analysis_status === 'failed') stage = 'failed';
  if (row.analysis_status === 'completed' && row.job_status === 'completed') stage = 'completed';

  return {
    testId: row.provider_message_id,
    stage,
    messageId: Number(row.message_id),
    conversationId: Number(row.conversation_id),
    contactName: row.contact_name,
    sourceText: row.text_body,
    jobStatus: row.job_status || null,
    attemptCount: Number(row.attempt_count || 0),
    classification: row.classification || null,
    confidence: row.confidence === null ? null : Number(row.confidence),
    model: row.model_name || null,
    leadCount: Number(row.lead_count || 0),
    offeringCount: Number(row.offering_count || 0),
    items: Array.isArray(extraction?.items) ? extraction.items : [],
    error: row.last_error || row.analysis_error || null,
    createdAt: row.created_at?.toISOString?.() || row.created_at || null,
    completedAt: row.completed_at?.toISOString?.() || row.completed_at || null,
  };
}
