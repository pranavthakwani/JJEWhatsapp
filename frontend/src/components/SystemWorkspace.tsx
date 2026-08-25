import { Beaker, Bot, CheckCircle2, Circle, Database, HardDrive, Loader2, MessageCircleMore, RefreshCw, Server, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getAiStatus, getAiWorkflowTest, getHealthStatus, startAiWorkflowTest } from '../lib/api';
import type { AiWorkflowTest, BootstrapPayload } from '../types';

type Props = {
  numbers: BootstrapPayload['businessNumbers'];
  deviceApprovalRequired: boolean;
};

export function SystemWorkspace({ numbers, deviceApprovalRequired }: Props) {
  const [health, setHealth] = useState<{ ok: boolean; database: string } | null>(null);
  const [ai, setAi] = useState<{ enabled: boolean; workflowTestEnabled: boolean; configured: boolean; model: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [testMessage, setTestMessage] = useState('WANT TO SELL: Samsung Galaxy A15 5G 8/128, 12 units, fresh stock, ₹14,500 each, GST included, dispatch from Surat.');
  const [workflowTest, setWorkflowTest] = useState<AiWorkflowTest | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [testError, setTestError] = useState('');
  const testRun = useRef(0);

  async function refresh() {
    setLoading(true);
    const [healthResult, aiResult] = await Promise.allSettled([getHealthStatus(), getAiStatus()]);
    setHealth(healthResult.status === 'fulfilled' ? healthResult.value : { ok: false, database: 'unavailable' });
    setAi(aiResult.status === 'fulfilled' ? aiResult.value : { enabled: false, workflowTestEnabled: false, configured: false, model: null });
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    return () => { testRun.current += 1; };
  }, []);

  async function runWorkflowTest() {
    const run = ++testRun.current;
    setTestRunning(true); setTestError(''); setWorkflowTest(null);
    try {
      let current = await startAiWorkflowTest(testMessage);
      if (testRun.current !== run) return;
      setWorkflowTest(current);
      for (let attempt = 0; attempt < 60 && !['completed', 'failed'].includes(current.stage); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (testRun.current !== run) return;
        current = await getAiWorkflowTest(current.testId);
        setWorkflowTest(current);
        if (current.error && current.attemptCount >= 1 && current.stage === 'queued') {
          throw new Error(`The extraction worker will retry automatically. Latest provider error: ${current.error}`);
        }
      }
      if (!['completed', 'failed'].includes(current.stage)) {
        throw new Error(current.error ? `The worker is retrying after: ${current.error}` : 'The test is still processing. Refresh the status or try again shortly.');
      }
      if (current.stage === 'failed') throw new Error(current.error || 'AI extraction failed.');
    } catch (reason) {
      if (testRun.current === run) setTestError(reason instanceof Error ? reason.message : 'Workflow test failed.');
    } finally {
      if (testRun.current === run) setTestRunning(false);
    }
  }

  async function checkWorkflowTestStatus() {
    if (!workflowTest) return;
    setTestError('');
    try {
      const latest = await getAiWorkflowTest(workflowTest.testId);
      setWorkflowTest(latest);
      if (latest.stage === 'failed' || latest.error) setTestError(latest.error || 'AI extraction failed.');
    } catch (reason) {
      setTestError(reason instanceof Error ? reason.message : 'The latest test status could not be loaded.');
    }
  }

  const checks = [
    { icon: Server, label: 'API service', detail: health?.ok ? 'Operational' : 'Unavailable', ok: Boolean(health?.ok) },
    { icon: Database, label: 'Kore_Demo database', detail: health?.database || 'Checking', ok: health?.database === 'ready' },
    { icon: MessageCircleMore, label: 'WhatsApp numbers', detail: `${numbers.filter((number) => number.status === 'active').length} active`, ok: numbers.some((number) => number.status === 'active') },
    { icon: Bot, label: 'AI extraction worker', detail: ai?.enabled ? `Enabled · ${ai.model || 'configured model'}` : 'Disabled · WhatsApp remains independent', ok: Boolean(ai?.enabled), neutral: !ai?.enabled },
    { icon: ShieldCheck, label: 'Device approval', detail: deviceApprovalRequired ? 'Required' : 'Disabled', ok: !deviceApprovalRequired, neutral: deviceApprovalRequired },
  ];

  return (
    <section className="crm-module system-workspace">
      <header className="crm-module-header"><div><span className="crm-eyebrow">Operations</span><h1>System</h1><p>Runtime health and deployment capabilities.</p></div><button type="button" className="crm-icon-button" onClick={() => void refresh()} title="Refresh"><RefreshCw className={loading ? 'is-spinning' : ''} size={17} /></button></header>
      <div className="system-status-strip"><span className={health?.ok ? 'is-healthy' : 'is-down'}><i />{health?.ok ? 'All core systems operational' : 'Core service attention required'}</span><small>Live status from this deployment</small></div>
      <div className="system-checks">
        {checks.map((check) => <article key={check.label}><span className="system-checks__icon"><check.icon size={19} /></span><div><strong>{check.label}</strong><small>{check.detail}</small></div>{check.neutral ? <HardDrive size={17} /> : check.ok ? <CheckCircle2 className="is-ok" size={18} /> : <XCircle className="is-error" size={18} />}</article>)}
      </div>
      {ai?.enabled && ai.workflowTestEnabled && <section className="system-workflow-test">
        <header><div><span><Beaker size={18} />AI workflow test</span><p>Simulate an inbound WhatsApp message and follow it through the real SQL queue and extraction worker.</p></div><em>Uses one AI request</em></header>
        <div className="system-workflow-test__body">
          <label>Test WhatsApp message<textarea value={testMessage} maxLength={4000} onChange={(event) => setTestMessage(event.target.value)} disabled={testRunning} /></label>
          <button type="button" className="crm-primary-button" onClick={() => void runWorkflowTest()} disabled={testRunning || testMessage.trim().length < 10}>{testRunning ? <Loader2 className="is-spinning" size={17} /> : <Sparkles size={17} />}{testRunning ? 'Testing workflow…' : 'Run complete workflow test'}</button>
        </div>
        {(workflowTest || testRunning) && <div className="system-workflow-progress">
          {[
            { label: 'Inbound message stored', done: Boolean(workflowTest), active: !workflowTest },
            { label: 'Extraction job queued', done: Boolean(workflowTest?.jobStatus), active: workflowTest?.stage === 'received' },
            { label: 'AI extraction completed', done: workflowTest?.stage === 'completed', active: ['queued', 'processing'].includes(workflowTest?.stage || '') },
            { label: 'LeadOps outcome persisted', done: workflowTest?.stage === 'completed', active: false },
          ].map((stage) => <div key={stage.label} className={stage.done ? 'is-done' : stage.active ? 'is-active' : ''}>{stage.done ? <CheckCircle2 size={19} /> : stage.active ? <Loader2 className="is-spinning" size={19} /> : <Circle size={19} />}<span>{stage.label}</span></div>)}
        </div>}
        {testError && <div className="system-workflow-result is-error"><XCircle size={18} /><span><strong>Test did not complete</strong>{testError}</span>{workflowTest && <button type="button" onClick={() => void checkWorkflowTestStatus()}><RefreshCw size={15} />Check latest status</button>}</div>}
        {workflowTest?.stage === 'completed' && <div className="system-workflow-result is-success"><CheckCircle2 size={19} /><span><strong>End-to-end workflow passed</strong>{workflowTest.classification} · {Math.round((workflowTest.confidence || 0) * 100)}% confidence · {workflowTest.leadCount} leads · {workflowTest.offeringCount} offerings · message #{workflowTest.messageId}</span></div>}
      </section>}
      <section className="system-number-section"><header><div><h2>Business numbers</h2><p>WhatsApp Cloud API identities configured for this workspace.</p></div></header><div className="system-number-list">{numbers.map((number) => <article key={number.id}><span className="crm-avatar">{(number.displayName || 'J').slice(0, 1)}</span><div><strong>{number.displayName}</strong><small>{number.phoneNumber}</small></div><span className={`crm-status crm-status--${number.status}`}><i />{number.status}</span></article>)}</div></section>
    </section>
  );
}
