import urllib.request,json,tarfile,io,pathlib
dest=pathlib.Path(__file__).resolve().parent/'public/vendor';dest.mkdir(parents=True,exist_ok=True)
def package(name,version):
    print('Fetching',name,version,flush=True)
    meta=json.load(urllib.request.urlopen('https://registry.npmjs.org/'+name+'/'+version,timeout=40))
    blob=urllib.request.urlopen(meta['dist']['tarball'],timeout=90).read()
    return tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz')
def save(tf,member,target):
    f=dest/target;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(tf.extractfile(member).read());print(target,f.stat().st_size,flush=True)
t=package('tesseract.js','5.1.1')
for name in ['tesseract.min.js','worker.min.js']:save(t,'package/dist/'+name,name)
save(t,next(m for m in t.getmembers() if 'LICENSE' in m.name.upper()),'TESSERACT-LICENSE.txt')
t=package('tesseract.js-core','5.1.1')
for m in t.getmembers():
    if m.isfile() and (m.name.endswith('.wasm') or m.name.endswith('.wasm.js')):save(t,m,'core/'+pathlib.PurePosixPath(m.name).name)
for lang in ['chi_sim','eng']:
    t=package('@tesseract.js-data/'+lang,'1.0.0')
    members=[m for m in t.getmembers() if m.isfile() and '4.0.0_best_int/' in m.name and m.name.endswith('.traineddata.gz')]
    if not members:raise RuntimeError('Language data missing')
    save(t,members[0],'lang/'+lang+'.traineddata.gz')
t=package('xlsx','0.18.5');save(t,'package/dist/xlsx.full.min.js','xlsx.full.min.js');save(t,'package/LICENSE','XLSX-LICENSE.txt')


import hashlib
manifest=json.loads((pathlib.Path(__file__).parent/"vendor-sha256.json").read_text())
for name,digest in manifest.items():
    if hashlib.sha256((dest/name).read_bytes()).hexdigest()!=digest:raise RuntimeError("Component checksum mismatch: "+name)
print("All component checksums verified")
