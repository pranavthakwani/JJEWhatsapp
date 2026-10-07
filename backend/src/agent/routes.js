import { Router } from 'express';
import * as repository from './repository.js';
import { agentError,matchOffering } from './domain.js';
import { refreshCase } from './caseRefresh.js';
import { importSelectedRecords } from './backfill.js';
import { canReviewAgent,canManageAgent,requestActor } from './access.js';

export function requireAgentStaff(req,res,next) {
  if(!canReviewAgent(req.auth))return res.status(req.auth?.user?403:401).json({error:'Application access is required to review agent actions.',code:'AGENT_ACCESS_REQUIRED'});
  req.agentActor=requestActor(req.auth);
  next();
}
function id(value) { const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<=0)throw agentError('Invalid identifier.',400);return parsed; }
const handle=fn=>async(req,res,next)=>{try{res.json(await fn(req));}catch(error){if(error.number===51000||error.originalError?.info?.number===51000)error.statusCode=409;next(error);}};
export function createAgentRouter() {
  const router=Router();router.use(requireAgentStaff);
  router.get('/health',handle(()=>repository.health()));
  router.get('/policy',handle(()=>repository.policy()));
  router.put('/policy',handle(req=>{
    if(!canManageAgent(req.auth))throw agentError('Only administrators can change agent policy.',403);
    return repository.savePolicy(req.body,req.agentActor);
  }));
  router.post('/backfill',handle(req=>{
    if(!canManageAgent(req.auth))throw agentError('Only administrators may import selected historical records.',403);
    return importSelectedRecords(req.body?.records,req.agentActor);
  }));
  router.get('/actions',handle(req=>repository.listActions({status:req.query.status||null,conversationId:req.query.conversationId?id(req.query.conversationId):null,limit:req.query.limit})));
  router.get('/actions/:id',handle(async req=>{
    const action=await repository.getAction(id(req.params.id));if(!action)throw agentError('Action not found.',404);
    return {...action,case:await repository.caseDetail(action.caseId)};
  }));
  for(const operation of ['claim','release','edit','approve','reject','cancel','resolve'])router.post(`/actions/:id/${operation}`,handle(req=>{
    if(!Number.isInteger(req.body?.version)||req.body.version<1)throw agentError('A current version is required.',400);
    return repository.mutateAction(id(req.params.id),req.agentActor,req.body.version,operation,req.body);
  }));
  router.get('/cases',handle(req=>repository.listCases(req.query.conversationId?id(req.query.conversationId):null)));
  router.get('/cases/:id',handle(async req=>{
    const record=await repository.caseDetail(id(req.params.id)),currentPolicy=await repository.policy();
    const candidates=record.kind==='lead'?await repository.offeringCandidates(record.conversationId):[];
    return {...record,matches:candidates.map(c=>matchOffering(record.fields,c,currentPolicy)).filter(Boolean).sort((a,b)=>b.score-a.score)};
  }));
  router.post('/cases/:id/regenerate',handle(async req=>{
    const record=await repository.getCase(id(req.params.id));
    if(!record||record.version!==req.body?.version)throw agentError('Case changed; refresh first.');
    return refreshCase(record.id,{regenerate:true});
  }));
  router.post('/cases/:id/link',handle(async req=>{
    if(!Number.isInteger(req.body?.version)||!Number.isInteger(req.body?.targetVersion))throw agentError('Current source and target versions are required.',400);
    const record=await repository.linkCases(id(req.params.id),id(req.body.targetCaseId),req.agentActor,req.body.version,req.body.targetVersion);
    await refreshCase(record.id);return record;
  }));
  router.patch('/cases/:id',handle(async req=>{
    if(!Number.isInteger(req.body?.version))throw agentError('A current version is required.',400);
    const record=await repository.mutateCase(id(req.params.id),req.agentActor,req.body.version,req.body);
    if(['correct','resume'].includes(req.body.operation))await refreshCase(record.id);
    return record;
  }));
  return router;
}
