import { sendTextMessage } from './metaCloudService.js';
import { agentError } from '../agent/domain.js';

// The model never calls Meta directly. Both manual text sends and approved
// agent actions enter through this checked transport.
export async function sendConversationText({number,conversation,text,replyToWaMessageId}) {
  if(typeof text!=='string'||!text.trim()||text.length>4096)throw agentError('Text must contain 1–4096 characters.',400,'INVALID_MESSAGE');
  if(conversation.contactOptInStatus==='opted_out')throw agentError('This contact opted out.',409,'CONTACT_OPTED_OUT');
  const last=new Date(conversation.contactLastInboundAt).getTime();
  if(!Number.isFinite(last)||Date.now()-last>=24*3600000)throw agentError('The 24-hour customer-service window is closed. Send an eligible approved template first.',409,'CUSTOMER_WINDOW_CLOSED');
  if(!number||number.status!=='active')throw agentError('WhatsApp business number is inactive.',409);
  return sendTextMessage({number,to:conversation.contactWaId,body:text,replyToWaMessageId});
}
