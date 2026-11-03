// Opt-in keyless integration against an installed current dsh, not a fake SDK process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { runJob, readJob, sendMessage, answerRequest, result, eventsPage } from '../lib/bridge.mjs';
import { listSessionFiles } from '../lib/sessions.mjs';

test(
  'published dsh answers native questions and approvals over the SDK, then logs v4 without a model call',
  {
    skip: !process.env.DPSK_REAL_DSH_ENTRY,
    timeout: 120000,
  },
  async (t) => {
    const entry = fs.realpathSync(process.env.DPSK_REAL_DSH_ENTRY);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-real-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const previous = {
      DSH_HOME: process.env.DSH_HOME,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED,
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE,
    };

    process.env.DSH_HOME = path.join(root, '.dsh');
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DSH_TELEMETRY_DISABLED = '1';

    // Pin the policy this test depends on: workspace-write with an approval prompt,
    // so the mock provider's danger-full-access escalation must reach the host.
    process.env.DSH_PERMISSION_MODE = 'workspace-write';

    t.after(() => {
      for (const [key, value] of Object.entries(previous))
        value === undefined ? delete process.env[key] : (process.env[key] = value);
    });

    const llm = pathToFileURL(createRequire(entry).resolve('@deepseek-ai/dsh-llm')).href;
    const plugin = path.join(root, 'mock-provider.mjs');

    // Three model steps: ask a question, request a sandbox escalation the host
    // must approve, then report whether the escalated command really ran.
    fs.writeFileSync(
      plugin,
      `
import { LlmAdapter } from ${JSON.stringify(llm)};
class Adapter extends LlmAdapter {
 async resolveModel(provider,model){return {provider,id:model,name:model};}
 async *stream(options){
  const toolResults=options.messages.filter(message=>message.role==='tool');
  if(toolResults.length===0){
   const args=JSON.stringify({questions:[{id:'choice',question:'Return the host response?',options:[]}]});
   yield {type:'block-start',index:0,blockType:'tool-call'};
   yield {type:'tool-call-delta',index:0,id:'ask',name:'ask_user_question',argumentsDelta:args};
   yield {type:'block-end',index:0,block:{type:'tool-call',id:'ask',name:'ask_user_question',arguments:args}};
   yield {type:'finish',reason:{kind:'tool-calls'}};return;
  }
  if(toolResults.length===1){
   const args=JSON.stringify({description:'Print the approval marker',command:'Write-Output approval-ok',
    sandbox_permissions:'danger-full-access',justification:'Verify the native approval round trip.'});
   yield {type:'block-start',index:0,blockType:'tool-call'};
   yield {type:'tool-call-delta',index:0,id:'approve',name:'pwsh',argumentsDelta:args};
   yield {type:'block-end',index:0,block:{type:'tool-call',id:'approve',name:'pwsh',arguments:args}};
   yield {type:'finish',reason:{kind:'tool-calls'}};return;
  }
  const latest=options.messages.filter(m=>m.role==='user').at(-1);
  const update=(latest?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const approved=JSON.stringify(toolResults.at(-1)?.content||'').includes('approval-ok');
  const text='RESULT: OK\\nreal harness mock: '+(update.includes('HOST_UPDATE')?'HOST_UPDATE':'initial')+(approved?' approved':' approval-missing');
  yield {type:'block-start',index:0,blockType:'text'};
  yield {type:'text-delta',index:0,text};
  yield {type:'block-end',index:0,block:{type:'text',text}};
  yield {type:'usage',usage:{inputTokens:7,outputTokens:4,cacheReadTokens:0,cacheWriteTokens:0}};
  yield {type:'finish',reason:{kind:'stop'}};
 }
}
export const name='bridge-keyless-provider';export const inject=['llm'];
export function apply(ctx){ctx.llm.registerAdapter(['bridge-test'],new Adapter());}
`,
    );

    const patch = path.join(root, 'mock.patch.yml');
    fs.writeFileSync(
      patch,
      `- insert:\n    - id: bridge-keyless-provider\n      name: ${JSON.stringify(plugin)}\n`,
    );

    const brief = path.join(root, 'brief.md');
    fs.writeFileSync(
      brief,
      'Run the keyless bridge integration. Ask the host, then return the mock report.',
    );

    const home = path.join(process.env.DSH_HOME, 'bridge');

    let asked = 0,
      approvals = 0,
      sent = false,
      questionId = null,
      approvalId = null;

    const job = await runJob(
      {
        cwd: root,
        brief,
        patch: [patch],
        dshEntry: entry,
        timeout: 60,
        provider: 'bridge-test',
        model: 'bridge-test',
      },
      (e) => {
        if (e.event !== 'request') return;
        if (e.method === 'user-question/ask') {
          asked++;
          questionId = e.requestId;
          if (!sent) {
            sendMessage(readJob(e.id, home), 'HOST_UPDATE', home);
            sent = true;
          }
          answerRequest(
            readJob(e.id, home),
            e.requestId,
            { answers: [{ id: 'choice', selected: [], custom: 'Continue mock validation' }] },
            home,
          );
        } else if (e.method === 'approval/request') {
          approvals++;
          approvalId = e.requestId;
          answerRequest(readJob(e.id, home), e.requestId, { outcome: 'allowed-once' }, home);
        }
      },
      home,
    );

    assert.equal(
      job.processState,
      'completed',
      `${job.error}\n${fs.readFileSync(job.stderrFile, 'utf8')}`,
    );

    assert.equal(job.reportedResult, 'OK');
    assert.ok(asked > 0, 'the native user-question/ask request reached the bridge');
    assert.ok(approvals > 0, 'the native approval/request request reached the bridge');

    assert.match(result(job).report, /HOST_UPDATE/);
    assert.match(
      result(job).report,
      /approved/,
      'the approved escalation actually ran the command',
    );

    const events = eventsPage(job, 0, 200).events;
    assert.ok(
      events.some(
        (e) =>
          e.event === 'request' && e.method === 'user-question/ask' && e.requestId === questionId,
      ),
    );
    assert.ok(events.some((e) => e.event === 'input_delivered' && e.requestId === questionId));
    assert.ok(
      events.some(
        (e) =>
          e.event === 'request' && e.method === 'approval/request' && e.requestId === approvalId,
      ),
    );
    assert.ok(events.some((e) => e.event === 'input_delivered' && e.requestId === approvalId));

    assert.ok(
      listSessionFiles(path.join(path.dirname(home), 'sessions')).some(
        (session) => session.version === 4,
      ),
    );
  },
);
