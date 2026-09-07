"""Append source-grounded Tinglan analysis without replacing human notes.

Called only by the loopback bridge, with server-resolved paths and an upload receipt.
Uses the daily-library's own manifest lock. Does not scan any other material.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile


def finalize(vault: Path, ingest, data: dict) -> dict:
    digest = data['sha256']
    if not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid source hash')
    note = (vault / data['note']).resolve()
    note.relative_to((vault / '03_日常资料' / '笔记').resolve())
    sources = {s['id']: s['text'] for s in data['sources']}
    if not sources:
        raise ValueError('No source evidence')
    for claim in data['analysis']['claims']:
        if not claim['evidence']:
            raise ValueError('Missing evidence')
        for evidence in claim['evidence']:
            if not evidence['quote'].strip() or evidence['quote'] not in sources.get(evidence['sourceId'], ''):
                raise ValueError('Evidence mismatch')
    payload = json.dumps({'sources': data['sources'], 'claims': data['analysis']['claims'], 'notFound': data['analysis']['notFound'], 'warnings': data.get('warnings', [])}, ensure_ascii=False, sort_keys=True)
    result_hash = hashlib.sha256(payload.encode('utf-8')).hexdigest()
    marker = f'<!-- TINGLAN_ANALYSIS_{result_hash} -->'
    # A fenced JSON evidence capsule preserves exact quotes and cannot introduce active Markdown.
    fence = '`' * max(4, 1 + max((len(m.group()) for m in re.finditer(r'`+', payload)), default=0))
    section = '\n\n' + marker + '\n## 听澜 · 有来源的学习笔记\n\n> 下列为机器识别与 Codex 分析；不是老师原始电子稿，也不是人工核验。日期保留原话，缺失项待确认。\n\n'
    for claim in data['analysis']['claims']:
        safe_text = claim['text'].replace('\n', ' ').replace('<', '&lt;').replace('>', '&gt;')
        section += f"- {safe_text}\n"
        if claim.get('due'):
            section += f"  - DDL 原话：{claim['due'].replace(chr(10), ' ')}\n"
    section += f'\n### 识别原文与证据快照\n\n{fence}json\n{payload}\n{fence}\n'
    with ingest.ExclusiveLock(ingest.lock_path(vault)):
        manifest = ingest.load_manifest(ingest.manifest_path(vault))
        item = manifest['items'].get(digest)
        if not item or item.get('note') != data['note']:
            raise ValueError('Receipt no longer matches manifest')
        original = (vault / item['original']).resolve()
        original.relative_to((vault / '03_日常资料' / '原件').resolve())
        if ingest.sha256_file(original) != digest:
            raise ValueError('Original no longer matches upload')
        before = note.read_bytes()
        text = before.decode('utf-8')
        if not re.search(r'^sha256:\s*[\"\x27]?' + digest + r'[\"\x27]?\s*$', text, re.M):
            raise ValueError('Note identity mismatch')
        if marker not in text:
            text += section
        # An uncertain extraction stays pending. Existing complete human notes are never downgraded.
        state = 'ready' if not data.get('warnings') else item.get('state', 'needs_visual')
        if state == 'ready':
            parts = text.split('---', 2)
            if len(parts) < 3:
                raise ValueError('Invalid note metadata')
            parts[1] = re.sub(r'^state:.*$', 'state: "ready"', parts[1], flags=re.M)
            text = '---'.join(parts)
            text = re.sub(r'^- 状态：[^\n]*$', '- 状态：ready', text, count=1, flags=re.M)
        if note.read_bytes() != before:
            raise RuntimeError('Note changed concurrently; retry')
        fd, temporary = tempfile.mkstemp(prefix='.tinglan-', suffix='.tmp', dir=note.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as handle:
                handle.write(text); handle.flush(); os.fsync(handle.fileno())
            if note.read_bytes() != before:
                raise RuntimeError('Note changed concurrently; retry')
            os.replace(temporary, note)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        if marker not in note.read_text(encoding='utf-8'):
            raise RuntimeError('Written analysis not found')
        # Already holding the same lock, so update the manifest here (do not deadlock by calling mark).
        if state == 'ready':
            item['state'] = 'ready'; item['ai_processed_at'] = ingest.now_iso()
        item['last_seen_at'] = ingest.now_iso(); manifest['updated_at'] = item['last_seen_at']
        ingest.atomic_write_json(ingest.manifest_path(vault), manifest)
    return {'sha256': digest, 'note': data['note'], 'state': state}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--vault', required=True); parser.add_argument('--ingest', required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('tinglan_daily_ingest', args.ingest)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module; spec.loader.exec_module(module)
    data = json.load(sys.stdin)
    print(json.dumps(finalize(Path(args.vault).resolve(), module, data), ensure_ascii=False))
