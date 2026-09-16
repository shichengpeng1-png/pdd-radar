(function(root){
'use strict';
const types={expense:'支出',income:'收入',transfer:'转账',refund:'退款',reimbursement:'报销到账'};
const id=()=>{const b=new Uint8Array(16);crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('')};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
function amount(value){let s=String(value??'').replace(/[¥￥$,，\s]/g,'');if(!/^-?\d+(\.\d{1,2})?$/.test(s))return null;const n=Number(s);return Number.isSafeInteger(Math.round(n*100))?Math.round(n*100):null}
function money(c,currency='CNY'){return new Intl.NumberFormat('zh-CN',{style:'currency',currency,minimumFractionDigits:2}).format(c/100)}
function base(r){return Math.round(r.amount*r.rate)}
function totals(rs){let income=0,expense=0,transfer=0;for(const r of rs){if(r.type==='income')income+=base(r);else if(r.type==='expense')expense+=base(r);else if(['refund','reimbursement'].includes(r.type))expense-=base(r);else transfer+=base(r)}return{income,expense,net:income-expense,transfer}}
function balances(s){const m=Object.fromEntries(s.accounts.map(a=>[a.id,a.initial]));for(const r of s.records){const sign=['income','refund','reimbursement'].includes(r.type)?1:-1;for(const p of r.splits)m[p.account]=(m[p.account]||0)+sign*p.amount;if(r.type==='transfer')m[r.target]=(m[r.target]||0)+r.targetAmount}return m}
function splitInstallments(total,count){if(!Number.isInteger(count)||count<1||count>600)throw Error('期数应在 1～600');let a=Array(count).fill(Math.floor(total/count));for(let i=0;i<total%count;i++)a[i]++;return a}
function csv(text){let out=[],row=[],cell='',quote=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quote&&text[i+1]==='"'){cell+='"';i++}else quote=!quote}else if(c===','&&!quote){row.push(cell);cell=''}else if((c==='\n'||c==='\r')&&!quote){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))out.push(row);row=[];cell=''}else cell+=c}if(quote)throw Error('CSV 引号不完整');row.push(cell);if(row.some(x=>x.trim()))out.push(row);return out}
function csvWrite(rows){return '\uFEFF'+rows.map(row=>row.map(v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"').join(',')).join('\r\n')}
function normalizeDate(s){const m=String(s).match(/(20\d{2})\s*[年\/.\-]\s*(\d{1,2})\s*[月\/.\-]\s*(\d{1,2})/);if(!m)return '';const d=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;return new Date(d+'T12:00:00').getDate()===Number(m[3])?d:''}
function ocr(text){
const lines=String(text).replace(/[０-９]/g,c=>String(c.charCodeAt(0)-0xff10)).replace(/[．]/g,'.').replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g,'$1').split(/\r?\n/).map(s=>s.trim()).filter(Boolean),full=lines.join('\n');
const paymentLine=lines.find(l=>/支付方式|付款方式/.test(l))||'';
const paymentDetail=paymentLine.replace(/^.*?(?:支付方式|付款方式)[:：\s”"']*/,'').trim();
const payment=/银行|储蓄卡|信用卡|借记卡/.test(paymentDetail)?'银行卡':/零钱|微信/.test(paymentDetail)?'微信':/支付宝|余额宝|花呗/.test(paymentDetail)?'支付宝':/银行|储蓄卡|信用卡/.test(full)?'银行卡':/支付宝/.test(full)?'支付宝':/微信/.test(full)?'微信':'';
const defaultDate=normalizeDate(lines.find(l=>/转账时间|交易时间|付款时间|支付时间/.test(l))||full);
const receiptTime=full.match(/\b\d{2}:\d{2}:\d{2}\b/)?.[0]||'';
const excluded=/优惠|折扣|减免|原价|单价|余额|订单号|交易号|流水号|商户号|手机号|订单编号|交易单号|退款/;
const rank=l=>/实付|实际支付|实际付款|实付款|实收|实际到账/.test(l)?4:/付款金额|支付金额|收款金额|到账金额/.test(l)?3:/应付|总金额|合计|总计/.test(l)?1:0;
function values(line,loose=false){
 if(excluded.test(line)&&!rank(line))return[];
 const s=line.replace(/(?<![\d.])([+-]?\d{1,3}(?:[.,，]\d{3})+)\.(\d{2})(?!\d)/g,(_,a,b)=>a.replace(/[.,，]/g,'')+'.'+b).replace(/[,，](?=\d{3}(?:\D|$))/g,'').replace(/(\d)\s*\.\s*(\d{1,2})(?!\d)/g,'$1.$2');
 const pattern=loose?/(?<![\d.])[-+]?\d+(?:\.\d{1,2})?(?![\d.])/g:/(?:[¥￥]\s*|(?:^|\s)[+-]\s*)(\d+(?:\.\d{1,2})?)(?![\d.])|(?:^|\s)(\d+\.\d{2})(?=元|\s|$)/g;
 return [...s.matchAll(pattern)].map(m=>Math.abs(amount(loose?m[0]:m[1]||m[2])??0)).filter(n=>n>0&&n<100000000000);
}
const project=lines.find(l=>l.length>=2&&!/微信|支付宝|支付|付款|金额|订单|单号|交易|时间|状态|实付|合计|优惠|原价|余额|收款|^\d|^[¥￥+-]/.test(l))||'';
const draft=(n,p=project,raw=full)=>({date:defaultDate,project:p,amount:n,payment,paymentDetail,transactionTime:receiptTime,type:/收款成功|收款金额|实收|到账金额/.test(full)?'income':'expense',note:'OCR 识别，请核对',raw});
// Repeated dated rows are a ledger table, not competing totals on one receipt.
const dated=lines.filter(l=>normalizeDate(l)&&/\d{2}:\d{2}:\d{2}/.test(l));
if(dated.length>=2){return dated.map(line=>{const ns=values(line),n=ns.length===1?ns[0]:null,withdraw=/提现/.test(full),time=line.match(/\d{2}:\d{2}:\d{2}/)[0];return{...draft(n,withdraw?'货款提现':/收入/.test(line)?'平台收入':/支出/.test(line)?'平台支出':line.split(/20\d{2}[-/.]/)[0].trim()||'平台流水',line),date:normalizeDate(line),transactionTime:time,transactionId:/交易\s*(?:ID|编号|单号)/i.test(full)?(line.match(/\d{2}:\d{2}:\d{2}\s+(\d{6,40})\b/)?.[1]||''):'',type:withdraw?'transfer':/收入|收款|\+/.test(line)?'income':'expense',targetAmount:withdraw?n:0,amountHint:n===null?'该行金额不清晰，请填写；已保留此行':'已按表格逐行提取，请核对收支类型与账户'}})}
const candidates=[];
for(let i=0;i<lines.length;i++){
 const score=rank(lines[i]);if(!score)continue;
 // Only parse the text after the monetary label: preceding order numbers are not amounts.
 const tail=lines[i].replace(/^.*?(?:实付款|实际支付|实际付款|实际到账|实付|实收|付款金额|支付金额|收款金额|到账金额|应付|总金额|合计|总计)/,'');
 let ns=values(tail,true);
 if(!ns.length&&lines[i+1]&&!normalizeDate(lines[i+1])&&!excluded.test(lines[i+1])&&!rank(lines[i+1]))ns=values(lines[i+1],/^[¥￥\s+-]*\d+[\d.,，\s元]*$/.test(lines[i+1]));
 for(const n of ns)candidates.push({n,score});
}
if(candidates.length){const top=Math.max(...candidates.map(c=>c.score)),ns=[...new Set(candidates.filter(c=>c.score===top).map(c=>c.n))];if(ns.length===1)return[{...draft(ns[0]),amountHint:top>=3?'已优先取实际付款 / 收款金额，请对照截图核对':'仅识别到合计或应付金额，请核对是否实付'}];return[{...draft(null),amountHint:'识别到多个不同金额，请对照原图填写，未自动选取'}]}
let rows=[],context=[],currentDate=defaultDate;
for(const line of lines){const d=normalizeDate(line);if(d){currentDate=d;context.push(line)}if(excluded.test(line)){continue}const ns=values(line);if(ns.length===1){let p=line.replace(/[¥￥]?\s*[-+]?\d+(?:\.\d{1,2})?/g,'').trim();if(/资金类型|流水类型|交易金额|交易全额/.test(full)){p=/收入/.test(line)?'平台收入':/支出/.test(line)?'平台支出':'平台流水'}else if(!p||/支付|收入|支出/.test(p))p=context.slice().reverse().find(l=>!/微信|支付宝|账单|交易|收入|支出|支付成功/.test(l)&&!normalizeDate(l))||project;rows.push({...draft(ns[0],p,[...context,line].join('\n')),date:currentDate,transactionTime:line.match(/\b\d{2}:\d{2}:\d{2}\b/)?.[0]||receiptTime,transactionId:/交易\s*(?:ID|编号|单号)/i.test(full)?(line.match(/\d{2}:\d{2}:\d{2}\s+(\d{6,40})\b/)?.[1]||''):'',type:/收入|收款|\+/.test(line)?'income':'expense',amountHint:'未找到实付标签，请核对截图金额'});context=[]}else context.push(line)}
if(rows.length>1&&!/账单|明细/.test(full)&&!lines.some(l=>/(?:^|\s)[-+]\s*\d/.test(l)))return[{...draft(null),amountHint:'截图包含多个金额，无法确定实付金额，请填写'}];
return rows.length?rows:[{...draft(null),amountHint:'未能可靠识别金额，请对照截图填写'}];
}

function budgetUsed(s,b,now=today()){const d=new Date(now+'T12:00:00');let start,end;if(b.period==='year'){start=now.slice(0,4)+'-01-01';end=now.slice(0,4)+'-12-31'}else if(b.period==='week'){let day=(d.getDay()+6)%7;d.setDate(d.getDate()-day);start=localDate(d);d.setDate(d.getDate()+6);end=localDate(d)}else{start=now.slice(0,7)+'-01';end=now.slice(0,7)+'-31'}let ids=b.category?[b.category,...s.categories.filter(c=>c.parent===b.category).map(c=>c.id)]:[];return totals(s.records.filter(r=>r.book===b.book&&r.date>=start&&r.date<=end&&(!ids.length||ids.includes(r.category)))).expense}
function localDate(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function addMonths(day,n){let d=new Date(day+'T12:00:00'),anchor=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+n);d.setDate(Math.min(anchor,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));return localDate(d)}
function legacyFingerprint(r){return [r.date,r.book,r.type,r.project.trim(),r.amount,r.currency,r.source||''].join('|')}
function fingerprint(r){return r.transactionId?['tx',r.book,r.source||'',r.transactionId].join('|'):r.transactionTime?legacyFingerprint(r)+'|'+r.transactionTime:legacyFingerprint(r)}
function importMatcher(records){const seen=new Set(records.filter(r=>r.transactionId||r.transactionTime).map(fingerprint)),legacy=new Map();for(const r of records.filter(r=>!r.transactionId&&!r.transactionTime)){const k=legacyFingerprint(r);legacy.set(k,(legacy.get(k)||0)+1)}return r=>{const key=fingerprint(r);if((r.transactionId||r.transactionTime)&&seen.has(key))return true;const old=legacyFingerprint(r),count=legacy.get(old)||0;if(count){legacy.set(old,count-1);if(r.transactionId||r.transactionTime)seen.add(key);return true}if(r.transactionId||r.transactionTime)seen.add(key);return false}}
const api={id,today,amount,money,base,totals,balances,splitInstallments,csv,csvWrite,normalizeDate,ocr,importMatcher,budgetUsed,types,addMonths,fingerprint};root.Ledger=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
