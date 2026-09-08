import assert from 'node:assert/strict';
import { readFileSync, openSync, writeSync, closeSync, mkdirSync, openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AsrService } from '../../server/asr.mjs';

// Two-hour WAV, 24 declared synthetic speech bursts, each at the END of a five-minute block.
// This tests full-file duration/timestamps/PCM bounds; it is not a dense two-hour speech accuracy claim.
const original = readFileSync(new URL('./fixtures/english-classroom.wav',import.meta.url));
let format,pcm;
for(let at=12;at+8<=original.length;) {
  const id=original.toString('ascii',at,at+4),size=original.readUInt32LE(at+4);
  if(id==='fmt ')format=original.subarray(at+8,at+8+size);
  if(id==='data')pcm=original.subarray(at+8,at+8+size);
  at+=8+size+(size%2);
}
assert.equal(format.readUInt16LE(0),1);
const rateBytes=format.readUInt32LE(8),total=7200*rateBytes;
const riff=Buffer.alloc(12);riff.write('RIFF');riff.writeUInt32LE(4+8+format.length+8+total,4);riff.write('WAVE',8);
const fmt=Buffer.alloc(8);fmt.write('fmt ');fmt.writeUInt32LE(format.length,4);
const data=Buffer.alloc(8);data.write('data');data.writeUInt32LE(total,4);
mkdirSync('.runtime',{recursive:true});const path=join('.runtime','synthetic-two-hour-sparse.wav');
const fd=openSync(path,'w');
try { for(const buffer of [riff,fmt,format,data])writeSync(fd,buffer);
  const silence=Buffer.alloc(300*rateBytes-pcm.length);
  for(let i=0;i<24;i++){writeSync(fd,silence);writeSync(fd,pcm);}
} finally {closeSync(fd);}
const asr=new AsrService(),controller=new AbortController();
const events=[];let lastCheckpoint=-1;
try {
  const blob=await openAsBlob(path);const request=Readable.fromWeb(blob.stream());
  const result=await asr.transcribe(request,'en',event=>{
    if(event.type==='segment')events.push(event.segment);
    const checkpoint=Math.floor((event.processedMs||0)/600000);
    if(event.type==='progress'&&checkpoint>lastCheckpoint){lastCheckpoint=checkpoint;console.log(JSON.stringify({minute:checkpoint*10,segments:events.length,parentRss:process.memoryUsage().rss}));}
  },controller.signal);
  assert.equal(result.durationMs,7200000);assert(result.maxBufferedSamples<=1024000);
  assert(events.some(s=>s.startMs>=7180000),'last speech survives final window');
  assert(events.every(s=>s.startMs>=0&&s.endMs<=7200000));
  console.log(JSON.stringify({gate:'TWO_HOUR_SPARSE_NATIVE_ASR_PASS',result,first:events[0],last:events.at(-1),speechBursts:24}));
} finally {asr.close();}
