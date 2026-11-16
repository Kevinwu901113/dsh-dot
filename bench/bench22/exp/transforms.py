# Text surgery on a stored memory prompt: one change per transform, for answer-only reruns.
import re, datetime as dt

def _sub(p, a, b, must=True):
    if a not in p:
        if must: raise KeyError(a[:30])
        return p
    return p.replace(a, b)

def base(p): return p

def nosup(p):  # drop the three "hold back" phrases
    p = _sub(p, '除此之外只说问到的：没记下的细节不补', '没记下的细节不补')
    p = _sub(p, '；不相干的旧事别顺手带出来（下面"今天到期的"不算旧事）', '')
    p = _sub(p, '用得上就用，用不上就当没看见，也别提"翻到"', '别提"翻到"', must=False)
    return p

def assoc(p):  # nosup + a positive line
    p = nosup(p)
    return _sub(p, '就照着它来回话；', '就照着它来回话；他提到的人和事，你记得相关的就接上，哪怕他没问；')

def premise(p):
    return _sub(p, '和他现在明确说的冲突时以现在为准，重要又拿不准时自然确认一下',
                '他现在说的数目、日子、人和你记得的对不上时，先把你记得的那个说出来，再问是变了还是记岔了，别直接顺着新说法往下说；他讲明是变了，就以现在为准')

def details(p):
    return _sub(p, '具体说过什么，以翻出来的原话为准。', '具体说过什么，以翻出来的原话为准；提到记得的事，把当时说定的日子、数目、是谁一并带上，别只说个大概。')

def norefl(p):
    return re.sub(r'\n## 你自己记下的\n(?:- .*\n?)*', '\n', p)

def _today(p):
    m = re.search(r'\n现在 (\d{4})-(\d\d)-(\d\d)', p)
    return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))

def _date(md, today):
    m = re.match(r'(?:(\d{4})-)?(\d\d)-(\d\d)$', md)
    y = int(m.group(1)) if m.group(1) else today.year
    try: d = dt.date(y, int(m.group(2)), int(m.group(3)))
    except ValueError: return None
    if not m.group(1):
        if (d - today).days > 183: d = d.replace(year=y - 1)
        elif (today - d).days > 183: d = d.replace(year=y + 1)
    return d

def nostale(p):  # drop open items whose date has passed
    today = _today(p)
    m = re.search(r'(\n## 还没了的事[^\n]*\n)((?:- .*\n?)*)', p)
    if not m: return p
    keep = []
    for line in m.group(2).splitlines():
        due = re.search(r'（到 ((?:\d{4}-)?\d\d-\d\d)）', line)
        if due: ds = [_date(due.group(1), today)]
        else: ds = [_date(x, today) for x in re.findall(r'=((?:\d{4}-)?\d\d-\d\d)', line)]
        ds = [d for d in ds if d]
        if ds and max(ds) < today: continue
        keep.append(line)
    body = '\n'.join(keep) + ('\n' if keep else '')
    if not keep: return p[:m.start()] + '\n' + p[m.end():]
    return p[:m.start(2)] + body + p[m.end(2):]

def dueall(p):
    return _sub(p, '只带一句、不展开，他说了已经办了的不用提', '列着几件就都点到、一件一句，不展开，他说了已经办了的不用提', must=False)

def premise2(p):
    return _sub(p, '和他现在明确说的冲突时以现在为准，重要又拿不准时自然确认一下',
                '和他现在说的冲突时：他讲明是变了的，以现在为准；他只是把数目、日子、人说得和你记得的不一样、没说变了，就点出你记得的是哪个、问一句，别顺着往下说')

def quote(p):
    return _sub(p, '只提这里列着的，别的日子的事别说成今天的', '只提这里列着的，别的日子的事别说成今天的；带的时候照他当时的说法说，是哪天说的、原话里的人和事别换词', must=False)

def stmt(p):
    return _sub(p, '先接他的话，末了顺口带一句，哪怕他在聊别的', '先接他的话，末了顺口提醒一句，哪怕他在聊别的；只说今天有这件事，别问办了没、结果怎么样（你不知道）', must=False)

def twover(p):
    return _sub(p, '具体说过什么，以翻出来的原话为准。', '具体说过什么，以翻出来的原话为准；原话里同一件事有两种说法、没说哪个作数的，两种都提、说自己拿不准，别挑一个当定下来的。')

_NEW = '列着几件就都点到、一件一句，不展开，他说了已经办了的不用提。只提这里列着的，别的日子的事别说成今天的；带的时候照他当时的说法说，是哪天说的、原话里的人和事别换词'
def oldtoday(p):  # back to the wording before 0bb8bb5
    return _sub(p, _NEW, '只带一句、不展开，他说了已经办了的不用提。只提这里列着的，别的日子的事别说成今天的', must=False)

def midtoday(p):  # all + his words, but hold it when he is upset or wants one thing done
    return _sub(p, '先接他的话，末了顺口带一句，哪怕他在聊别的；列着几件', '先接他的话，末了顺口带一句，哪怕他在聊别的（他正难受、或正让你专心帮一件事时先不带）；列着几件', must=False)

T = {f.__name__: f for f in (oldtoday, midtoday, base, nosup, assoc, premise, details, norefl, nostale, dueall, premise2, quote, stmt, twover)}
def apply(names, p):
    for n in names.split('+'): p = T[n](p)
    return p
