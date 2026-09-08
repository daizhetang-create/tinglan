import { openDatabase, beginCaptureJournal, appendCaptureChunk, finishCaptureJournal, recoverCaptureJournals, deleteRecording, clearLocalData, discardEmptyCaptureJournal } from '../../src/lib/db';
import { acquireWorkspaceLock } from '../../src/features/recorder/workspaceLock';
import { readLocalSnapshot, serializeBackup, parseBackup } from '../../src/features/storage/backup';
import type { RecordingSession } from '../../src/types';

const result = document.querySelector<HTMLPreElement>('#result')!;
const checks: string[] = [];
const at = '2026-09-08T00:00:00.000Z';
const session = (id: string): RecordingSession => ({ id, title: 'Synthetic capture', createdAt: at, updatedAt: at,
  status: 'recording', durationMs: 0, analysisStatus: 'idle', recordingMode: 'en-zh', sourceLanguage: 'en-US',
  targetLanguage: 'zh-CN', courseId: 'course-unfiled', segments: [], notes: [], bookmarks: [], keyMessages: [] });
function assert(ok: unknown, message: string) { if (!ok) throw new Error(message); checks.push('PASS ' + message); result.textContent = checks.join('\n'); }
async function read(name: string) { return (await readLocalSnapshot(name)).recordings; }
async function chunk(name: string, id: string, sequence: number) {
  await appendCaptureChunk({ recordingId: id, sequence, blob: new Blob([`${sequence},`]), elapsedMs: (sequence + 1) * 1000 }, name);
}
async function count(name: string, store: string) {
  const db = await openDatabase(name);
  try { return await new Promise<number>((resolve, reject) => { const req = db.transaction(store).objectStore(store).count(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
  finally { db.close(); }
}
document.querySelector('#run')!.addEventListener('click', async () => {
  const name = 'tinglan-journal-test-' + crypto.randomUUID();
  try {
    let db = await openDatabase(name); assert(db.version === 4, 'v4 stores created'); db.close();
    await beginCaptureJournal(session('twelve'), 'audio/webm', name);
    for (let i = 0; i < 12; i++) await chunk(name, 'twelve', i);
    assert(await count(name, 'captureChunks') === 12, '12 chunks committed before stop');
    assert(!(await read(name))[0].audioBlob, 'unfinished capture not falsely finalized');
    assert(await recoverCaptureJournals(name) === 1, 'orphan capture recovered');
    const restored = (await read(name))[0];
    assert(await restored.audioBlob!.text() === '0,1,2,3,4,5,6,7,8,9,10,11,', 'numeric ordering and original bytes');
    assert(restored.durationMs === 12000 && restored.analysisStatus === 'error', 'recovered duration and explicit retry state');
    assert(restored.analysisError?.includes('最后未写入'), 'partial tail warning disclosed');
    assert(await count(name, 'captureChunks') === 0 && await count(name, 'captureSessions') === 0, 'finalized journal removed atomically');
    assert(await recoverCaptureJournals(name) === 0, 'recovery idempotent');
    const backup = await parseBackup(await serializeBackup(await readLocalSnapshot(name)));
    assert(await backup.recordings[0].audioBlob!.text() === await restored.audioBlob!.text(), 'recovered original survives existing backup format');

    await beginCaptureJournal(session('zero'), 'audio/webm', name); await recoverCaptureJournals(name);
    assert(!(await read(name)).find(r => r.id === 'zero')!.audioBlob, 'zero chunks never invent audio');
    await beginCaptureJournal(session('gap'), 'audio/webm', name); await chunk(name, 'gap', 0); await chunk(name, 'gap', 2);
    await recoverCaptureJournals(name);
    const gap = (await read(name)).find(r => r.id === 'gap')!;
    assert(await gap.audioBlob!.text() === '0,' && gap.analysisError?.includes('不连续'), 'missing sequence yields warned prefix, not corrupt concatenation');
    assert(await count(name, 'captureChunks') === 2, 'noncontiguous evidence retained');
    await recoverCaptureJournals(name);
    assert(await count(name, 'captureChunks') === 2, 'repeat recovery preserves conflict evidence');

    await beginCaptureJournal(session('final'), 'audio/webm', name); await chunk(name, 'final', 0);
    const final = { ...session('final'), status: 'complete' as const, audioBlob: new Blob(['final-original']), audioMimeType: 'audio/webm' };
    await finishCaptureJournal(final, name);
    assert(await (await read(name)).find(r => r.id === 'final')!.audioBlob!.text() === 'final-original', 'normal stop saves full original');
    // Simulate a stale journal left alongside a committed recording without replacing the recording.
    db = await openDatabase(name);
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('captureSessions', 'readwrite'); tx.objectStore('captureSessions').add({ id: 'final', recording: session('final'), mimeType: 'audio/webm' }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    await chunk(name, 'final', 0); await recoverCaptureJournals(name);
    assert(await (await read(name)).find(r => r.id === 'final')!.audioBlob!.text() === 'final-original', 'stale journal never overwrites finalized original');
    await deleteRecording('gap', name);
    assert(!(await read(name)).some(r => r.id === 'gap'), 'delete removes recovered record');
    assert(await count(name, 'captureChunks') === 1, 'delete also removes only owned journal chunks');
    await clearLocalData(name); await recoverCaptureJournals(name);
    assert((await read(name)).length === 0 && await count(name, 'captureChunks') === 0, 'clear cannot resurrect orphan recordings');

    await beginCaptureJournal(session('retry-empty'), 'audio/webm', name);
    await discardEmptyCaptureJournal('retry-empty', name);
    await beginCaptureJournal(session('retry-empty'), 'audio/webm', name);
    assert(await count(name,'captureSessions')===1, 'empty failed start can safely retry');
    await chunk(name,'retry-empty',0); await discardEmptyCaptureJournal('retry-empty',name);
    assert(await count(name,'captureSessions')===1, 'empty cleanup cannot discard saved audio');
    const latest = {...session('retry-empty'),title:'Edited during stop',notes:[{id:'note-late',atMs:500,text:'Keep handwritten note'}],
      transcriptionDraft:{segments:[{id:'draft-1',startMs:0,endMs:1000,source:'draft',translation:'',speaker:'讲师'}],updatedAt:at}};
    db=await openDatabase(name);
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('recordings','readwrite');tx.objectStore('recordings').put(latest);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
    const merged=await finishCaptureJournal({...session('retry-empty'),status:'complete',audioBlob:new Blob(['whole-audio'])},name);
    assert(merged.title===latest.title&&merged.notes[0].id==='note-late','finalization preserves latest title and handwritten note');
    const withDraft=await parseBackup(await serializeBackup(await readLocalSnapshot(name)));
    assert(withDraft.recordings.find(r=>r.id==='retry-empty')?.transcriptionDraft?.segments[0].source==='draft','partial draft survives full backup without replacing formal transcript');

    await beginCaptureJournal(session('atomic-abort'),'audio/webm',name);await chunk(name,'atomic-abort',0);
    const transaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(...args:Parameters<typeof transaction>){
      const tx=transaction.apply(this,args);
      if(this.name===name && Array.isArray(args[0]) && args[0].includes('captureChunks') && args[1]==='readwrite') queueMicrotask(()=>tx.abort());
      return tx;
    } as typeof transaction;
    let aborted=false;
    try {await finishCaptureJournal({...session('atomic-abort'),status:'complete',audioBlob:new Blob(['not committed'])},name);} catch {aborted=true;}
    finally {IDBDatabase.prototype.transaction=transaction;}
    assert(aborted&&await count(name,'captureChunks')===1,'injected transaction abort retains recovery chunks');
    assert(!(await read(name)).find(r=>r.id==='atomic-abort')?.audioBlob,'aborted finalization does not pretend original was committed');

    const legacyName=name+'-v3';
    const legacy=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(legacyName,3);request.onupgradeneeded=()=>{for(const store of ['recordings','courses','settings','materials'])request.result.createObjectStore(store,{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise<void>((resolve,reject)=>{const tx=legacy.transaction('recordings','readwrite');tx.objectStore('recordings').put({...session('legacy'),status:'complete',audioBlob:new Blob(['old-v3-original'])});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});legacy.close();
    const upgraded=await openDatabase(legacyName);assert(upgraded.version===4,'v3 upgrades to v4');upgraded.close();
    assert(await (await read(legacyName))[0].audioBlob!.text()==='old-v3-original','v3 original bytes survive migration');
    indexedDB.deleteDatabase(legacyName);

    const lockName = name + '-lock';
    const release = await acquireWorkspaceLock(lockName);
    assert(Boolean(release) && await acquireWorkspaceLock(lockName) === null, 'live workspace cannot be acquired twice');
    release!(); await new Promise(resolve => setTimeout(resolve, 0));
    const next = await acquireWorkspaceLock(lockName); assert(Boolean(next), 'released workspace can be acquired'); next!();
    result.textContent = checks.join('\n') + `\nALL ${checks.length} CHECKS PASSED`; result.dataset.status = 'pass';
  } catch (error) { result.textContent = checks.join('\n') + '\nFAIL ' + String(error); result.dataset.status = 'fail'; }
  finally { indexedDB.deleteDatabase(name); }
});

document.querySelector('#capture')!.addEventListener('click', async () => {
  const name = 'tinglan-journal-real-' + crypto.randomUUID();
  const recording = session('actual-media-recorder');
  const context = new AudioContext(); await context.resume();
  const audio = await context.decodeAudioData(await (await fetch('./fixtures/english-classroom.wav')).arrayBuffer());
  const destination = context.createMediaStreamDestination();
  const source = context.createBufferSource(); source.buffer = audio; source.loop = true; source.connect(destination);
  const recorder = new MediaRecorder(destination.stream);
  await beginCaptureJournal(recording, recorder.mimeType, name);
  let writes = Promise.resolve(), sequence = 0;
  const start = performance.now();
  recorder.ondataavailable = event => { if (event.data.size) { const item = { recordingId: recording.id, sequence: sequence++, blob: event.data, elapsedMs: performance.now() - start }; writes = writes.then(() => appendCaptureChunk(item, name)); } };
  recorder.start(1000); source.start(); result.textContent = 'Recording actual speech and saving chunks; reload in 9 seconds without finalizing.';
  setTimeout(async () => {
    recorder.pause(); await writes;
    // Deliberately do NOT call stop/finalize: the next page must recover a genuinely incomplete container.
    location.replace('./journal-smoke.html?recover=' + encodeURIComponent(name));
  }, 9000);
});

const recoveryName = new URLSearchParams(location.search).get('recover');
if (recoveryName?.startsWith('tinglan-journal-real-')) {
  try {
    assert(await recoverCaptureJournals(recoveryName) === 1, 'real MediaRecorder journal recovered after navigation');
    const recording = (await read(recoveryName))[0];
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(await recording.audioBlob!.arrayBuffer());
    assert(decoded.duration >= 6 && decoded.duration <= 10, 'recovered incomplete WebM is actually decodable, duration=' + decoded.duration.toFixed(3));
    await context.close();
    document.querySelector<HTMLAudioElement>('#audio')!.src = URL.createObjectURL(recording.audioBlob!);
    result.textContent = checks.join('\n') + '\nREAL CAPTURE RECOVERY PASSED'; result.dataset.status = 'pass';
  } catch (error) { result.textContent += '\nFAIL ' + String(error); result.dataset.status = 'fail'; }
}
