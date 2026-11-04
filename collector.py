#!/usr/bin/env python3
"""Local weather research collector. No market data or accounts."""
import json,sqlite3,threading,time,urllib.request,urllib.parse,os
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path

ROOT=Path(__file__).resolve().parent; DB=ROOT/'weather.sqlite3'
CITIES={'NYC':('New York','KNYC','America/New_York'),'MDW':('Chicago','KMDW','America/Chicago'),'LAX':('Los Angeles','KLAX','America/Los_Angeles')}
LOCK=threading.Lock(); STATUS={'running':False,'last_attempt':None,'last_success':None,'error':None}
def db():
 c=sqlite3.connect(DB,timeout=20);c.row_factory=sqlite3.Row;return c
def init():
 with db() as c:c.executescript('''CREATE TABLE IF NOT EXISTS forecast (city TEXT, target_date TEXT, model_run TEXT, collected_at TEXT, points TEXT, PRIMARY KEY(city,target_date,model_run)); CREATE TABLE IF NOT EXISTS climate (city TEXT, target_date TEXT, high REAL, observed_at TEXT, source TEXT, PRIMARY KEY(city,target_date)); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT);''')
def fetch(url,params):
 q=urllib.parse.urlencode(params,doseq=True);req=urllib.request.Request(url+'?'+q,headers={'User-Agent':'FieldnoteWeatherResearch/0.1 (local research)'})
 with urllib.request.urlopen(req,timeout=25) as r:return json.load(r)
def now():return datetime.now(timezone.utc)
def update():
 if not LOCK.acquire(blocking=False):return False
 STATUS.update(running=True,last_attempt=now().isoformat(),error=None)
 try:
  data=fetch('https://mesonet.agron.iastate.edu/api/1/mos.json',{'station':[v[1] for v in CITIES.values()],'model':'GFS'})['data']
  captured=now(); saved=0
  with db() as c:
   for key,(_,station,tzname) in CITIES.items():
    zone=ZoneInfo(tzname);target=captured.astimezone(zone).date()+timedelta(days=1); points=[]; runs=set()
    for row in data:
     if row.get('station')!=station or row.get('tmp') is None:continue
     ft=datetime.fromisoformat(row['ftime_utc']).replace(tzinfo=timezone.utc); run=datetime.fromisoformat(row['runtime_utc']).replace(tzinfo=timezone.utc)
     if ft.astimezone(zone).date()==target and ft>captured and run<=captured:
      points.append({'time_utc':ft.isoformat(),'local_time':ft.astimezone(zone).isoformat(),'temp_f':float(row['tmp'])});runs.add(run.isoformat())
    if len(points)>=6 and len(runs)==1:
     points.sort(key=lambda x:x['time_utc']);cur=c.execute('INSERT OR IGNORE INTO forecast VALUES (?,?,?,?,?)',(key,target.isoformat(),runs.pop(),captured.isoformat(),json.dumps(points)));saved+=cur.rowcount
  errs=[]
  for key,(_,station,tzname) in CITIES.items():
   try:
    year=captured.astimezone(ZoneInfo(tzname)).year
    reports=fetch('https://mesonet.agron.iastate.edu/json/cli.py',{'station':station,'year':year})['results']
    with db() as c:
     for item in reports:
      day=item.get('valid','');hi=item.get('high')
      if day>=(captured.date()-timedelta(days=14)).isoformat() and isinstance(hi,(int,float)):
       c.execute('INSERT INTO climate VALUES(?,?,?,?,?) ON CONFLICT(city,target_date) DO UPDATE SET high=excluded.high, observed_at=excluded.observed_at,source=excluded.source',(key,day,hi,now().isoformat(),'https://mesonet.agron.iastate.edu'+item.get('link','')))
   except Exception as e:errs.append(key+': '+str(e)[:120])
  if saved==0:
   with db() as c:existing=c.execute('SELECT COUNT(*) FROM forecast').fetchone()[0]
   if not existing:raise RuntimeError('No complete next-day forecast returned by source')
  STATUS.update(last_success=now().isoformat(),error='Climate report partial: '+ '; '.join(errs) if errs else None)
  with db() as c:c.execute('INSERT OR REPLACE INTO meta VALUES (?,?)',('last_success',STATUS['last_success']))
  return True
 except Exception as e:STATUS['error']=str(e)[:300];return False
 finally:STATUS['running']=False;LOCK.release()
def payload():
 with db() as c:
  result=[]
  for key,(name,station,zone) in CITIES.items():
   row=c.execute('SELECT * FROM forecast WHERE city=? ORDER BY target_date DESC, collected_at DESC LIMIT 1',(key,)).fetchone()
   history=c.execute('''SELECT f.*,c.high,c.observed_at,c.source FROM forecast f JOIN climate c ON f.city=c.city AND f.target_date=c.target_date WHERE f.city=? ORDER BY f.target_date DESC, f.collected_at ASC LIMIT 12''',(key,)).fetchall()
   # Only earliest independently recorded forecast for each target day in reviews.
   seen=set();reviews=[]
   for h in sorted(history,key=lambda x:(x['target_date'],x['collected_at'])):
    if h['target_date'] in seen:continue
    seen.add(h['target_date']);pp=json.loads(h['points']);reviews.append({'date':h['target_date'],'forecast_high':max(x['temp_f'] for x in pp),'actual_high':h['high'],'collected_at':h['collected_at'],'model_run':h['model_run'],'actual_source':h['source']})
   item={'id':key,'name':name,'station':station,'timezone':zone,'forecast':None,'reviews':reviews[::-1]}
   if row:
    p=json.loads(row['points']);item['forecast']={'date':row['target_date'],'model_run':row['model_run'],'collected_at':row['collected_at'],'points':p,'sample_high':max(x['temp_f'] for x in p)}
   result.append(item)
  last=c.execute('SELECT value FROM meta WHERE key=?',('last_success',)).fetchone()
 return {'cities':result,'status':dict(STATUS,last_success=STATUS['last_success'] or (last['value'] if last else None)),'server_time':now().isoformat()}
def loop():
 while True:
  update();time.sleep(1800)
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path.split('?')[0]=='/api/weather':body=json.dumps(payload()).encode();ctype='application/json; charset=utf-8'
  elif self.path in ('/','/index.html'):body=(ROOT/'index.html').read_bytes();ctype='text/html; charset=utf-8'
  else:self.send_error(404);return
  self.send_response(200);self.send_header('Content-Type',ctype);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*a):pass
if __name__=='__main__':
 init();threading.Thread(target=loop,daemon=True).start();print('Fieldnote running: http://127.0.0.1:8766',flush=True);ThreadingHTTPServer(('127.0.0.1',8766),Handler).serve_forever()
