import type { RecordingSession } from '../../src/types';

// Real IndexedDB, only the database name is redirected. No production records are touched.
const databaseName='tinglan-persistence-test-'+crypto.randomUUID();
const realOpen=indexedDB.open.bind(indexedDB);
indexedDB.open=((name:string,version?:number)=>realOpen(name==='tinglan-local'?databaseName:name,version)) as typeof indexedDB.open;
const db=await import('../../src/lib/db');
const rows:string[]=[];
const assert=(ok:unknown,label:string)=>{if(!ok)throw new Error(label);rows.push('PASS '+label);};
const at=new Date().toISOString();
const sample:RecordingSession={id:'test-a',title:'original',createdAt:at,updatedAt:at,durationMs:1000,status:'complete',analysisStatus:'ready',recordingMode:'zh',sourceLanguage:'zh-CN',targetLanguage:'',segments:[],notes:[],bookmarks:[],keyMessages:[],audioBlob:new Blob(['fixture'],{type:'audio/wav'})};
try{
  const first=db.saveRecording(sample);sample.title='mutation after enqueue';await first;
  assert((await db.getRecording(sample.id))?.title==='original','save snapshots at enqueue, not async execution');
  const older=db.saveRecording({...sample,title:'older'});
  const newer=db.saveRecording({...sample,title:'newer',notes:[{id:'n1',atMs:0,text:'keep this note'}]});
  await Promise.all([older,newer]);
  assert((await db.getRecording(sample.id))?.notes[0]?.text==='keep this note','ordered saves retain newest notes');
  const pendingSave=db.saveRecording(sample);const pendingDelete=db.deleteRecording(sample.id);
  await Promise.all([pendingSave,pendingDelete]);
  assert(!(await db.getRecording(sample.id)),'delete waits for prior saves and does not resurrect a record');
  const course=await db.createCourse({name:'Synthetic course'});
  const courseSave=db.saveRecording({...sample,courseId:course.id});const courseDelete=db.deleteCourse(course.id);
  await Promise.all([courseSave,courseDelete]);
  assert((await db.getRecording(sample.id))?.courseId===db.DEFAULT_COURSE_ID,'course removal waits for saves and preserves audio in default group');
  assert((await db.getRecording(sample.id))?.audioBlob?.size===7,'course removal preserves Blob bytes');
  const finalSave=db.saveRecording(sample);const clear=db.clearLocalData();
  await Promise.all([finalSave,clear]);
  assert((await db.listRecordings()).length===0,'clear waits for earlier saves');
  document.querySelector('#result')!.textContent=rows.join('\n')+'\nALL '+rows.length+' PASS\nIsolated database: '+databaseName;
}catch(error){document.querySelector('#result')!.textContent=rows.join('\n')+'\nFAIL '+String(error);}
