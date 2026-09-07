import { decodeAudioTo16k } from '../../lib/audio';
import type { ModelProgress, RecordingSession, TranscriptSegment } from '../../types';

export async function transcribeRecording(recording: RecordingSession, model: 'tiny' | 'base', progress: (value: ModelProgress) => void, signal?: AbortSignal): Promise<TranscriptSegment[]> {
  if (!recording.audioBlob) throw new Error('这条记录没有音频，无法转写');
  if (signal?.aborted) throw new Error('已取消，录音仍然保留');
  progress({label:'正在解码音频',state:'working'});
  const audio = await decodeAudioTo16k(recording.audioBlob);
  if (signal?.aborted) throw new Error('已取消，录音仍然保留');
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL('../../workers/transcription.worker.ts', import.meta.url), {type:'module'});
    let settled = false;
    const cleanup = () => { clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort',cancel); };
    const fail = (message:string) => { if(settled)return; settled=true; cleanup(); reject(new Error(message)); };
    const cancel = () => fail('已取消，录音和已有文字已保留');
    const timer = setTimeout(() => fail('转写超时，录音已保留。可检查网络、改用 Tiny 或分段后重试。'),Math.max(600_000,recording.durationMs * 3));
    signal?.addEventListener('abort',cancel,{once:true});
    worker.onerror = event => fail(event.message || '转写引擎加载失败，请重新打开应用后重试');
    worker.onmessage = (event:MessageEvent<Record<string,unknown>>) => {
      const message=event.data;
      if(message.type==='progress'||message.type==='working') {
        progress({label:String(message.label??'正在转写'),state:message.type==='working'?'working':'downloading',progress:typeof message.progress==='number'?message.progress:undefined}); return;
      }
      if(message.type==='error') { fail(String(message.message??'转写失败')); return; }
      if(message.type!=='result'||settled)return;
      const result=message.result as {text?:string,chunks?:Array<{text:string,timestamp:[number,number|null]}>};
      const chunks=result.chunks?.filter(chunk=>chunk.text.trim())??[];
      if(!chunks.length && !result.text?.trim()) {fail('没有识别到清晰语音，录音仍然保留');return;}
      const segments:TranscriptSegment[]=chunks.length?chunks.map(chunk=>({id:crypto.randomUUID(),startMs:Math.max(0,chunk.timestamp[0]*1000),endMs:Math.max(chunk.timestamp[0]*1000,(chunk.timestamp[1]??chunk.timestamp[0]+3)*1000),speaker:'讲师',source:chunk.text.trim(),translation:''})):[{id:crypto.randomUUID(),startMs:0,endMs:recording.durationMs,speaker:'讲师',source:result.text!.trim(),translation:''}];
      settled=true; cleanup(); resolve(segments);
    };
    worker.postMessage({type:'transcribe',audio,model,sourceLanguage:recording.sourceLanguage},[audio.buffer]);
  });
}
