import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { createAgentRouter } from '../src/agent/routes.js';
import { closePool } from '../src/config/db.js';

test('agent shared admin accepts device access without account login and requires versions',async()=>{
  const app=express();app.use(express.json());
  // Test-only identity injection in this isolated server, not the application.
  app.use((req,res,next)=>{const role=req.headers['x-test-role'];req.auth={device:{id:1},...(role?{user:{id:1,roles:[role]}}:{})};next();});
  app.use('/api/agent',createAgentRouter());app.use((err,req,res,next)=>res.status(err.statusCode||500).json({error:err.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/api/agent`;
  try {
    assert.equal((await fetch(`${base}/health`)).status,200);
    assert.equal((await fetch(`${base}/health`,{headers:{'x-test-role':'viewer'}})).status,200);
    const health=await fetch(`${base}/health`,{headers:{'x-test-role':'operator'}});assert.equal(health.status,200);assert.equal((await health.json()).sendingEnabled,false);
    const policy=await fetch(`${base}/policy`,{method:'PUT',headers:{'content-type':'application/json'},body:'{}'});assert.equal(policy.status,400);
    const invalid=await fetch(`${base}/actions/1/approve`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(invalid.status,400);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test.after(()=>closePool());
