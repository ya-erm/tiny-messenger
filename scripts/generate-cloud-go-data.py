#!/usr/bin/env python3
"""Derive native API constants from the same sources used by the JS client.

The emoji-regex grammar is finite. Expand it and then filter with the original
matcher so alternation priority and accepted variation selectors stay exact.
"""
import itertools
import json
from pathlib import Path
from re import _parser as parser, _constants as constants
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
source = root / 'cloud/yandex'
target = source / 'go'
check = '--check' in sys.argv

def save(name, content):
    path = target / name
    if check:
        if path.read_text() != content:
            raise SystemExit('Stale Go embedded data: ' + name)
    else:
        path.write_text(content)

def node(code, input_text=None):
    return subprocess.check_output(['node', '--input-type=module', '-e', code], cwd=root,
                                   input=input_text, text=True)

metadata = json.loads(node('''
import fs from 'node:fs';import vm from 'node:vm';
import{ROW_TABLES}from'./cloud/yandex/shared/rows.mjs';
const source=fs.readFileSync('./cloud/yandex/shared/names.mjs','utf8').replace(/^import .*$/mg,'').replace(/^export /mg,'');
const animals=vm.runInNewContext(source+'\\nanimalProfiles.map(p=>namesForProfile(p).map(name=>publicAnimalProfile(p,name)))',{LIMITS:{name:20}});
console.log(JSON.stringify({tables:ROW_TABLES,animals}));
'''))
for name, value in [('animals.json', metadata['animals']), ('row-tables.json', metadata['tables'])]:
    save(name, json.dumps(value, ensure_ascii=False, separators=(',', ':')))

pattern = (source / 'node_modules/emoji-regex/index.mjs').read_text().split('return /', 1)[1].split('/g;', 1)[0]
def expand(nodes):
    result = ['']
    for kind, value in nodes:
        if kind is constants.LITERAL:
            terms = [chr(value)]
        elif kind is constants.IN:
            terms = []
            for item, data in value:
                if item is constants.LITERAL:
                    terms.append(chr(data))
                elif item is constants.RANGE:
                    terms.extend(map(chr, range(data[0], data[1] + 1)))
                else:
                    raise ValueError('Unsupported character class')
        elif kind is constants.SUBPATTERN:
            terms = expand(value[-1])
        elif kind is constants.BRANCH:
            terms = [word for branch in value[1] for word in expand(branch)]
        elif kind is constants.MAX_REPEAT:
            low, high, body = value
            if high >= 10:
                raise ValueError('Unbounded emoji grammar')
            choices = expand(body)
            terms = [''.join(words) for length in range(low, high + 1)
                     for words in itertools.product(choices, repeat=length)]
        else:
            raise ValueError('Unsupported regex element')
        if len(result) * len(terms) >= 1_000_000:
            raise ValueError('Emoji grammar expansion too large')
        result = [left + right for left in result for right in terms]
    return result
candidates = sorted({word.encode('utf-16-le', 'surrogatepass').decode('utf-16-le')
                     for word in expand(parser.parse(pattern, 0))})
accepted = node('''
import fs from 'node:fs';import{isReactionEmoji}from'./cloud/yandex/shared/reactions.mjs';
process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).filter(isReactionEmoji)));
''', json.dumps(candidates, ensure_ascii=False))
save('emojis.json', accepted)
save('LICENSE-emoji-regex.txt', (source / 'node_modules/emoji-regex/LICENSE-MIT.txt').read_text())
print(json.dumps({'checked' if check else 'generated': 4, 'emojiCount': len(json.loads(accepted))}))
