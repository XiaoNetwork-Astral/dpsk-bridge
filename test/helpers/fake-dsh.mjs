// Dot-prefixed so Node's default `node --test` discovery skips this fixture
// module instead of reporting it as an empty test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A keyless SDK runtime. The first prompt selects a mode: "simple" finishes
// immediately, "chat" waits for both a follow-up message and an answer, and
// "hold" stays open until the supervisor stops it. All completion is driven by
// prompts and answers, so tests never depend on a timer.
export const fake = `
import readline from 'node:readline';
const write = (m, done) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n', done);
let sessionId, prompt='', extra='', answer=false, mode='', seq=0, finished=false;
const waiting=[];
const event=(type,data)=>write({method:'session.event',params:{sessionId,event:{type,seq:++seq,time:Date.now(),data}}});
const finish=()=>{
 if(finished || mode==='hold' || (mode==='chat' && (!extra || !answer)))return;
 finished=true;
 event('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'text',text:'RESULT: OK\\n'+extra}]},usage:{inputTokens:10,outputTokens:4,cacheReadTokens:0,cacheWriteTokens:0}});
 event('assistant/message',{turn:1,step:2,message:{role:'assistant',content:[{type:'reasoning',text:'no additional answer'}]}});
 event('turn/end',{turn:1,reason:{kind:'completed'}});
 for(const id of waiting.splice(0))write({id,result:{}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize'){write({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}}});}
 else if(m.method==='session/prompt'){
  sessionId=m.params.sessionId;
  const text=m.params.contentBlocks[0].text;
  if(!prompt){prompt=text;mode=text.includes('[chat]')?'chat':text.includes('[hold]')?'hold':'simple';
   event('user/message',{source:{kind:'user'},content:[{type:'text',text}]});
   if(mode==='chat')write({id:'ask-rpc-1',method:'user-question/ask',params:{requestId:'question-1',sessionId,questions:[{id:'choice',question:'Proceed?',options:[]}]}});
  }else extra=text;
  write({id:m.id,result:{messageId:'message-'+seq}});finish();
 }else if(m.method==='session/wait'){if(finished)write({id:m.id,result:{}});else waiting.push(m.id);}
 else if(m.method==='shutdown'){write({id:m.id,result:{}},()=>process.exit(0));}
 else if(m.id==='ask-rpc-1'){answer=!!m.result.answers;finish();}
});
`;

// A runtime that records the first prompt's contentBlocks so tests can inspect them.
export function captureRuntime(file) {
  return `
import fs from 'node:fs';
import readline from 'node:readline';
const write = (m, done) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n', done);
let sessionId, waitId, seq=0, finished=false;
const event=(type,data)=>write({method:'session.event',params:{sessionId,event:{type,seq:++seq,time:Date.now(),data}}});
const finish=()=>{
 if(finished)return;finished=true;
 event('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'text',text:'RESULT: OK'}]}});
 event('turn/end',{turn:1,reason:{kind:'completed'}});
 if(waitId)write({id:waitId,result:{}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')write({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}}});
 else if(m.method==='session/prompt'){
  sessionId=m.params.sessionId;
  fs.writeFileSync(${JSON.stringify(file)},JSON.stringify(m.params.contentBlocks));
  write({id:m.id,result:{messageId:'m'}});finish();
 }else if(m.method==='session/wait'){if(finished)write({id:m.id,result:{}});else waitId=m.id;}
 else if(m.method==='shutdown'){write({id:m.id,result:{}},()=>process.exit(0));}
});
`;
}

// Creates a temporary home and an SDK entry point whose version passes the
// bridge gate. The returned options can be spread to override a case.
export function setup(t, brief) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpsk-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime', 'lib'), { recursive: true });
  const entry = path.join(root, 'runtime', 'lib', 'bin.mjs'); fs.writeFileSync(entry, fake);
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), JSON.stringify({ version: '0.2.2-alpha.3' }));
  const briefFile = path.join(root, 'brief.md'); fs.writeFileSync(briefFile, brief);
  return { root, home: path.join(root, 'bridge'), options: { cwd: root, brief: briefFile, dshEntry: entry, timeout: 10 } };
}
