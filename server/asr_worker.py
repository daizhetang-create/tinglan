"""Local-only, bounded PCM transcription. Never downloads a model implicitly."""
import argparse
import base64
import json
import os
import re
import sys
import time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from asr_quality import quality_reason

RATE = 16000
CORE = 60 * RATE
CONTEXT = 2 * RATE
MAX_SAMPLES = 4 * 3600 * RATE
_model = None


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(cached_model(), device='cpu', compute_type='int8',
            cpu_threads=min(4, os.cpu_count() or 2), num_workers=1, local_files_only=True)
    return _model


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


class WindowBuffer:
    """At most 64 seconds of mono PCM, independent of recording length."""
    def __init__(self, np):
        self.np = np
        self.buffer = np.empty(CORE + 2 * CONTEXT, dtype=np.float32)
        self.start = self.end = self.core_start = 0
        self.peak = 0

    def feed(self, samples):
        offset = 0
        while offset < len(samples):
            target = self.core_start + CORE + CONTEXT
            count = min(len(samples) - offset, target - self.end)
            size = self.end - self.start
            self.buffer[size:size + count] = samples[offset:offset + count]
            self.end += count
            offset += count
            self.peak = max(self.peak, self.end - self.start)
            if self.end > MAX_SAMPLES:
                raise ValueError('音频超过 4 小时，请分段处理；已生成文字保留。')
            if self.end == target:
                yield self.window(False)
                self.advance()

    def window(self, final):
        return (self.buffer[:self.end - self.start].copy(), self.start,
                self.core_start, min(self.end, self.core_start + CORE), final)

    def advance(self):
        self.core_start += CORE
        keep = min(self.end, max(0, self.core_start - CONTEXT))
        count = self.end - keep
        self.buffer[:count] = self.buffer[keep - self.start:self.end - self.start]
        self.start = keep

    def finish(self):
        while self.core_start < self.end:
            yield self.window(True)
            self.advance()


def token(word):
    return re.sub(r'[^\w]', '', word['text'].casefold())


class WordStitcher:
    """Delay boundary words until both contexts are available. Never globally deduplicate."""
    def __init__(self):
        self.pending = []
        self.uncertain = 0

    def accept(self, words, core_start, core_end, final=False):
        if self.pending:
            if not words:
                words = self.pending
                cutoff = core_end if final else max(core_start, core_end - 2)
                ready = [w for w in words if (w['start']+w['end'])/2 < cutoff]
                self.pending = [] if final else [w for w in words if (w['start']+w['end'])/2 >= cutoff]
                return ready
            best = None
            for i, old in enumerate(self.pending):
                for j, new in enumerate(words):
                    if abs(old['start'] - new['start']) > 1.2 or not token(old) or token(old) != token(new):
                        continue
                    n = 1
                    while n < 6 and i+n < len(self.pending) and j+n < len(words) and token(self.pending[i+n]) == token(words[j+n]):
                        n += 1
                    rank = (n, -abs(old['start'] - core_start))
                    if best is None or rank > best[0]:
                        best = (rank, i, j, n)
            if best:
                _, i, j, n = best
                words = self.pending[:i+n] + words[j+n:]
            else:
                if self.pending and words and self.pending[-1]['end'] > core_start - 1 and words[0]['start'] < core_start + 1:
                    self.uncertain += 1
                # Keep the previously recognized seam as a whole when no shared anchor exists.
                # Filtering both sides at the core boundary can silently drop drifted words.
                seam_end = self.pending[-1]['end']
                words = self.pending + [w for w in words if w['start'] >= seam_end]
        cutoff = core_end if final else max(core_start, core_end - 2)
        ready = [w for w in words if (w['start']+w['end'])/2 < cutoff]
        self.pending = [] if final else [w for w in words if (w['start']+w['end'])/2 >= cutoff]
        return ready


def cached_model():
    from faster_whisper.utils import download_model
    return download_model('small', local_files_only=True)


def transcribe(path, language):
    import av
    import numpy as np
    emit({'type': 'progress', 'message': '正在加载本机 Small 精校模型（不上传音频）'})
    model = get_model()
    window = WindowBuffer(np)
    stitcher = WordStitcher()
    count = 0
    rejected = 0
    last_end = 0.0
    began = time.monotonic()

    def process(item):
        nonlocal count, last_end, rejected
        audio, start, core_start, core_end, eof = item
        # At EOF the penultimate core may still have a tiny final core to follow.
        final = eof and core_end == window.end
        emit({'type': 'progress', 'processedMs': core_start/RATE*1000, 'message': '本机分窗精校 · %.0f–%.0f 秒' % (core_start/RATE, core_end/RATE)})
        segments, _ = model.transcribe(audio, language=language, beam_size=3, word_timestamps=True,
            condition_on_previous_text=False, temperature=(0.0, 0.2),
            hallucination_silence_threshold=1.0, max_new_tokens=400,
            vad_filter=True, vad_parameters={'min_silence_duration_ms': 400})
        words = []
        for segment in segments:
            reason = quality_reason(segment.text)
            if reason:
                rejected += 1
                emit({'type': 'quality-warning', 'reason': reason,
                      'startMs': round((start/RATE + segment.start)*1000),
                      'endMs': round((start/RATE + segment.end)*1000),
                      'message': '一段异常识别已拦截，请结合原音频核对；未把乱码写入字幕。'})
                continue
            for word in segment.words or []:
                a, b = start/RATE + word.start, min(window.end/RATE, start/RATE + word.end)
                if b > a and word.word.strip():
                    words.append({'start': max(0, a), 'end': b, 'text': word.word})
        ready = stitcher.accept(words, core_start/RATE, core_end/RATE, final)
        # Compact readable groups, retaining native word timestamps and original spacing.
        group = []
        def flush():
            nonlocal count, last_end, group
            if not group:
                return
            text = ''.join(w['text'] for w in group).strip()
            a, b = max(last_end, group[0]['start']), group[-1]['end']
            if text and b > a:
                emit({'type': 'segment', 'segment': {'startMs': round(a*1000), 'endMs': round(b*1000), 'source': text}})
                count += 1
                last_end = b
            group = []
        for word in ready:
            if group and (word['end'] - group[0]['start'] > 12 or word['start'] - group[-1]['end'] > 1.5):
                flush()
            group.append(word)
            if re.search(r'[。！？.!?]$', word['text'].strip()):
                flush()
        flush()
        emit({'type': 'progress', 'processedMs': core_end/RATE*1000, 'message': '已保存 %.0f 秒范围的精校文字' % (core_end/RATE)})

    with av.open(path) as container:
        if not container.streams.audio:
            raise ValueError('文件中没有音轨。')
        stream = container.streams.audio[0]
        stream.thread_type = 'NONE'
        resampler = av.AudioResampler(format='fltp', layout='mono', rate=RATE)
        expected_time = None
        for frame in container.decode(stream):
            if frame.samples > 2_000_000 or len(frame.layout.channels) > 8 or frame.sample_rate > 192000:
                raise ValueError('音频参数异常，请转换为常规 WAV/MP3 后重试。')
            if frame.time is not None and expected_time is not None and abs(frame.time - expected_time) > 0.5:
                raise ValueError('音频时间轴不连续；已生成文字保留，请转换文件后核对时间戳。')
            if frame.time is not None:
                expected_time = frame.time + frame.samples/frame.sample_rate
            for converted in resampler.resample(frame):
                for item in window.feed(converted.to_ndarray().reshape(-1)):
                    process(item)
        for converted in resampler.resample(None):
            for item in window.feed(converted.to_ndarray().reshape(-1)):
                process(item)
        for item in window.finish():
            process(item)
    if not count:
        raise ValueError('没有识别到清晰语音；原音频保留，请核对音量和录音来源。')
    emit({'type': 'result', 'durationMs': round(window.end/RATE*1000), 'segments': count,
          'model': 'faster-whisper-small-int8', 'maxBufferedSamples': window.peak,
          'boundaryWarnings': stitcher.uncertain, 'qualityWarnings': rejected,
          'elapsedSeconds': round(time.monotonic()-began, 2)})


def live_transcribe(encoded, language):
    import numpy as np
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) % 4 or not 1600 <= len(raw) <= 12 * RATE * 4:
        raise ValueError('实时语音片段必须为 0.025–12 秒、16kHz 单声道 Float32。')
    audio = np.frombuffer(raw, dtype='<f4').copy()
    if not np.isfinite(audio).all() or np.max(np.abs(audio)) > 1.05:
        raise ValueError('实时音频含无效样本。')
    began = time.monotonic()
    # VAD inside the recognizer handles speech/noise; energy gate only excludes silence.
    if np.sqrt(np.mean(audio * audio)) < 0.0015:
        return {'text': '', 'chunks': [], 'quality': {'rejectedSegments': 0, 'reason': 'silence'}, 'elapsedMs': 0}
    model = get_model()
    segments, _ = model.transcribe(audio, language=language, beam_size=3,
        temperature=(0.0, 0.2), condition_on_previous_text=False,
        vad_filter=True, vad_parameters={'min_silence_duration_ms': 300, 'speech_pad_ms': 200},
        word_timestamps=False, max_new_tokens=min(224, max(64, int(len(audio)/RATE*22))))
    chunks, rejected = [], 0
    duration = len(audio)/RATE
    for segment in segments:
        if quality_reason(segment.text):
            rejected += 1
            continue
        a, b = max(0, segment.start), min(duration, segment.end)
        if b > a:
            chunks.append({'text': segment.text.strip(), 'timestamp': [a, b]})
    return {'text': ' '.join(c['text'] for c in chunks), 'chunks': chunks,
            'quality': {'rejectedSegments': rejected},
            'elapsedMs': round((time.monotonic()-began)*1000)}


def serve():
    """Private stdio only. Parent owns paths; browser can never submit worker commands."""
    global emit
    output = emit
    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 1100000:
                raise ValueError('实时音频请求过大。')
            request = json.loads(line)
            request_id = request['id']
            language = request.get('language', 'en')
            if language not in ('en', 'zh'):
                raise ValueError('只支持中文或英语录音。')
            emit = lambda event: output({**event, 'id': request_id})
            operation = request.get('operation')
            if operation == 'warmup':
                get_model()
                emit({'type': 'result', 'available': True, 'liveSupported': True})
            elif operation == 'live':
                result = live_transcribe(request['pcm'], language)
                emit({'type': 'result', **result, 'engine': 'faster-whisper-small-int8'})
            elif operation == 'file':
                transcribe(request['path'], language)
            else:
                raise ValueError('不支持的本机语音操作。')
        except Exception as error:
            output({'id': request_id, 'type': 'error', 'code': 'ASR_FAILED',
                    'message': str(error) if isinstance(error, ValueError) else '本机语音处理未完成，原音频保留，请重试。'})
        finally:
            emit = output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--file')
    parser.add_argument('--language', choices=['en', 'zh'], default='en')
    args = parser.parse_args()
    if args.serve:
        serve()
        return
    if args.probe:
        try:
            import av
            import numpy
            import ctranslate2
            cached_model()
            if 'int8' not in ctranslate2.get_supported_compute_types('cpu'):
                raise RuntimeError('int8 unavailable')
            emit({'available': True, 'liveSupported': True, 'model': 'faster-whisper-small-int8', 'localOnly': True, 'windowSeconds': 60})
        except Exception:
            emit({'available': False, 'message': '本机精校需要 Python、faster-whisper 和已缓存的 Small 模型，请运行“配置本机转写”。短录音仍可使用浏览器精校。'})
        return
    try:
        transcribe(args.file, args.language)
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else '本机精校未完成，原音频和已生成的文字保留。请检查本机转写环境或转换音频格式后重试。'
        emit({'type': 'error', 'code': 'ASR_FAILED', 'message': message})
        sys.exit(1)


if __name__ == '__main__':
    main()
