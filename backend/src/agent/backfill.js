import { randomUUID } from 'node:crypto';
import { query,input,sql } from '../repositories/sqlHelpers.js';
import { normalizeFields,agentError,missingFields } from './domain.js';
import { persistCase,getCase } from './repository.js';
import { actorUserId,actorKey } from './access.js';

// Explicit, bounded historical selection. No model calls, proposals or sends.
export async function importSelectedRecords(selection,userId) {
  if(!Array.isArray(selection)||selection.length<1||selection.length>100)throw agentError('Select 1–100 explicit lead/offering IDs.',400);
  if(!selection.every(s=>['lead','offering'].includes(s.kind)&&Number.isSafeInteger(s.recordId)&&s.recordId>0))throw agentError('Each selected record needs a kind and positive recordId.',400);
  const imported=[];
  for(const selected of selection) {
    const lead=selected.kind==='lead',table=lead?'leads':'offerings',column=lead?'lead_id':'offering_id';
    const result=await query(`SELECT record.*,message.message_id,message.conversation_id,COALESCE(message.text_body,message.caption,'') source_text
      FROM jje.${table} record INNER JOIN jje.message_analysis analysis ON analysis.message_analysis_id=record.message_analysis_id
      INNER JOIN jje.messages message ON message.message_id=analysis.message_id WHERE record.${column}=@id;
      SELECT case_id FROM jje.agent_cases WHERE kind=@kind AND record_id=@id;`,[input('id',sql.BigInt,selected.recordId),input('kind',sql.VarChar(20),selected.kind)]);
    if(result.recordsets[1][0]){imported.push(await getCase(Number(result.recordsets[1][0].case_id)));continue;}
    const row=result.recordsets[0][0];if(!row)throw agentError(`Selected ${selected.kind} #${selected.recordId} not found.`,404);
    const fields=normalizeFields({brand:row.brand,model:row.model,variant:row.variant,ramGb:row.ram_gb,storageGb:row.storage_gb,
      quantityMin:row.quantity_min,quantityMax:row.quantity_max,priceMin:lead?row.target_price_min:row.price_min,priceMax:lead?row.target_price_max:row.price_max,
      gstIncluded:row.gst_included==null?null:Boolean(row.gst_included),condition:row.condition,dispatchLocation:row.dispatch_location,
      ...(lead?{}:{availability:row.status==='sold'?'unavailable':'unverified'})});
    const record=await persistCase({key:`historical:${selected.kind}:${selected.recordId}`,kind:selected.kind,conversationId:Number(row.conversation_id),sourceMessageId:Number(row.message_id),
      fields,state:['closed','archived','sold'].includes(row.status)?'closed':missingFields(selected.kind,fields).length?'qualifying':'ready',
      evidence:Object.entries(fields).map(([field,value])=>({field,value,messageId:Number(row.message_id),evidence:row.source_text.slice(0,2000),verification:'conflict'})),runId:`backfill:${randomUUID()}`});
    await query(`UPDATE jje.agent_cases SET record_id=@record WHERE case_id=@case;
      INSERT jje.agent_reviews(case_id,user_id,actor_key,decision,snapshot_json) VALUES(@case,@user,@actor,'backfill',@snapshot);`,[input('record',sql.BigInt,selected.recordId),input('case',sql.BigInt,record.id),input('user',sql.BigInt,actorUserId(userId)),input('actor',sql.VarChar(100),actorKey(userId)),input('snapshot',sql.NVarChar(sql.MAX),JSON.stringify(selected))]);
    imported.push(await getCase(record.id));
  }
  return imported;
}
