import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBridge } from '../../server/index.mjs';
import { AsrService } from '../../server/asr.mjs';

// Actual WAV bytes, repeated at the container level; all recognition is the real Small model.
const original = readFileSync(new URL('./fixtures/english-classroom.wav', import.meta.url));
let cursor = 12, format, pcm;
while (cursor + 8 <= original.length) {
  const id = original.toString('ascii', cursor, cursor+4), size = original.readUInt32LE(cursor+4);
  if (id === 'fmt ') format = original.subarray(cursor+8,cursor+8+size);
  if (id === 'data') pcm = original.subarray(cursor+8,cursor+8+size);
  cursor += 8+size+(size%2);
}
assert(format && pcm);
const repeated = Buffer.concat(Array(12).fill(pcm));
const fmt = Buffer.alloc(8); fmt.write('fmt '); fmt.writeUInt32LE(format.length,4);
const data = Buffer.alloc(8); data.write('data'); data.writeUInt32LE(repeated.length,4);
const riff = Buffer.alloc(12); riff.write('RIFF'); riff.writeUInt32LE(4+8+format.length+8+repeated.length,4); riff.write('WAVE',8);
const fixture = Buffer.concat([riff,fmt,format,data,repeated]);
const asr = new AsrService();
const bridge = createBridge({ asr, port:4552, allowedPorts:[4552], service:{close(){}} });
await bridge.listen();
const headers = { Origin:'http://127.0.0.1:4552', 'Content-Type':'application/octet-stream', 'X-Tinglan-Client':'1' };
async function run(body, controller, stopAfterFirst=false) {
  const response = await fetch('http://127.0.0.1:4552/api/asr/transcribe?language=en',{method:'POST',headers,body,signal:controller?.signal});
  let buffer='', events=[];
  try {
    for await (const chunk of response.body) {
      buffer+=new TextDecoder().decode(chunk); let at;
      while((at=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,at); buffer=buffer.slice(at+1); if(!line)continue;
        const event=JSON.parse(line); events.push(event);
        if(event.type==='progress') console.log(event.message);
        if(stopAfterFirst&&event.type==='segment'){controller.abort();return events;}
      }
    }
    return events;
  } catch(error) { if(!controller?.signal.aborted)throw error;return events; }
}
try {
  assert.equal((await asr.status()).available,true);
  const started=Date.now();
  const events=await run(fixture);
  assert.equal(events.some(e=>e.type==='error'),false);
  const done=events.find(e=>e.type==='result');assert(done);
  const segments=events.filter(e=>e.type==='segment').map(e=>e.segment);
  assert(done.durationMs>140000&&done.durationMs<144000);
  assert(done.maxBufferedSamples<=1024000);
  assert(segments.some(s=>s.startMs>120000),'tail window has actual recognized speech');
  assert(segments.every((s,i)=>s.endMs>s.startMs&&(!i||s.startMs>=segments[i-1].endMs)));
  assert(segments.some(s=>/read chapter 3/i.test(s.source)));
  console.log(JSON.stringify({gate:'REAL_3_WINDOW_ASR_PASS',result:done,elapsedMs:Date.now()-started,last:segments.at(-1)}));
  const controller=new AbortController();
  const partial=await run(fixture,controller,true);assert(partial.some(e=>e.type==='segment'));assert(!partial.some(e=>e.type==='result'));
  for(let i=0;i<30&&asr.active;i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(asr.active,false);assert.equal(asr.children.size,0);
  console.log('REAL_CANCEL_PARTIAL_NO_SUCCESS_AND_WORKER_EXIT_PASS');
  const bad=await run(Buffer.from('not an audio file'));assert(bad.some(e=>e.type==='error'));assert(!bad.some(e=>e.type==='result'));
  console.log('MALFORMED_AUDIO_FAILS_WITHOUT_SUCCESS_PASS');
} finally {bridge.close();}
