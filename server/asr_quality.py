"""Reject recognizer runaway output, not ordinary rhetorical repetition."""
import re


def quality_reason(text):
    compact = re.sub(r'[^\w\u3400-\u9fff]', '', text, flags=re.UNICODE).casefold()
    if not compact:
        return 'empty'
    if len(compact) > 1800:
        return 'oversized'
    # Eight identical characters or a small phrase cycling for >=32 characters.
    if re.search(r'(.)\1{7,}', compact):
        return 'repetition'
    if re.search(r'(.{2,16}?)\1{7,}', compact) and len(compact) >= 32:
        return 'repetition'
    return None
