#!/usr/bin/env python3
"""Contact sheet of faces from .rubric/realcheck/embeddings.json, for eyeballing labels.

    python3 scripts/face-sheet.py out.jpg person/photo.jpg:x,y,w,h ...   (normalised square-canvas box)
    python3 scripts/face-sheet.py out.jpg --worst N                      (closest different-person pairs)
"""
import json, os, subprocess, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FIX = os.path.join(ROOT, 'fixtures', 'real', 'stills')

def dims(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    w, h = out.strip().split(',')[:2]
    return int(w), int(h)

def crop(photo, box, out):
    path = os.path.join(FIX, photo)
    w, h = dims(path)
    side = max(w, h)
    cx = (box[0] + box[2] / 2) * side - (side - w) / 2
    cy = (box[1] + box[3] / 2) * side - (side - h) / 2
    s = max(box[2], box[3]) * side * 1.4
    x, y = max(0, cx - s / 2), max(0, cy - s / 2)
    s = min(s, w - x, h - y)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-vf', f'crop={int(s)}:{int(s)}:{int(x)}:{int(y)},scale=160:160', out], check=True)

def main():
    out, args = sys.argv[1], sys.argv[2:]
    items = []
    if args[:1] == ['--worst']:
        data = json.load(open(os.path.join(ROOT, '.rubric', 'realcheck', 'embeddings.json')))
        sys.path.insert(0, ROOT)
        faces = [(f, 'own') for f in data['own']] + [(f, 'stranger') for f in data['strangers']]
        import math
        def centred(a, b):
            return sum(x * y for x, y in zip(a, b))
        # Pairs are recomputed in realcheck; here we just take the listed worst pairs from faces.json.
        summ = json.load(open(os.path.join(ROOT, '.rubric', 'realcheck', 'faces.json')))['summary']['worstImpostors'][: int(args[1])]
        lookup = {}
        for f, kind in faces:
            lookup.setdefault(f"{f['person']}/{f['photo']}", []).append((f, kind))
        for w in summ:
            a = next(f for f, k in lookup[w['a']] if k == 'own')
            key = w['b'].replace('stranger in ', '')
            cands = [f for f, k in lookup[key] if k == ('stranger' if w['b'].startswith('stranger') else 'own')]
            b = max(cands, key=lambda f: sum(x * y for x, y in zip(f['embedding'], a['embedding'])))
            items += [(a['person'] + '/' + a['photo'], a['box']), (b['person'] + '/' + b['photo'], b['box'])]
    else:
        for a in args:
            p, b = a.split(':')
            items.append((p, [float(v) for v in b.split(',')]))
    tmp = []
    for i, (p, b) in enumerate(items):
        t = f'/tmp/face-sheet-{os.getpid()}-{i:03d}.png'
        crop(p, b, t)
        tmp.append(t)
    cols = 2 if args[:1] == ['--worst'] else min(6, len(tmp))
    rows = (len(tmp) + cols - 1) // cols
    inputs = sum([['-i', t] for t in tmp], [])
    layout = '|'.join(f'{(i % cols) * 160}_{(i // cols) * 160}' for i in range(len(tmp)))
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', f'xstack=inputs={len(tmp)}:layout={layout}:fill=black' if len(tmp) > 1 else 'null', out], check=True)
    for t in tmp:
        os.remove(t)

main()
