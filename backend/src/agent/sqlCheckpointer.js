import { BaseCheckpointSaver, WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';
import { input, query, sql } from '../repositories/sqlHelpers.js';

export class SqlServerCheckpointer extends BaseCheckpointSaver {
  constructor(execute=query) { super();this.execute=execute; }
  params(config) {
    const {thread_id,checkpoint_ns='',checkpoint_id=null}=config.configurable || {};
    if(typeof thread_id!=='string'||!thread_id||thread_id.length>200||checkpoint_ns.length>200) throw new Error('Invalid checkpoint thread or namespace.');
    return [input('thread',sql.VarChar(200),thread_id),input('ns',sql.VarChar(200),checkpoint_ns),input('id',sql.VarChar(100),checkpoint_id)];
  }
  async getTuple(config) {
    const r=await this.execute(`SELECT TOP(1) * FROM jje.agent_checkpoints WHERE thread_id=@thread AND checkpoint_ns=@ns
      AND (@id IS NULL OR checkpoint_id=@id) ORDER BY checkpoint_id DESC;`,this.params(config));
    const row=r.recordset[0];if(!row)return undefined;
    const writes=await this.execute(`SELECT * FROM jje.agent_checkpoint_writes WHERE thread_id=@thread AND checkpoint_ns=@ns AND checkpoint_id=@id ORDER BY task_id,write_index`,this.params({configurable:{...config.configurable,checkpoint_id:row.checkpoint_id}}));
    const configurable={thread_id:row.thread_id,checkpoint_ns:row.checkpoint_ns,checkpoint_id:row.checkpoint_id};
    return {config:{configurable},checkpoint:await this.serde.loadsTyped(row.checkpoint_type,row.checkpoint_data),
      metadata:await this.serde.loadsTyped(row.metadata_type,row.metadata_data),
      parentConfig:row.parent_id?{configurable:{...configurable,checkpoint_id:row.parent_id}}:undefined,
      pendingWrites:await Promise.all(writes.recordset.map(async w=>[w.task_id,w.channel,await this.serde.loadsTyped(w.value_type,w.value_data)]))};
  }
  async put(config,checkpoint,metadata) {
    const [ct,cd]=await this.serde.dumpsTyped(checkpoint),[mt,md]=await this.serde.dumpsTyped(metadata);
    const cfg={configurable:{...config.configurable,checkpoint_id:checkpoint.id}};
    await this.execute(`MERGE jje.agent_checkpoints WITH(HOLDLOCK) target USING(SELECT @thread thread_id,@ns checkpoint_ns,@id checkpoint_id) source
      ON target.thread_id=source.thread_id AND target.checkpoint_ns=source.checkpoint_ns AND target.checkpoint_id=source.checkpoint_id
      WHEN NOT MATCHED THEN INSERT(thread_id,checkpoint_ns,checkpoint_id,parent_id,checkpoint_type,checkpoint_data,metadata_type,metadata_data)
        VALUES(@thread,@ns,@id,@parent,@ct,@cd,@mt,@md);`,[
        ...this.params(cfg),input('parent',sql.VarChar(100),config.configurable?.checkpoint_id),input('ct',sql.VarChar(50),ct),input('cd',sql.VarBinary(sql.MAX),Buffer.from(cd)),input('mt',sql.VarChar(50),mt),input('md',sql.VarBinary(sql.MAX),Buffer.from(md))]);
    return cfg;
  }
  async putWrites(config,writes,taskId,taskPath='') {
    for(let i=0;i<writes.length;i++) {
      const [channel,value]=writes[i],[type,data]=await this.serde.dumpsTyped(value),index=WRITES_IDX_MAP[channel] ?? i;
      await this.execute(`MERGE jje.agent_checkpoint_writes WITH(HOLDLOCK) target USING(SELECT @thread thread_id,@ns checkpoint_ns,@id checkpoint_id,@task task_id,@index write_index) source
        ON target.thread_id=source.thread_id AND target.checkpoint_ns=source.checkpoint_ns AND target.checkpoint_id=source.checkpoint_id AND target.task_id=source.task_id AND target.write_index=source.write_index
        WHEN MATCHED AND @index<0 THEN UPDATE SET channel=@channel,value_type=@type,value_data=@data
        WHEN NOT MATCHED THEN INSERT(thread_id,checkpoint_ns,checkpoint_id,task_id,write_index,channel,value_type,value_data,task_path)
          VALUES(@thread,@ns,@id,@task,@index,@channel,@type,@data,@path);`,[...this.params(config),input('task',sql.VarChar(200),taskId),input('index',sql.Int,index),input('channel',sql.NVarChar(200),channel),input('type',sql.VarChar(50),type),input('data',sql.VarBinary(sql.MAX),Buffer.from(data)),input('path',sql.NVarChar(1000),taskPath)]);
    }
  }
  async *list(config,options={}) {
    const r=await this.execute(`SELECT thread_id,checkpoint_ns,checkpoint_id FROM jje.agent_checkpoints
      WHERE (@thread IS NULL OR thread_id=@thread) AND (@ns IS NULL OR checkpoint_ns=@ns)
        AND (@before IS NULL OR checkpoint_id<@before) ORDER BY checkpoint_id DESC`,[
      input('thread',sql.VarChar(200),config?.configurable?.thread_id),input('ns',sql.VarChar(200),config?.configurable?.checkpoint_ns),input('before',sql.VarChar(100),options.before?.configurable?.checkpoint_id)]);
    let remaining=options.limit ?? Infinity;
    for(const row of r.recordset) {
      if(remaining<=0)return;
      const tuple=await this.getTuple({configurable:{thread_id:row.thread_id,checkpoint_ns:row.checkpoint_ns,checkpoint_id:row.checkpoint_id}});
      if(options.filter&&!Object.entries(options.filter).every(([key,value])=>JSON.stringify(tuple.metadata?.[key])===JSON.stringify(value)))continue;
      remaining--;yield tuple;
    }
  }
  async deleteThread(threadId) {
    await this.execute(`SET XACT_ABORT ON;BEGIN TRANSACTION;
      DELETE FROM jje.agent_checkpoint_writes WHERE thread_id=@thread;
      DELETE FROM jje.agent_checkpoints WHERE thread_id=@thread;COMMIT TRANSACTION;`,[input('thread',sql.VarChar(200),threadId)]);
  }
}
