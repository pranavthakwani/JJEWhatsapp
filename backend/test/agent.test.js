import assert from 'node:assert/strict';
import test from 'node:test';
import { MemorySaver, Command } from '@langchain/langgraph';
import { normalizeFields, missingFields, proposeChanges, matchOffering, assertSendAllowed, DEFAULT_POLICY } from '../src/agent/domain.js';
import { createReviewGraph,createIntakeGraph,fallbackDraft,linkCase } from '../src/agent/graphs.js';
import { eligibleTemplate } from '../src/agent/templates.js';
import { requireAgentStaff } from '../src/agent/routes.js';
import { env } from '../src/config/env.js';

test('normalization keeps unknown commercial information unknown',()=>{
  const fields=normalizeFields({brand:'mi',model:'A16',ramGb:'8',storageGb:256,quantityMin:20,gstIncluded:'yes',condition:'brand-new'});
  assert.equal(fields.brand,'Xiaomi');assert.equal(fields.ramGb,8);assert.equal(fields.gstIncluded,undefined);assert.equal(fields.condition,undefined);
  assert.deepEqual(missingFields('lead',fields),[]);assert.deepEqual(missingFields('offering',fields),['price','availability']);
  assert.throws(()=>normalizeFields({priceMin:200,priceMax:100}));
});
test('burst evidence combines fields without overwriting human corrections',()=>{
  const messages=[{message_id:1,direction:'inbound',text_body:'A16 8/256 available'},{message_id:2,direction:'inbound',text_body:'20 black'}];
  const extraction=[{field:'model',value:'A16',messageId:1,evidence:'A16',confidence:1},{field:'quantityMin',value:20,messageId:2,evidence:'20',confidence:1},{field:'priceMin',value:100,messageId:2,evidence:'not in message',confidence:1}];
  const result=proposeChanges(null,extraction,messages);assert.equal(result.fields.quantityMin,20);assert.equal(result.evidence.length,2);assert.equal(result.fields.priceMin,undefined);
  const changed=proposeChanges({fields:{quantityMin:10},protectedFields:['quantityMin']},extraction,messages);
  assert.equal(changed.fields.quantityMin,10);assert.equal(changed.conflicts.length,1);
  assert.equal(proposeChanges(null,extraction,messages.map(m=>({...m,direction:'outbound'}))).evidence.length,0);
});
test('explicit specification, quantity, color and budget mismatches are excluded',()=>{
  const seller={id:1,fields:{model:'A16',ramGb:8,storageGb:256,quantityMin:20,priceMin:14000,currency:'INR',availability:'available',colors:[{name:'black'}]},state:'ready',control:'active',confirmedAt:new Date().toISOString()};
  const buyer={model:'A16',quantityMin:10,ramGb:8,currency:'INR'};assert.equal(matchOffering(buyer,seller).provisional,false);
  for(const fields of [{ramGb:12},{model:'A17'},{quantityMin:30},{priceMax:13000},{colors:[{name:'white'}]}])assert.equal(matchOffering({...buyer,...fields},seller),null);
  assert.equal(matchOffering(buyer,{...seller,confirmedAt:null}).provisional,true);
  assert.equal(matchOffering(buyer,{...seller,fields:{...seller.fields,availability:'unavailable'}}),null);
  assert.equal(matchOffering(buyer,{...seller,confirmedAt:new Date(Date.now()-25*3600000).toISOString()}).provisional,true);
});
test('sending rejects stale, unapproved, opted-out, expired and excessive follow-ups',()=>{
  const good={action:{conversationId:1,kind:'clarification',status:'approved',approvedBy:1,content:'Quantity?',approvedContent:'Quantity?',caseVersion:1,sourceMessageId:10,recipient:'919000000000',approvedAt:new Date().toISOString()},caseRecord:{version:1,control:'active',state:'ready'},conversation:{contactWaId:'919000000000',contactOptInStatus:'opted_in',contactLastInboundAt:new Date().toISOString()},policy:{...DEFAULT_POLICY,mode:'review',allowlist:[1]},sendingEnabled:true,latestMessageId:10};
  assert.doesNotThrow(()=>assertSendAllowed(good));
  for(const change of [{sendingEnabled:false},{latestMessageId:11},{unanswered:2},{action:{...good.action,approvedContent:'Other'}},{caseRecord:{...good.caseRecord,control:'handover'}},{action:{...good.action,kind:'match'}},{action:{...good.action,approvedAt:new Date(Date.now()-31*60000).toISOString()}},{conversation:{...good.conversation,contactOptInStatus:'opted_out'}},{conversation:{...good.conversation,contactLastInboundAt:new Date(Date.now()-25*3600000).toISOString()}}])assert.throws(()=>assertSendAllowed({...good,...change}));
});
test('shared admin needs app identity; optional strict mode requires staff roles',()=>{
  let code,next=false;const res={status(n){code=n;return this;},json(){}};
  const original=env.features.agentSharedAdminAccess;
  try {
  env.features.agentSharedAdminAccess=true;
  const deviceRequest={auth:{device:{id:1}}};requireAgentStaff(deviceRequest,res,()=>{next=true;});assert.equal(next,true);assert.deepEqual(deviceRequest.agentActor,{key:'device:1',userId:null});
  next=false;requireAgentStaff({},res,()=>{next=true;});assert.equal(code,401);assert.equal(next,false);
  env.features.agentSharedAdminAccess=false;
  requireAgentStaff({auth:{device:{id:1}}},res,()=>{next=true;});assert.equal(code,401);assert.equal(next,false);
  requireAgentStaff({auth:{user:{roles:['viewer']}}},res,()=>{next=true;});assert.equal(code,403);
  requireAgentStaff({auth:{user:{id:1,roles:['operator']}}},res,()=>{next=true;});assert.equal(next,true);
  } finally {env.features.agentSharedAdminAccess=original;}
});
test('review interrupts survive graph reconstruction and execute once',async()=>{
  const checkpointer=new MemorySaver(),config={configurable:{thread_id:'review-test'}};let sends=0;
  const send=async()=>{sends++;return {status:'accepted'};};
  await createReviewGraph({checkpointer,send}).invoke({actionId:1},config);assert.equal(sends,0);
  const restarted=createReviewGraph({checkpointer,send});const result=await restarted.invoke(new Command({resume:{approved:true,userId:1}}),config);
  assert.equal(result.result.status,'accepted');assert.equal(sends,1);assert.deepEqual((await restarted.getState(config)).next,[]);
});
test('pending review does not block a separate conversation graph',async()=>{
  const graph=createIntakeGraph({checkpointer:new MemorySaver(),loadNode:async()=>({context:{messages:[],cases:[]}}),extractNode:async()=>({extracted:{items:[]}}),persistNode:async()=>({outcomes:[{caseId:1}]})});
  const result=await graph.invoke({runId:'one',conversationId:1,sourceMessageId:1},{configurable:{thread_id:'intake-test'}});assert.equal(result.outcomes.length,1);
});
test('clarification fallbacks ask at most two missing details in supported scripts',()=>{
  assert.equal(fallbackDraft(['quantity','price','availability'],'en'),'Could you confirm the required quantity and price per unit?');
  assert.match(fallbackDraft(['price'],'gu'),/કિંમત/);assert.match(fallbackDraft(['quantity'],'hi'),/मात्रा/);
});
test('quoted references take precedence; ambiguous SKU replies require review',()=>{
  const context={processedMessageId:10,messages:[{message_id:11,direction:'inbound',text_body:'20 black',parent_provider_message_id:'quoted-sku'}],cases:[{id:1,fields:{model:'A16'}},{id:2,fields:{model:'A17'}}],quoteLinks:[{case_id:2,provider_message_id:'quoted-sku'}]};
  const item={caseId:1,fields:[{messageId:11}]};assert.deepEqual(linkCase(item,context),{caseId:2,ambiguous:false});
  assert.equal(linkCase(item,{...context,quoteLinks:[]}).ambiguous,true);
  assert.equal(linkCase(item,{...context,messages:[{message_id:11,direction:'inbound',text_body:'20 black'}]}).ambiguous,true);
});
test('only approved fixed text templates are eligible, never AI parameters',()=>{
  const template={name:'followup',language:'en_IN',status:'APPROVED',components:[{type:'BODY',text:'Please reply to continue.'}]};
  assert.ok(eligibleTemplate([template],'followup','en_IN'));
  for(const t of [{...template,status:'REJECTED'},{...template,components:[{type:'BODY',text:'Price {{1}}'}]},{...template,components:[...template.components,{type:'HEADER',format:'IMAGE'}]}])assert.equal(eligibleTemplate([t],'followup','en_IN'),null);
});
