import { transcribeRecording } from '../../src/features/workflow/transcribe';
import type { RecordingSession } from '../../src/types';
const params=new URLSearchParams(location.search);
const english=params.get('lang')==='en';
const started=performance.now();
const blob=await(await fetch(english?'/tests/runtime/fixtures/english-classroom.wav':'./fixtures/mandarin-exam.wav')).blob();
const recording:RecordingSession={id:'quality-test',title:'Synthetic acceptance',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),durationMs:20000,status:'complete',analysisStatus:'idle',recordingMode:english?'en-zh':'zh',sourceLanguage:english?'en-US':'zh-CN',targetLanguage:english?'zh-CN':'',segments:[],notes:[],bookmarks:[],keyMessages:[],audioBlob:blob};
try{
  const segments=await transcribeRecording(recording,'base',p=>{document.querySelector('#progress')!.textContent=p.label+' '+(p.progress??'');});
  document.querySelector('#progress')!.textContent='PASS: '+segments.length+' segments';
  document.querySelector('#result')!.textContent=JSON.stringify({seconds:(performance.now()-started)/1000,segments},null,2);
}catch(error){document.querySelector('#progress')!.textContent='FAIL';document.querySelector('#result')!.textContent=String(error);}
