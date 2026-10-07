import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import { createReviewGraph } from '../src/agent/graphs.js';
import { SqlServerCheckpointer } from '../src/agent/sqlCheckpointer.js';
import { health,syncAgentSetting } from '../src/agent/repository.js';
import { closePool } from '../src/config/db.js';

test('SQL Server persists graph interrupts, writes and restart resume',async()=>{
  const thread=`test:${randomUUID()}`,config={configurable:{thread_id:thread}};let sends=0;
  const saver=new SqlServerCheckpointer();
  try {
    await syncAgentSetting();assert.equal((await health()).processingEnabled,false);
    await createReviewGraph({checkpointer:saver,send:async()=>{throw new Error('Must wait for review');}}).invoke({actionId:42},config);
    const tuple=await new SqlServerCheckpointer().getTuple(config);assert.ok(tuple.checkpoint);assert.ok(tuple.pendingWrites.length);
    const checkpoints=[];for await(const item of saver.list(config,{limit:2}))checkpoints.push(item);assert.equal(checkpoints.length,2);
    const restarted=createReviewGraph({checkpointer:new SqlServerCheckpointer(),send:async id=>{assert.equal(id,42);sends++;return {status:'accepted'};}});
    const result=await restarted.invoke(new Command({resume:{approved:true,userId:1}}),config);assert.equal(result.result.status,'accepted');assert.equal(sends,1);
    assert.deepEqual((await restarted.getState(config)).next,[]);
  } finally {await saver.deleteThread(thread);}
});
test.after(()=>closePool());
