"""Copy dist/ to a folder whose data tiles are plain .json instead of .json.gz,
for static hosts that refuse to serve gzip files. Usage: python3 tools/stage-plain.py dist out"""
import gzip, json, os, shutil, sys

src, dst = sys.argv[1], sys.argv[2]
shutil.copytree(src, dst, dirs_exist_ok=True)
for root, _, files in os.walk(dst):
    for f in files:
        p = os.path.join(root, f)
        if f.endswith('.json.gz'):
            with gzip.open(p) as g, open(p[:-3], 'wb') as o:
                o.write(g.read())
            os.remove(p)
        elif f in ('manifest.json', 'index.json') and '/data/' in p.replace(os.sep, '/'):
            j = json.load(open(p))
            j['ext'] = '.json'
            json.dump(j, open(p, 'w'))
