import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Icon } from '../../components/Icon';
import { DEFAULT_COURSE_ID, listMaterials, saveMaterial } from '../../lib/db';
import { formatClock } from '../../lib/format';
import type { Course, RecordingSession } from '../../types';
import { analyzeMaterial, buildSources, hashBlob, retrieveSources, studyRequest } from './client';
import { recordingSourceId, validateOriginal, type StudyAnalysis, type StudyClaim, type StudyMaterial, type StudySource } from './types';
import './study.css';
import { getVaultStatus, syncMaterialVault, type VaultStatus } from './vault';

const CATEGORY = { assignment: '作业', slides: '课件', reading: '阅读资料', notice: '课程通知', other: '其他资料' };
const CLAIM = { summary: '内容概要', assignment: '作业', exam: '考试', requirement: '具体要求', attention: '注意事项' };
const STATE = { stored: '已保存 · 待识别', extracting: '正在读图', analyzing: '正在整理', ready: '已理解', error: '待重试' };
interface Props {
  recordings: RecordingSession[]; courses: Course[]; disabled: boolean; visible: boolean;
  onOpenRecording: (id: string, atMs?: number) => void;
  onStageAudio: (files: File[], courseId?: string) => Promise<RecordingSession[]>;
  onAnalyzeAudio: (recording: RecordingSession, signal: AbortSignal) => Promise<void>;
  onCancelAudio: () => void;
  onAudioBatchEnd: (recordings: RecordingSession[]) => Promise<void>;
  cancelRef: RefObject<(() => void) | null>;
  revision: number;
  onBusy: (busy: boolean) => void;
  onNewCourse: () => void;
}

export function StudyLibrary({ recordings, courses, disabled, visible, onOpenRecording, onStageAudio, onAnalyzeAudio, onCancelAudio, onAudioBatchEnd, cancelRef, revision, onBusy, onNewCourse }: Props) {
  const [materials, setMaterials] = useState<StudyMaterial[]>([]), [course, setCourse] = useState('all');
  const [search, setSearch] = useState(''), [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [tab, setTab] = useState<'materials' | 'tasks'>('materials');
  const [answer, setAnswer] = useState<{ analysis: StudyAnalysis; sources: StudySource[]; covered: number; total: number; question: string }>();
  const [evidence, setEvidence] = useState<{ source: StudySource; quote: string }>();
  const [preview, setPreview] = useState('');
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>();
  const inputRef = useRef<HTMLInputElement>(null), abort = useRef<AbortController | null>(null), running = useRef(false);
  const itemsRef = useRef(materials); itemsRef.current = materials;
  useEffect(() => { if (visible && !running.current) void listMaterials().then(rows => setMaterials(rows.map(m => ['extracting', 'analyzing'].includes(m.state) ? { ...m, state: 'error', error: '上次处理已中断，原件和已识别文字保留，请重试。' } : m))).catch(e => setError(String(e))); }, [visible, courses, revision]);
  useEffect(() => { setAnswer(undefined); setEvidence(undefined); setSelected(null); setStatus(''); setError(''); }, [revision]);
  cancelRef.current = () => { abort.current?.abort(); onCancelAudio(); };
  useEffect(() => () => { abort.current?.abort(); cancelRef.current = null; }, [cancelRef]);
  useEffect(() => { if (visible) void getVaultStatus().then(setVaultStatus); }, [visible]);
  const courseOptions = [{ id: DEFAULT_COURSE_ID, name: '未分组' }, ...courses.filter(c => c.id !== DEFAULT_COURSE_ID)];
  const current = materials.find(m => m.id === selected);
  useEffect(() => { if (!current?.mimeType.startsWith('image/')) { setPreview(''); return; } const url = URL.createObjectURL(current.originalBlob); setPreview(url); return () => URL.revokeObjectURL(url); }, [current?.id, current?.originalBlob]);
  const scopedRecordings = recordings.filter(r => course === 'all' || r.courseId === course);
  const scopedMaterials = materials.filter(m => course === 'all' || m.courseId === course);
  const sources = useMemo(() => buildSources(scopedRecordings, scopedMaterials), [recordings, materials, course]);
  const put = async (m: StudyMaterial) => { await saveMaterial(m); itemsRef.current = [m, ...itemsRef.current.filter(x => x.id !== m.id)]; setMaterials(itemsRef.current); };
  const begin = () => { if (running.current || disabled) return false; running.current = true; setBusy(true); onBusy(true); setError(''); abort.current = new AbortController(); return true; };
  const finish = () => { running.current = false; setBusy(false); onBusy(false); abort.current = null; };

  async function processMaterial(original: StudyMaterial) {
    let m = { ...original, state: original.blocks.length ? 'analyzing' as const : 'extracting' as const, error: undefined, updatedAt: new Date().toISOString() };
    try {
      await put(m);
      const analysis = await analyzeMaterial(m, courses, abort.current!.signal, setStatus, async (blocks, warnings) => { m = { ...m, blocks, warnings, state: 'analyzing' }; await put(m); });
      const courseMatch = courses.find(c => c.name === analysis.courseName);
      const finished: StudyMaterial = { ...m, analysis, category: analysis.category, state: 'ready', courseId: !m.courseConfirmed && courseMatch ? courseMatch.id : m.courseId, updatedAt: new Date().toISOString() };
      await put(finished);
      if (vaultStatus?.configured && !abort.current?.signal.aborted) {
        try { setStatus('正在同步到本机学习资料库…'); const vault = await syncMaterialVault(finished, abort.current?.signal); await put({ ...finished, vault, vaultError: undefined }); }
        catch (e) { await put({ ...finished, vaultError: e instanceof Error ? e.message : '资料库同步待重试' }); }
      }
      setStatus(`已保存并整理：${m.fileName}`);
    } catch (e) {
      const message = abort.current?.signal.aborted ? '已取消处理，原件和已识别文字保留，可重试。' : e instanceof Error ? e.message : '识别失败，原件已保存。';
      await put({ ...m, state: 'error', error: message }).catch(() => {});
      setError(message);
    }
  }
  async function upload(files: File[]) {
    if (!begin()) return;
    const audios = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|webm|ogg|mp4)$/i.test(f.name));
    const ready: StudyMaterial[] = []; let rejected = 0, duplicate = 0;
    let stagedAudio: RecordingSession[] = [];
    try {
      stagedAudio = await onStageAudio(audios, course === 'all' ? undefined : course);
      // Save the entire selected batch before starting any AI calls.
      for (const file of files.filter(f => !audios.includes(f))) {
        try {
        const imageMime = /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.webp$/i.test(file.name) ? 'image/webp' : '';
        const mimeType = imageMime || (/\.(txt|md)$/i.test(file.name) ? 'text/plain' : '');
        if (!mimeType || file.size > (imageMime ? 8 * 1024 * 1024 : 600000) || !file.size) { rejected++; continue; }
        const sha256 = await hashBlob(file);
        const existing = itemsRef.current.find(m => m.sha256 === sha256);
        if (existing) { duplicate++; setSelected(existing.id); if (existing.state !== 'ready') ready.push(existing); continue; }
        const now = new Date().toISOString();
        const material: StudyMaterial = { id: `material-${crypto.randomUUID()}`, title: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, mimeType, originalBlob: file.slice(0, file.size, mimeType), sha256, createdAt: now, updatedAt: now, courseId: course === 'all' ? DEFAULT_COURSE_ID : course, courseConfirmed: course !== 'all', category: 'other', state: 'stored', blocks: [], warnings: [] };
        await validateOriginal(material);
        await put(material); setSelected(material.id); ready.push(material);
        } catch (e) { rejected++; setError(`${file.name} 未导入：${e instanceof Error ? e.message : '保存失败'}`); }
      }
      for (const material of ready) { if (abort.current?.signal.aborted) break; setStatus(`处理 ${material.fileName}（${ready.indexOf(material) + 1}/${ready.length}）`); await processMaterial(material); }
      for (const recording of stagedAudio) { if (abort.current?.signal.aborted) break; setStatus(`转写音频：${recording.title}`); try { await onAnalyzeAudio(recording, abort.current!.signal); } catch (e) { setError(`${recording.title} 处理未完成，原音频保留：${e instanceof Error ? e.message : '请重试'}`); } }
      if (rejected) setError(`${rejected} 个文件未导入：目前支持 PNG/JPG/WebP（每张 ≤8 MB）、TXT/MD（≤600 KB）和音频。不支持 PDF/Office。`);
      if (duplicate && !ready.length && !stagedAudio.length) setStatus(`${duplicate} 份重复资料已定位到原记录，未重复保存。`);
      else if (!abort.current?.signal.aborted) setStatus(`已保存 ${ready.length} 份图文、${stagedAudio.length} 段音频${duplicate ? `；${duplicate} 份重复图文未重复保存` : ''}。处理失败的条目保留，可重试。`);
    } catch (e) { setError(`保存未完成：${e instanceof Error ? e.message : e}`); }
    finally { try { await onAudioBatchEnd(stagedAudio); } catch (e) { setError(`批次状态保存失败，原音频未删除：${e instanceof Error ? e.message : e}`); } finally { finish(); } }
  }
  async function ask(query = question) {
    if (!query.trim() || !begin()) return;
    try {
      const retrieved = retrieveSources(sources, query);
      if (!retrieved.covered) throw new Error('当前范围还没有可引用的文字。请先完成录音转写或资料识别。');
      const analysis = await studyRequest<StudyAnalysis>('analyze', { query, courses: courses.map(c => c.name), sources: retrieved.selected.map(({ id, text, title }) => ({ id, text, title })) }, abort.current!.signal, setStatus);
      setAnswer({ analysis, sources: retrieved.selected, total: retrieved.total, covered: retrieved.covered, question: query });
      setStatus('回答已完成；点击每条结论下的来源核对。');
    } catch (e) { setError(e instanceof Error ? e.message : '查询失败'); }
    finally { finish(); }
  }
  function showEvidence(sourceId: string, quote: string, pool = sources) {
    const source = pool.find(s => s.id === sourceId);
    if (!source) { setError('原资料已被移除或不在当前范围，无法打开引用。'); return; }
    setEvidence({ source, quote });
    if (source.kind === 'material') setSelected(source.ownerId);
  }
  const claimCard = (claim: StudyClaim, pool = sources, prefix = '') => <article className="study-claim" key={`${prefix}${claim.id}`}>
    <div className="study-claim-heading"><span>{CLAIM[claim.category]}</span>{['assignment', 'exam'].includes(claim.category) && <strong className={claim.due ? 'study-due' : 'study-missing'}>{claim.due ? `DDL 原话：${claim.due}` : '此条未绑定 DDL · 请核对相关条目'}</strong>}</div>
    <p>{claim.text}</p>
    <div className="study-citations">{claim.evidence.map((e, i) => <button key={i} onClick={() => showEvidence(e.sourceId, e.quote, pool)}><Icon name="paperclip" />{pool.find(s => s.id === e.sourceId)?.title || '查看来源'}{pool.find(s => s.id === e.sourceId)?.atMs !== undefined ? ` · ${formatClock(pool.find(s => s.id === e.sourceId)!.atMs!)}` : ''}</button>)}</div>
  </article>;
  const recordingTasks: StudyClaim[] = scopedRecordings.flatMap(r => [...(r.classBrief?.sections.assignments ?? []).map(item => ({ item, category: 'assignment' as const })), ...(r.classBrief?.sections.examReading ?? []).map(item => ({ item, category: 'exam' as const }))].flatMap(({ item, category }) => {
    const source = sources.find(s => s.id === recordingSourceId(item.sourceRecordingId || r.id, item.sourceSegmentId || ''));
    return source ? [{ id: `${r.id}:${item.id}`, category, text: item.text, due: item.due && source.text.includes(item.due) ? item.due : null, evidence: [{ sourceId: source.id, quote: source.text }] }] : [];
  }));
  const tasks = [...scopedMaterials.flatMap(m => (m.analysis?.claims ?? []).filter(c => ['assignment', 'exam', 'requirement'].includes(c.category)).map(c => ({ ...c, id: `${m.id}:${c.id}` }))), ...recordingTasks];
  const filteredMaterials = scopedMaterials.filter(m => `${m.title} ${m.blocks.map(b => b.text).join(' ')} ${m.analysis?.claims.map(c => c.text).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const dateSources = answer?.sources.filter(s => /\b(?:deadline|due|next (?:week|monday|tuesday|wednesday|thursday|friday)|\d{1,2}\s*(?:am|pm))\b|截止|截至|星期|周[一二三四五六日天]|\d{1,2}月\d{1,2}/i.test(s.text)) ?? [];

  return <main id={visible ? 'main-content' : undefined} className="page study-page" hidden={!visible}>
    <header className="study-header"><div><p className="eyebrow">Study Library</p><h1>学习资料库</h1><p>把课堂原话、图片和作业放在一起。每个结论，都能回到出处。</p></div><button className="button primary" disabled={busy || disabled} onClick={() => inputRef.current?.click()}><Icon name="upload" />上传资料</button></header>
    <input ref={inputRef} aria-label="上传学习资料文件" type="file" hidden multiple accept="image/png,image/jpeg,image/webp,.txt,.md,audio/*,.mp3,.m4a,.wav,.webm,.ogg,.mp4" onChange={e => { const files = Array.from(e.target.files ?? []); e.currentTarget.value = ''; if (files.length) void upload(files); }} />
    <div className="study-toolbar"><label><Icon name="folder" /><select aria-label="学习库课程" value={course} disabled={busy} onChange={e => { setCourse(e.target.value); setAnswer(undefined); }}><option value="all">全部课程</option>{courseOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button className="text-button" disabled={busy} onClick={onNewCourse}>新建课程</button><label className="study-search"><Icon name="search" /><input aria-label="搜索学习资料" placeholder="搜索资料正文、作业或关键要求" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
    <p className="study-privacy">原件先保存到当前浏览器；图片和所选文字由 Codex 分析，使用你的 ChatGPT 订阅配额。图片识别可能有误，请核对原图。</p>
    <p className="study-privacy">{vaultStatus?.message ?? '正在检查本机学习资料库…'}{vaultStatus?.configured && ' · 新资料理解完成后自动归档。'}</p>
    {(status || error || busy) && <div className={`study-status ${error ? 'study-error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || status}</span>{busy && <button className="button secondary" onClick={() => cancelRef.current?.()}>取消处理</button>}</div>}
    <section className="study-question" aria-label="询问学习资料"><h2>问我的资料</h2><form onSubmit={e => { e.preventDefault(); void ask(); }}><input aria-label="学习资料问题" value={question} maxLength={4000} onChange={e => setQuestion(e.target.value)} placeholder="例如：英语课作业要交什么？截止日期在哪里？" /><button className="button primary" disabled={busy || disabled || !question.trim() || !sources.length}><Icon name="send" />查询</button></form><div className="study-suggestions">{['列出作业和截止时间', '考试安排与复习范围', '哪些要求需要向老师确认？'].map(q => <button key={q} disabled={busy || disabled || !sources.length} onClick={() => { setQuestion(q); void ask(q); }}>{q}</button>)}</div>
      {answer && <div className="study-answer"><h3>{answer.question}</h3><small>已核对 {answer.covered}/{answer.total} 个原文块 · {answer.analysis.model}{answer.covered < answer.total ? ' · 当前为检索子集，可按课程缩小范围' : ''} · 此次回答未修改已有纪要</small>{answer.analysis.claims.map(c => claimCard(c, answer.sources, 'answer-'))}{answer.analysis.notFound.map((t, i) => <p className="study-missing" key={i}>当前所选证据未回答：{t}</p>)}</div>}
      {!!dateSources.length && <details className="study-transcription"><summary>日期原话核对 · {dateSources.length} 个线索（未自动确认归属）</summary><p>直接列出所选证据中的时间线索，避免只看 AI 摘要时漏掉单独一行的截止时间。请结合对应作业核对。</p>{dateSources.slice(0, 30).map(source => <article key={source.id}><blockquote>{source.text}</blockquote><button className="text-button" onClick={() => showEvidence(source.id, source.text, answer!.sources)}>查看来源 · {source.title}</button></article>)}{dateSources.length > 30 && <p>此处显示前 30 个线索，请缩小课程范围继续查询。</p>}</details>}
    </section>
    <div className="study-tabs" role="tablist" aria-label="学习库视图"><button role="tab" aria-selected={tab === 'materials'} onClick={() => setTab('materials')}>资料 <span>{scopedMaterials.length + scopedRecordings.length}</span></button><button role="tab" aria-selected={tab === 'tasks'} onClick={() => setTab('tasks')}>作业与考试 <span>{tasks.length}</span></button></div>
    {tab === 'tasks' ? <section className="study-task-list">{tasks.length ? tasks.filter(c => c.text.toLowerCase().includes(search.toLowerCase())).map(c => claimCard(c)) : <div className="study-empty"><Icon name="calendar" /><h2>还没有有来源的作业或考试要求</h2><p>上传任务截图，或先完成课堂录音的 AI 纪要。没有写明的日期不会被自动补出。</p></div>}</section> : <div className="study-grid"><section className="study-materials" aria-label="资料列表">
      {!scopedMaterials.length && !scopedRecordings.length && <div className="study-empty"><Icon name="library" /><h2>从一张作业截图开始</h2><p>支持批量图片、文字和音频。原件先保存，再逐份识别与分类。</p><button className="button secondary" disabled={busy || disabled} onClick={() => inputRef.current?.click()}>选择学习资料</button></div>}
      {filteredMaterials.map(m => <button className={`study-material-row ${selected === m.id ? 'selected' : ''}`} key={m.id} onClick={() => { setSelected(m.id); setEvidence(undefined); }}><Icon name={m.mimeType.startsWith('image/') ? 'note' : 'library'} /><div><strong>{m.title}</strong><small>{CATEGORY[m.category]} · {courses.find(c => c.id === m.courseId)?.name ?? '未分组'}</small></div><span className={m.state === 'error' ? 'study-missing' : ''}>{STATE[m.state]}</span></button>)}
      {scopedRecordings.filter(r => `${r.title} ${r.segments.map(s => s.source).join(' ')} ${r.classBrief?.overview || ''} ${JSON.stringify(r.classBrief?.sections || {})}`.toLowerCase().includes(search.toLowerCase())).map(r => <button className="study-material-row" key={r.id} onClick={() => onOpenRecording(r.id)}><Icon name="mic" /><div><strong>{r.title}</strong><small>{formatClock(r.durationMs)} · {r.segments.length} 段原文</small></div><span>打开录音</span></button>)}
    </section><section className="study-detail" aria-label="资料原件和笔记">{current ? <><div className="study-detail-heading"><h2>{current.title}</h2><select aria-label="修改资料课程" value={current.courseId} disabled={busy || disabled} onChange={e => void put({ ...current, courseId: e.target.value, courseConfirmed: true, updatedAt: new Date().toISOString() }).catch(e => setError(String(e)))}>{courseOptions.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></div>
      {preview && <a href={preview} target="_blank" rel="noreferrer" title="打开原图核对"><img className="study-original" src={preview} alt={`${current.fileName} 原图`} /></a>}
      {current.error && <p role="alert" className="study-missing">{current.error}</p>}{current.warnings.map((w, i) => <p className="study-missing" key={i}>{w}</p>)}
      <button className="button secondary" disabled={busy || disabled} onClick={() => { if (begin()) void processMaterial(current).finally(finish); }}><Icon name="wand" />{current.analysis ? '重新整理已识别文字' : '识别并生成笔记'}</button>
      {current.vault && <p className="study-privacy">本机资料库：{current.vault.state === 'ready' ? '已归档原件和笔记' : '原件已归档 · 识别疑点待核对'}<br />{current.vault.note}</p>}
      {current.vaultError && <p className="study-missing">归档待重试：{current.vaultError}</p>}
      {current.analysis && vaultStatus?.configured && <button className="button secondary" disabled={busy || disabled} onClick={() => { if (!begin()) return; void syncMaterialVault(current, abort.current!.signal).then(vault => put({ ...current, vault, vaultError: undefined })).catch(e => setError(e instanceof Error ? e.message : '同步失败')).finally(finish); }}><Icon name="folder" />同步到本机学习资料库</button>}
      {current.analysis?.claims.map(c => claimCard(c))}{current.analysis?.notFound.map((t, i) => <p className="study-missing" key={i}>待确认：{t}</p>)}
      <details className="study-transcription"><summary>识别原文 · {current.blocks.length} 个文字块</summary>{current.blocks.map(b => <p key={b.id}>{b.uncertain && <strong>识别存疑 · </strong>}{b.text}</p>)}</details>
    </> : <div className="study-empty"><Icon name="paperclip" /><h2>资料和结论并排核对</h2><p>选择一份资料，查看原件、识别文字和带引用的笔记。</p></div>}</section></div>}
    {evidence && <section className="study-evidence" aria-label="证据原文"><header><h2>{evidence.source.title}</h2><button aria-label="关闭证据" onClick={() => setEvidence(undefined)}><Icon name="close" /></button></header><blockquote>{evidence.quote}</blockquote>{evidence.source.uncertain && <p className="study-missing">这一块的识别存在不确定性，请核对原图。</p>}{evidence.source.kind === 'recording' && <button className="button primary" onClick={() => onOpenRecording(evidence.source.ownerId, evidence.source.atMs)}><Icon name="play" />回听 {formatClock(evidence.source.atMs ?? 0)}</button>}<small>这是机器识别的原文引用，不是人工核验结论。</small></section>}
  </main>;
}
