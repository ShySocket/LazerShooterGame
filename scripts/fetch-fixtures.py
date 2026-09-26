#!/usr/bin/env python3
"""Download real-person fixtures for the real-model checks (npm run realcheck).

Stills: several freely licensed photos per person from Wikimedia Commons, scaled
to 1024 px, so face identity can be checked on real embeddings. Clips: a few
short videos of people (see CLIPS) trimmed and scaled with ffmpeg.

Everything lands in fixtures/real/ (git-ignored) with SOURCES.md listing the
url, author and license of every file. Re-running skips files already present.

    python3 scripts/fetch-fixtures.py [stills|clips]
"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures', 'real')
UA = 'LazerShooterFixtures/0.1 (test fixtures for an open-source game; contact via github.com/ShySocket)'
API = 'https://commons.wikimedia.org/w/api.php'
OK_LICENSE = re.compile(r'^(public domain|pd|cc0|cc by(-sa)? [0-9.]+)', re.I)

# People with many public-domain (US federal government) photos on Commons, so
# each has several angles, lights and outfits.
PEOPLE = [
    'Deb Haaland', 'Pete Buttigieg', 'Antony Blinken', 'Janet Yellen',
    'Lloyd Austin', 'Gina Raimondo', 'Xavier Becerra', 'Marcia Fudge',
    'Denis McDonough', 'Jennifer Granholm', 'Alejandro Mayorkas', 'Miguel Cardona',
    'Tom Vilsack', 'Merrick Garland', 'Katherine Tai', 'Isabel Guzman', 'Michael Regan',
    'Karine Jean-Pierre', 'Jake Sullivan', 'Linda Thomas-Greenfield', 'Avril Haines',
    'Rachel Levine', 'Vivek Murthy', 'Shalanda Young', 'Marty Walsh', 'Julie Su',
    'Adewale Adeyemo', 'Deanne Criswell', 'Michael Kratsios',
]
PER_PERSON = 8

# (name, commons title, start s, duration s, what it is for). Talkers are single-person interviews:
# each is one identity seen for many frames, so later frames test the enrolment of earlier ones.
CLIPS = [
    ('talker-cordeiro', 'File:-VariaHistoria 106 - Janaína Martins Cordeiro.webm', 60, 25, 'one person talking face-on'),
    ('talker-lakhan', 'File:Interview of a Baiga tribe named Lakhan Lal in Hindi Language by Suyash Dwivedi.webm', 30, 25, 'one person talking face-on'),
    ('talker-pennington', 'File:TUF 18 Finale Media Day with Raquel Pennington.webm', 10, 25, 'one person talking face-on'),
    ('talker-caruso', 'File:Interview with a Teacher - Glen Caruso.webm', 60, 25, 'one person talking face-on'),
    ('talker-kende', 'File:Internet Hall of Fame 2014 Michael Kende interview.webm', 20, 25, 'one person talking face-on'),
    ('talker-cloke', 'File:Interview on extreme weather with physical geographer Hannah Cloke – The Royal Society.webm', 20, 25, 'one person talking face-on'),
    ('dancer', 'File:PM plus size dancer.webm', 0, 20, 'one full-body person turning (front and back views)'),
    ('mirror', 'File:Man walking parallel to mirrors in a hair salon, recording iPhone directed towards the mirrors.webm', 0, 12, 'a person and their mirror images'),
    ('street', 'File:Sabana Grande Caracas. People walking on the Boulevard of Sabana Grande, famous in Caracas, Venezuela.webm', 0, 20, 'strangers walking and crossing'),
]


def api(params):
    params = {**params, 'format': 'json'}
    req = urllib.request.Request(API + '?' + urllib.parse.urlencode(params), headers={'User-Agent': UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError('api failed: %r' % params)


def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r, open(path + '.part', 'wb') as f:
                while True:
                    b = r.read(1 << 16)
                    if not b:
                        break
                    f.write(b)
            os.replace(path + '.part', path)
            return
        except Exception:
            time.sleep(15 * (attempt + 1))
    raise RuntimeError('download failed: ' + url)


def meta(ii):
    m = ii.get('extmetadata') or {}
    get = lambda k: re.sub(r'<[^>]+>', '', str((m.get(k) or {}).get('value', ''))).strip()
    return get('LicenseShortName'), get('Artist')[:120]


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def stills(sources):
    for person in PEOPLE:
        surname = person.split()[-1].lower()
        folder = os.path.join(ROOT, 'stills', slug(person))
        os.makedirs(folder, exist_ok=True)
        d = api({
            'action': 'query', 'generator': 'search', 'gsrnamespace': 6, 'gsrlimit': 50,
            'gsrsearch': f'"{person}" filetype:bitmap', 'prop': 'imageinfo',
            'iiprop': 'url|size|extmetadata|mime', 'iiurlwidth': 1024,
            'iiextmetadatafilter': 'LicenseShortName|Artist',
        })
        pages = sorted((d.get('query') or {}).get('pages', {}).values(), key=lambda p: p.get('index', 0))
        n = 0
        for p in pages:
            if n >= PER_PERSON:
                break
            t = p['title']
            if surname not in t.lower() or re.search(r'signature|logo|seal|map|crest|chart| and | with |meets|meeting|group|delegation', t, re.I):
                continue
            ii = p['imageinfo'][0]
            if ii.get('mime') not in ('image/jpeg', 'image/png') or ii.get('width', 0) < 600:
                continue
            lic, artist = meta(ii)
            if not OK_LICENSE.match(lic):
                continue
            name = f'{n + 1:02d}.jpg'
            try:
                download(ii.get('thumburl') or ii['url'], os.path.join(folder, name))
            except RuntimeError as e:
                print('  skip:', e, flush=True)
                continue
            n += 1
            time.sleep(1)
            sources.append((f'stills/{slug(person)}/{name}', ii['descriptionurl'], artist, lic))
        print(f'{person}: {n} photos', flush=True)


def clips(sources):
    folder = os.path.join(ROOT, 'clips')
    os.makedirs(folder, exist_ok=True)
    for name, title, start, dur, what in CLIPS:
        d = api({'action': 'query', 'titles': title, 'prop': 'imageinfo',
                 'iiprop': 'url|size|extmetadata', 'iiextmetadatafilter': 'LicenseShortName|Artist'})
        page = next(iter(d['query']['pages'].values()))
        ii = page['imageinfo'][0]
        lic, artist = meta(ii)
        out = os.path.join(folder, f'{name}.mp4')
        if not os.path.exists(out):
            # Stream only the needed seconds from a transcode: the originals are large and rate-limited.
            orig = ii['url'].split('?')[0]
            base = orig.replace('/wikipedia/commons/', '/wikipedia/commons/transcoded/', 1) + '/' + orig.rsplit('/', 1)[1]
            for url in [base + '.480p.vp9.webm', base + '.360p.vp9.webm', base + '.480p.webm', orig]:
                r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-user_agent', UA, '-ss', str(start), '-t', str(dur), '-i', url,
                                    '-vf', 'scale=640:-2,fps=15', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out])
                if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 10000:
                    break
                time.sleep(30)
            else:
                print(f'{name}: failed', flush=True)
                continue
        time.sleep(45)
        sources.append((f'clips/{name}.mp4, {start}-{start + dur} s: {what}', ii['descriptionurl'], artist, lic))
        print(f'{name}: {lic}', flush=True)


def write_sources(sources):
    path = os.path.join(ROOT, 'SOURCES.md')
    rows = {}
    if os.path.exists(path):
        for line in open(path):
            if line.startswith('| ') and not line.startswith('| file') and not line.startswith('| ---'):
                rows[line.split(' | ')[0]] = line.rstrip('\n')
    for f, url, artist, lic in sources:
        rows['| ' + f] = f'| {f} | {url} | {artist.replace("|", "/")} | {lic} |'
    with open(path, 'w') as out:
        out.write('# Real-person fixtures\n\nDownloaded by scripts/fetch-fixtures.py for the real-model checks. '
                  'Not committed. Every file is public domain or Creative Commons; attribution below.\n\n'
                  '| file | source | author | license |\n| --- | --- | --- | --- |\n')
        out.write('\n'.join(rows[k] for k in sorted(rows)) + '\n')


if __name__ == '__main__':
    which = sys.argv[1:] or ['stills', 'clips']
    os.makedirs(ROOT, exist_ok=True)
    sources = []
    try:
        if 'stills' in which:
            stills(sources)
        if 'clips' in which:
            clips(sources)
    finally:
        write_sources(sources)
