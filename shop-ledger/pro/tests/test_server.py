import unittest, tempfile, os, sys, json, io, datetime, copy
os.environ['LEDGER_DATA']=tempfile.mkdtemp(prefix='ledger-test-')
sys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))
import server

class LedgerTest(unittest.TestCase):
    def setUp(self):
        with server.connect() as c:
            c.execute('UPDATE state SET revision=0,body=?',(json.dumps(server.initial()),)); c.execute('DELETE FROM attempts')
        server.set_password('unit-test-password')
        self.cookie='';self.csrf=''
    def call(self,path,method='GET',body=None,**extra):
        raw=json.dumps(body or {}).encode(); env={'PATH_INFO':path,'REQUEST_METHOD':method,'wsgi.input':io.BytesIO(raw),'CONTENT_LENGTH':str(len(raw)),'HTTP_COOKIE':self.cookie,'HTTP_HOST':'localhost','REMOTE_ADDR':'127.0.0.1','HTTP_X_CSRF_TOKEN':self.csrf,'wsgi.url_scheme':'http',**extra};meta={}
        result=b''.join(server.application(env,lambda status,headers:meta.update(code=int(status.split()[0]),headers=dict(headers))))
        return meta,json.loads(result)
    def login(self):
        m,d=self.call('/api/login','POST',{'password':'unit-test-password'});self.assertEqual(m['code'],200);self.cookie=m['headers']['Set-Cookie'].split(';')[0];self.csrf=d['csrf']
    def row(self,**kwargs):
        r=dict(id='one',date='2026-09-17',type='expense',book='default',category='cat0',project='采购',amount=1001,currency='CNY',rate=1,splits=[dict(account='acc0',amount=1001)],attachments=[])
        r.update(kwargs);return r
    def test_private(self):
        self.assertEqual(self.call('/api/state')[0]['code'],401)
    def test_password(self):
        self.assertEqual(self.call('/api/login','POST',{'password':'wrong'})[0]['code'],401)
        self.login();self.assertEqual(self.call('/api/state')[0]['code'],200)
    def test_save_conflict(self):
        self.login();s=server.initial();s['records']=[self.row()]
        self.assertEqual(self.call('/api/state','PUT',{'state':s,'revision':0})[0]['code'],200)
        self.assertEqual(self.call('/api/state','PUT',{'state':s,'revision':0})[0]['code'],409)
        self.assertEqual(len(self.call('/api/state')[1]['state']['records']),1)
    def test_bad_amount(self):
        self.login();s=server.initial();s['records']=[self.row(amount=1002)]
        self.assertEqual(self.call('/api/state','PUT',{'state':s,'revision':0})[0]['code'],400)
    def test_split(self):
        s=server.initial();s['records']=[self.row(splits=[dict(account='acc0',amount=501),dict(account='acc1',amount=500)])];server.validate(s)
    def test_refund_limit(self):
        s=server.initial();s['records']=[self.row(),self.row(id='refund',type='refund',related='one')];server.validate(s)
        s['records'].append(self.row(id='refund2',type='refund',related='one'))
        with self.assertRaises(ValueError):server.validate(s)
    def test_category_kind(self):
        s=server.initial();s['records']=[self.row(category='cat6')]
        with self.assertRaises(ValueError):server.validate(s)
    def test_transfer(self):
        s=server.initial();s['records']=[self.row(type='transfer',target='acc1',targetAmount=1001)];server.validate(s)
        s['records'][0]['target']='acc0'
        with self.assertRaises(ValueError):server.validate(s)
    def test_bad_date(self):
        s=server.initial();s['records']=[self.row(date='2026-02-30')]
        with self.assertRaises(ValueError):server.validate(s)
    def test_schedule_idempotent(self):
        s=server.initial();s['plans']=[dict(id='repeat',record=self.row(),next=datetime.date.today().isoformat(),interval='month',anchor=31,remaining=2)]
        self.assertTrue(server.materialize(s));self.assertFalse(server.materialize(s));self.assertEqual(len(s['records']),1)
        self.assertEqual(server.advance(datetime.date(2026,1,31),'month',31),datetime.date(2026,2,28))
        self.assertEqual(server.advance(datetime.date(2026,2,28),'month',31),datetime.date(2026,3,31))
    def test_csrf_and_origin(self):
        self.login();self.assertEqual(self.call('/api/logout','POST',{},HTTP_ORIGIN='https://evil.example')[0]['code'],403)
        self.assertEqual(self.call('/api/logout','POST',{},HTTP_X_CSRF_TOKEN='wrong')[0]['code'],403)
    def test_traversal(self):
        self.assertEqual(self.call('/../server.py')[0]['code'],404)
    def test_rate_limit(self):
        for _ in range(10):self.call('/api/login','POST',{'password':'wrong'})
        self.assertEqual(self.call('/api/login','POST',{'password':'wrong'})[0]['code'],429)

if __name__=='__main__':unittest.main()
