import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { DEFAULT_SETTINGS } from '../../src/types';
import { saveSettings } from '../../src/lib/db';
import '../../src/styles.css';
import '../../src/notta-theme.css';

// Only reachable from the dev test page (not in the production bundle).
// No ASR/model/network/result mocking: production App receives a genuine captured audio stream.
const chinese=new URLSearchParams(location.search).get('language')==='zh';
const file=chinese?'mandarin-classroom.wav':'english-classroom.wav';
const bytes=await (await fetch('/tests/runtime/fixtures/'+file)).arrayBuffer();
document.querySelector('#fixture-mode')!.textContent=chinese?'Chinese fixture loaded':'English fixture loaded';
await saveSettings({...DEFAULT_SETTINGS,recordingMode:chinese?'zh':'en-zh',sourceLanguage:chinese?'zh-CN':'en-US',targetLanguage:chinese?'':'zh-CN',aiProvider:'codex',aiProviderConfigured:true});
Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{
  const context=new AudioContext();await context.resume();
  const buffer=await context.decodeAudioData(bytes.slice(0));
  const destination=context.createMediaStreamDestination();
  const source=context.createBufferSource();source.buffer=buffer;source.loop=true;source.connect(destination);
  source.start(context.currentTime+1);
  const indicator=document.querySelector('#test-state')!;indicator.textContent='Actual WAV streaming to App microphone';
  setTimeout(()=>{source.stop();indicator.textContent='Fixture speech ended after 42 seconds; click App stop to test automatic final analysis.';},42000);
  destination.stream.getAudioTracks()[0].addEventListener('ended',()=>{void context.close();});
  return destination.stream;
}});
createRoot(document.querySelector('#root')!).render(<App/>);
