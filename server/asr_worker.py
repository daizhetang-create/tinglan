"""Local-only, bounded PCM transcription. Never downloads a model implicitly."""
import argparse
import json
import os
import re
import sys
import time

RATE = 16000
CORE = 60 * RATE
CONTEXT = 2 * RATE
MAX_SAMPLES = 4 * 3600 * RATE


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
    from faster_whisper import WhisperModel
    model_path = cached_model()
    emit({'type': 'progress', 'message': '正在加载本机 Small 精校模型（不上传音频）'})
    model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=min(4, os.cpu_count() or 2), num_workers=1, local_files_only=True)
    window = WindowBuffer(np)
    stitcher = WordStitcher()
    count = 0
    last_end = 0.0
    began = time.monotonic()

    def process(item):
        nonlocal count, last_end
        audio, start, core_start, core_end, eof = item
        # At EOF the penultimate core may still have a tiny final core to follow.
        final = eof and core_end == window.end
        emit({'type': 'progress', 'processedMs': core_start/RATE*1000, 'message': '本机分窗精校 · %.0f–%.0f 秒' % (core_start/RATE, core_end/RATE)})
        segments, _ = model.transcribe(audio, language=language, beam_size=3, word_timestamps=True,
            condition_on_previous_text=False, vad_filter=True, vad_parameters={'min_silence_duration_ms': 500})
        words = []
        for segment in segments:
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
          'boundaryWarnings': stitcher.uncertain, 'elapsedSeconds': round(time.monotonic()-began, 2)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--file')
    parser.add_argument('--language', choices=['en', 'zh'], default='en')
    args = parser.parse_args()
    if args.probe:
        try:
            import av
            import numpy
            import ctranslate2
            cached_model()
            if 'int8' not in ctranslate2.get_supported_compute_types('cpu'):
                raise RuntimeError('int8 unavailable')
            emit({'available': True, 'model': 'faster-whisper-small-int8', 'localOnly': True, 'windowSeconds': 60})
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
