import { listMessageTemplates,sendTemplateMessage } from '../services/metaCloudService.js';
import { agentError } from './domain.js';

export function eligibleTemplate(templates,name,language) {
  const template=templates.find(t=>t.name===name&&t.language===language&&t.status==='APPROVED');
  if(!template)return null;
  const components=template.components||[],body=components.find(c=>c.type==='BODY')?.text;
  // First release deliberately supports fixed, text-only templates. Parameterized
  // templates need an explicit approved parameter editor, never generated prose.
  if(!body||components.some(c=>(c.type==='HEADER'&&c.format!=='TEXT')||JSON.stringify(c).includes('{{')))return null;
  return {name:template.name,language:template.language,body,components:[]};
}
export async function findWindowTemplate(number) {
  const name=process.env.OPT_IN_FOLLOWUP_TEMPLATE_NAME,language=process.env.OPT_IN_TEMPLATE_LANGUAGE||'en_IN';
  if(!name)return null;
  return eligibleTemplate(await listMessageTemplates(number),name,language);
}
export async function sendReviewedTemplate(number,conversation,template,approvedContent) {
  if(conversation.contactOptInStatus!=='opted_in')throw agentError('Recipient has not opted in.',409,'CONTACT_OPTED_OUT');
  const current=eligibleTemplate(await listMessageTemplates(number),template.name,template.language);
  if(!current||current.body!==approvedContent)throw agentError('Template approval or content changed; staff must review again.',409,'INVALID_MESSAGE');
  return sendTemplateMessage({number,to:conversation.contactWaId,templateName:current.name,languageCode:current.language,components:[]});
}
