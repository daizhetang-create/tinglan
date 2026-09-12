import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'server'))
from asr_quality import quality_reason


class QualityTests(unittest.TestCase):
    def test_runaway(self):
        for text in ['们' * 700, '我们我们' * 100, 'thank you ' * 60, '真的真的' * 40]:
            self.assertEqual(quality_reason(text), 'repetition')

    def test_actual_speech_not_global_deduplication(self):
        for text in ['不不不，不是这个答案。', '谢谢大家', '我们要认真，认真，再认真。',
                     'The word had had two meanings.', '练习一：1 2 3；练习二：1 2 3；练习三：1 2 3。']:
            self.assertIsNone(quality_reason(text))

    def test_empty(self):
        self.assertEqual(quality_reason('...'), 'empty')


if __name__ == '__main__':
    unittest.main()
