import importlib.util
import pathlib
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('asr_worker', pathlib.Path(__file__).resolve().parents[2] / 'server/asr_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WindowsTest(unittest.TestCase):
    def test_all_core_samples_once_and_constant_buffer(self):
        for length in [1, 15999, 60*16000-1, 60*16000, 60*16000+1, 61*16000, 62*16000, 120*16000, 181*16000]:
            buffer = worker.WindowBuffer(np)
            cores = []
            def accept(item):
                pcm, start, a, b, final = item
                self.assertTrue(np.array_equal(pcm, np.arange(start, start+len(pcm), dtype=np.float32)))
                self.assertLessEqual(len(pcm), 64*16000)
                cores.append((a,b))
            for start in range(0, length, 7139):
                for item in buffer.feed(np.arange(start, min(length,start+7139), dtype=np.float32)):
                    accept(item)
            for item in buffer.finish():
                accept(item)
            self.assertEqual(cores[0][0], 0)
            self.assertEqual(cores[-1][1], length)
            self.assertTrue(all(a[1] == b[0] for a,b in zip(cores,cores[1:])))
            self.assertEqual(sum(b-a for a,b in cores), length)
            self.assertLessEqual(buffer.peak, 64*16000)

    def test_drifting_boundary_anchor_keeps_one_copy(self):
        merger = worker.WordStitcher()
        w = lambda start,text: {'start':start,'end':start+.3,'text':text}
        first = merger.accept([w(57,'Read'),w(59.9,' chapter'),w(60.4,' three')],0,60)
        second = merger.accept([w(59.7,' chapter'),w(60.2,' three'),w(61,' today.')],60,62,True)
        self.assertEqual(''.join(x['text'] for x in first+second),'Read chapter three today.')
        self.assertEqual(merger.uncertain,0)

    def test_true_repeated_words_are_not_globally_removed(self):
        merger = worker.WordStitcher()
        words = [{'start':n,'end':n+.3,'text':'重点。'} for n in [1,10,20]]
        self.assertEqual(len(merger.accept(words,0,30,True)),3)

    def test_silent_short_tail_does_not_discard_previous_context(self):
        merger = worker.WordStitcher()
        merger.accept([{'start':58.5,'end':59.2,'text':' before'}, {'start':60.2,'end':60.8,'text':' TAIL'}],0,60)
        self.assertEqual(''.join(w['text'] for w in merger.accept([],60,61,True)), ' before TAIL')


if __name__ == '__main__':
    unittest.main()
