"""Shop Ledger: authenticated, single-owner WSGI application backed by SQLite."""
import base64, calendar, datetime as dt, getpass, hashlib, hmac, json, mimetypes, os, re, secrets, sqlite3, sys, time
from pathlib import Path
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('LEDGER_DATA', str(ROOT / 'data')))
DATA.mkdir(parents=True, exist_ok=True)
FILES = DATA / 'receipts'
FILES.mkdir(exist_ok=True)
DB = DATA / 'ledger.sqlite3'
KINDS = {'expense', 'income', 'transfer', 'refund', 'reimbursement'}

def connect():
    con = sqlite3.connect(DB, timeout=20)
    con.execute('PRAGMA journal_mode=WAL')
    return con

def initial():
    categories = [('货品采购','expense'),('包装耗材','expense'),('推广广告','expense'),('物流运费','expense'),('平台费用','expense'),('日常支出','expense'),('销售收入','income'),('其他收入','income')]
    return dict(records=[], books=[dict(id='default',name='网店经营',archived=False)], categories=[dict(id='cat'+str(i),name=n,kind=k,parent='',archived=False) for i,(n,k) in enumerate(categories)], accounts=[dict(id='acc'+str(i),name=n,currency='CNY',initial=0,kind='asset',archived=False) for i,n in enumerate(['微信','支付宝','银行卡','平台余额','现金'])], budgets=[], templates=[], plans=[], goals=[])

def init_db():
    with connect() as c:
        c.executescript('CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires REAL NOT NULL); CREATE TABLE IF NOT EXISTS attempts(ip TEXT PRIMARY KEY,count INTEGER NOT NULL,started REAL NOT NULL);')
        c.execute('INSERT OR IGNORE INTO state VALUES(1,0,?)',(json.dumps(initial(),ensure_ascii=False),))

def credential(password, salt=None):
    salt = salt or secrets.token_hex(16)
    return salt + ':' + hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),600000).hex()

def set_password(password):
    if len(password)<10: raise ValueError('密码至少 10 个字符')
    with connect() as c:
        c.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',('password',credential(password)))
        c.execute('DELETE FROM sessions')

def require(condition, text):
    if not condition: raise ValueError(text)

def cents(x, negative=False):
    return type(x) is int and abs(x)<=10**14 and (negative or x>=0)

def date(s):
    require(isinstance(s,str) and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}',s)),'日期格式不正确')
    return dt.date.fromisoformat(s)

def validate(s):
    require(isinstance(s,dict),'账本格式错误')
    groups=['records','books','categories','accounts','budgets','templates','plans','goals']
    for g in groups:
        require(isinstance(s.get(g),list) and len(s[g])<100001,'缺少或过大的数据集合: '+g)
        seen=set()
        for r in s[g]:
            require(isinstance(r,dict) and isinstance(r.get('id'),str) and re.fullmatch(r'[\w-]{1,100}',r['id']) and r['id'] not in seen,'记录编号重复或无效')
            seen.add(r['id'])
    books={r['id']:r for r in s['books']}; accounts={r['id']:r for r in s['accounts']}; cats={r['id']:r for r in s['categories']}
    require(len(books)>0,'至少保留一个账本')
    for g in ['books','accounts','categories','goals']:
        for r in s[g]: require(isinstance(r.get('name'),str) and 0<len(r['name'].strip())<=100,'名称不能为空或过长')
    for a in accounts.values():
        require(re.fullmatch('[A-Z]{3}',a.get('currency','')) and cents(a.get('initial'),True),'账户币种或期初余额无效')
    for cat in cats.values():
        require(cat.get('kind') in ['expense','income'],'分类类型无效')
        if cat.get('parent'): require(cat['parent'] in cats and not cats[cat['parent']].get('parent') and cat['parent']!=cat['id'] and cats[cat['parent']]['kind']==cat['kind'],'仅支持同类型二级分类')
    def record(r):
        date(r.get('date')); require(r.get('type') in KINDS,'账单类型无效')
        require(r.get('book') in books,'账本不存在'); require(cents(r.get('amount')) and r['amount']>0,'金额必须大于零')
        require(isinstance(r.get('project'),str) and 0<len(r['project'].strip())<=200,'项目名称不能为空')
        require(isinstance(r.get('rate'),(int,float)) and 0<r['rate']<1000000,'汇率无效')
        require(re.fullmatch('[A-Z]{3}',r.get('currency','')),'币种无效')
        require(r.get('type')=='transfer' or r.get('category') in cats,'请选择有效分类')
        if r.get('type')!='transfer':
            expected='income' if r['type']=='income' else 'expense'
            require(cats[r['category']]['kind']==expected,'分类与收支类型不一致')
        parts=r.get('splits',[])
        require(isinstance(parts,list) and 1<=len(parts)<=10,'请至少选择一个付款账户')
        for p in parts: require(p.get('account') in accounts and cents(p.get('amount')) and p['amount']>0 and accounts[p['account']]['currency']==r['currency'],'付款账户币种或金额不正确')
        require(sum(p['amount'] for p in parts)==r['amount'],'组合付款合计必须等于账单金额')
        if r['type']=='transfer':
            require(r.get('target') in accounts and r['target'] not in [p['account'] for p in parts],'转入账户必须与转出账户不同')
            require(cents(r.get('targetAmount')) and r['targetAmount']>0,'转入金额无效')
        for att in r.get('attachments',[]): require(isinstance(att,str) and re.fullmatch(r'[a-f0-9]{32}\.(png|jpg|webp)',att),'凭证编号无效')
        require(len(str(r.get('note','')))<=5000 and len(str(r.get('tags','')))<=500,'备注或标签过长')
    for r in s['records']: record(r)
    indexed={r['id']:r for r in s['records']}
    returned={}
    for r in s['records']:
        if r['type'] in ['refund','reimbursement']:
            orig=indexed.get(r.get('related'))
            require(orig and orig['type']=='expense' and orig['currency']==r['currency'] and orig['book']==r['book'],'退款/报销必须关联同账本同币种的支出')
            returned[r['related']]=returned.get(r['related'],0)+r['amount']
            require(returned[r['related']]<=orig['amount'],'退款与报销合计不能超过原支出')
    for b in s['budgets']:
        require(b.get('book') in books and cents(b.get('amount')) and b['amount']>0 and b.get('period') in ['month','week','year'],'预算参数错误')
        require(not b.get('category') or b['category'] in cats,'预算分类不存在')
    for t in s['templates']: record(t['record'])
    for p in s['plans']:
        record(p['record']); date(p['next']); require(p.get('interval') in ['day','week','month','year'],'周期无效')
        require(type(p.get('remaining')) is int and -1<=p['remaining']<=600,'剩余期数错误')
        require(type(p.get('anchor')) is int and 1<=p['anchor']<=31,'周期日期错误')
    for g in s['goals']:
        require(cents(g.get('target')) and g['target']>0 and g.get('account') in accounts,'存钱目标或账户错误')
        require(cents(g.get('baseline'),True),'存钱初始金额错误')
    return s

def advance(d, interval, anchor):
    if interval=='day': return d+dt.timedelta(days=1)
    if interval=='week': return d+dt.timedelta(days=7)
    y,m=(d.year+1,d.month) if interval=='year' else (d.year+(d.month==12),d.month%12+1)
    return dt.date(y,m,min(anchor,calendar.monthrange(y,m)[1]))

def materialize(s):
    today=dt.date.today(); changed=False
    for p in s['plans']:
        n=0
        while not p.get('paused') and p['remaining']!=0 and date(p['next'])<=today and n<1000:
            r=json.loads(json.dumps(p['record'])); r.update(id='plan-'+p['id']+'-'+p['next'],date=p['next'],plan=p['id'])
            if not any(x['id']==r['id'] for x in s['records']): s['records'].append(r)
            if p['remaining']>0: p['remaining']-=1
            p['next']=advance(date(p['next']),p['interval'],p['anchor']).isoformat(); changed=True; n+=1
    return changed

def snapshot():
    with connect() as c:
        c.execute('BEGIN IMMEDIATE')
        rev,body=c.execute('SELECT revision,body FROM state WHERE id=1').fetchone(); s=json.loads(body)
        if materialize(s):
            validate(s); rev+=1; c.execute('UPDATE state SET revision=?,body=? WHERE id=1',(rev,json.dumps(s,ensure_ascii=False)))
        return dict(revision=rev,state=s)

def backup():
    folder=DATA/'backups'; folder.mkdir(exist_ok=True)
    dest=folder/(dt.date.today().isoformat()+'.sqlite3')
    if not dest.exists():
        with connect() as src, sqlite3.connect(dest) as target: src.backup(target)

def application(env,start):
    headers=[('X-Content-Type-Options','nosniff'),('Cache-Control','no-store'),('Referrer-Policy','same-origin'),('X-Frame-Options','DENY')]
    def respond(code,obj=None,content=None,mime='application/json; charset=utf-8'):
        data=content if content is not None else json.dumps(obj,ensure_ascii=False).encode()
        headers.extend([('Content-Type',mime),('Content-Length',str(len(data)))])
        start(str(code)+' '+{200:'OK',201:'Created',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',409:'Conflict',413:'Content Too Large',429:'Too Many Requests',500:'Internal Server Error'}[code],headers)
        return [data]
    try:
        path=env.get('PATH_INFO','/'); method=env['REQUEST_METHOD']; body={}
        if method in ['POST','PUT','DELETE']:
            origin=env.get('HTTP_ORIGIN','')
            if origin and origin.split('://',1)[-1]!=env.get('HTTP_HOST'): return respond(403,{'error':'来源验证失败'})
            size=int(env.get('CONTENT_LENGTH') or 0)
            if size>30*1024*1024: return respond(413,{'error':'文件过大'})
            body=json.loads(env['wsgi.input'].read(size) or '{}')
        if path=='/api/health': return respond(200,{'ok':True,'version':'2.0'})
        token=dict(p.strip().split('=',1) for p in env.get('HTTP_COOKIE','').split(';') if '=' in p).get('ledger_session','')
        with connect() as c:
            password=c.execute("SELECT v FROM settings WHERE k='password'").fetchone()
            session=c.execute('SELECT csrf,expires FROM sessions WHERE token=?',(hashlib.sha256(token.encode()).hexdigest(),)).fetchone() if token else None
        if session and session[1]<time.time(): session=None
        if path=='/api/auth' and method=='GET': return respond(200,{'authenticated':bool(session),'configured':bool(password),'csrf':session[0] if session else None})
        if path=='/api/login' and method=='POST':
            if not password: return respond(403,{'error':'请先在服务器终端设置登录密码'})
            ip=env.get('REMOTE_ADDR','unknown'); now=time.time()
            with connect() as c:
                c.execute('BEGIN IMMEDIATE')
                attempt=c.execute('SELECT count,started FROM attempts WHERE ip=?',(ip,)).fetchone()
                if attempt and attempt[0]>=10 and now-attempt[1]<900: return respond(429,{'error':'尝试过多，请 15 分钟后重试'})
                count,ts=attempt if attempt and now-attempt[1]<900 else (0,now)
                c.execute('INSERT OR REPLACE INTO attempts VALUES(?,?,?)',(ip,count+1,ts))
            supplied=body.get('password','')
            require(isinstance(supplied,str) and len(supplied)<=1024,'密码格式不正确')
            if not hmac.compare_digest(credential(supplied,password[0].split(':')[0]),password[0]): return respond(401,{'error':'密码不正确'})
            token=secrets.token_urlsafe(32); csrf=secrets.token_urlsafe(24)
            with connect() as c:
                c.execute('DELETE FROM attempts WHERE ip=?',(ip,)); c.execute('DELETE FROM sessions WHERE expires<?',(now,))
                c.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),csrf,now+7*86400))
            secure='; Secure' if env.get('HTTP_X_FORWARDED_PROTO',env.get('wsgi.url_scheme'))=='https' else ''
            headers.append(('Set-Cookie','ledger_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800'+secure))
            return respond(200,{'csrf':csrf})
        if path.startswith('/api/'):
            if not session: return respond(401,{'error':'请先登录'})
            if method!='GET' and not hmac.compare_digest(env.get('HTTP_X_CSRF_TOKEN',''),session[0]): return respond(403,{'error':'会话验证失败，请重新登录'})
            if path=='/api/logout':
                with connect() as c: c.execute('DELETE FROM sessions WHERE token=?',(hashlib.sha256(token.encode()).hexdigest(),))
                headers.append(('Set-Cookie','ledger_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')); return respond(200,{'ok':True})
            if path=='/api/password' and method=='POST':
                require(hmac.compare_digest(credential(body.get('old',''),password[0].split(':')[0]),password[0]),'原密码不正确')
                set_password(body.get('password','')); return respond(200,{'ok':True})
            if path=='/api/state' and method=='GET': return respond(200,snapshot())
            if path=='/api/state' and method=='PUT':
                s=validate(body.get('state')); backup()
                with connect() as c:
                    c.execute('BEGIN IMMEDIATE'); rev=c.execute('SELECT revision FROM state WHERE id=1').fetchone()[0]
                    if body.get('revision')!=rev: return respond(409,{'error':'其他设备已更新账本，请刷新后重试。本次修改未覆盖服务器数据。'})
                    c.execute('UPDATE state SET revision=?,body=? WHERE id=1',(rev+1,json.dumps(s,ensure_ascii=False)))
                return respond(200,{'revision':rev+1})
            if path=='/api/upload' and method=='POST':
                data=body.get('data',''); match=re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)',data)
                require(match is not None,'仅支持 PNG、JPG、WEBP 图片')
                raw=base64.b64decode(match[2],validate=True); require(len(raw)<=8*1024*1024,'单张凭证最大 8MB')
                require(raw.startswith((b'\x89PNG\r\n\x1a\n',b'\xff\xd8\xff')) or (raw[:4]==b'RIFF' and raw[8:12]==b'WEBP'),'图片文件无效')
                name=secrets.token_hex(16)+'.'+{'jpeg':'jpg','png':'png','webp':'webp'}[match[1]]; (FILES/name).write_bytes(raw)
                return respond(201,{'id':name})
            if path=='/api/file' and method=='GET':
                name=parse_qs(env.get('QUERY_STRING','')).get('id',[''])[0]
                require(re.fullmatch(r'[a-f0-9]{32}\.(png|jpg|webp)',name),'凭证编号错误')
                f=FILES/name
                if not f.exists(): return respond(404,{'error':'凭证未找到'})
                return respond(200,content=f.read_bytes(),mime=mimetypes.guess_type(name)[0])
            return respond(404,{'error':'接口不存在'})
        if method!='GET': return respond(404,{'error':'接口不存在'})
        rel='index.html' if path=='/' else path.lstrip('/')
        f=(ROOT/'public'/rel).resolve(); pub=(ROOT/'public').resolve()
        if not f.is_relative_to(pub) or not f.is_file(): return respond(404,{'error':'页面不存在'})
        return respond(200,content=f.read_bytes(),mime=(mimetypes.guess_type(str(f))[0] or 'application/octet-stream')+('; charset=utf-8' if f.suffix in ['.html','.js','.css'] else ''))
    except (ValueError,KeyError,TypeError,OverflowError) as e: return respond(400,{'error':str(e)[:250] or '参数不正确'})
    except Exception:
        import traceback; traceback.print_exc(); return respond(500,{'error':'服务器处理失败，请稍后重试'})

init_db()
if __name__=='__main__':
    if '--set-password' in sys.argv:
        p=getpass.getpass('Set login password (minimum 10 characters): ')
        if p!=getpass.getpass('Confirm password: '): raise SystemExit('Passwords do not match')
        set_password(p); print('Login password saved.')
    elif '--tick' in sys.argv: snapshot(); backup()
    else:
        from wsgiref.simple_server import make_server
        port=int(os.environ.get('PORT','18761'))
        print('http://127.0.0.1:'+str(port),flush=True)
        make_server('127.0.0.1',port,application).serve_forever()
