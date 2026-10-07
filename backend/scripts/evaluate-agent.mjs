import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

// Offline evaluation only. Never contacts a provider, modifies cases or creates actions.
const file=process.argv[2];if(!file)throw new Error('Usage: node scripts/evaluate-agent.mjs <staff-reviewed-heldout.json>');
const cases=JSON.parse(await fs.readFile(file,'utf8'));assert.ok(Array.isArray(cases),'Expected a JSON array');
let correctLinks=0,correctFields=0,populatedFields=0,commitments=0,duplicates=0,baseline=0,agentTime=0;
const languages=new Set(),ids=new Set();
for(const sample of cases) {
  assert.ok(sample.id&&!ids.has(sample.id),'Unique case IDs required');ids.add(sample.id);
  assert.equal(sample.heldOut,true,'Only held-out conversations qualify');
  assert.ok(sample.reviewedBy&&sample.expected&&sample.actual,'Staff label and model result required');
  assert.ok(['en','hi','gu','hi-Latn','gu-Latn'].includes(sample.language),'Unknown language/script');languages.add(sample.language);
  if(sample.expected.intent===sample.actual.intent&&sample.expected.caseId===sample.actual.caseId)correctLinks++;
  for(const [field,value] of Object.entries(sample.actual.fields||{})) {
    if(value===null||value===undefined)continue;populatedFields++;
    if(Object.hasOwn(sample.expected.fields||{},field)&&JSON.stringify(sample.expected.fields[field])===JSON.stringify(value))correctFields++;
  }
  assert.ok(Number.isInteger(sample.unsupportedCommitments)&&sample.unsupportedCommitments>=0,'Staff must grade commercial commitments');
  assert.ok(Number.isInteger(sample.duplicateSends)&&sample.duplicateSends>=0,'Failure/restart duplicate-send result required');
  commitments+=sample.unsupportedCommitments;duplicates+=sample.duplicateSends;
  if(Number.isFinite(sample.baselineSeconds)&&Number.isFinite(sample.staffSeconds)){baseline+=sample.baselineSeconds;agentTime+=sample.staffSeconds;}
}
const linking=cases.length?correctLinks/cases.length:0,precision=populatedFields?correctFields/populatedFields:0,timeReduction=baseline?1-agentTime/baseline:null;
const pilotGate=cases.length>=150&&languages.size===5&&linking>=.95&&precision>=.95&&commitments===0&&duplicates===0;
console.log(JSON.stringify({cases:cases.length,languages:[...languages],intentAndLinkAccuracy:linking,fieldPrecision:precision,unsupportedCommitments:commitments,duplicateSends:duplicates,staffTimeReduction:timeReduction,pilotGate,expansionGate:pilotGate&&timeReduction!==null&&timeReduction>=.30},null,2));
if(!pilotGate)process.exitCode=1;
