const CITIES = {
  NYC: { name: 'New York', station: 'KNYC', timezone: 'America/New_York' },
  MDW: { name: 'Chicago', station: 'KMDW', timezone: 'America/Chicago' },
  LAX: { name: 'Los Angeles', station: 'KLAX', timezone: 'America/Los_Angeles' },
};
const BASE = 'https://mesonet.agron.iastate.edu';
const iso = d => d.toISOString().replace(/\.000Z$/, '+00:00').replace(/Z$/, '+00:00');
function parts(d, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(d).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`, time:`${p.hour}:${p.minute}`};
}
function tomorrow(d, zone) {
  const date=parts(d,zone).date;
  const next=new Date(`${date}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+1);
  return next.toISOString().slice(0,10);
}
function utc(v) { return new Date(v.endsWith('Z') || /[+-]\d\d:\d\d$/.test(v) ? v : v+'Z'); }
async function getJSON(path) {
  const r=await fetch(BASE+path,{headers:{'User-Agent':'ForecastTrail/1.0 (weather research)'}});
  if(!r.ok) throw Error(`IEM returned HTTP ${r.status}`);
  return r.json();
}
export async function collect(env, now=new Date()) {
  const start=iso(now);
  await env.DB.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').bind('last_attempt',start).run();
  const args=new URLSearchParams({model:'GFS'}); for(const c of Object.values(CITIES))args.append('station',c.station);
  const data=(await getJSON('/api/1/mos.json?'+args)).data;
  if(!Array.isArray(data)) throw Error('Missing model data');
  const forecasts=[];
  for(const [id,c] of Object.entries(CITIES)) {
    const target=tomorrow(now,c.timezone); const runs=new Set(); const points=[];
    for(const r of data) {
      if(r.station!==c.station || r.tmp==null) continue;
      const ft=utc(r.ftime_utc), run=utc(r.runtime_utc), local=parts(ft,c.timezone);
      if(local.date===target && ft>now && run<=now) {
        points.push({time_utc:iso(ft), local_time:`${local.date}T${local.time}:00`,temp_f:Number(r.tmp)});runs.add(iso(run));
      }
    }
    if(points.length>=6 && runs.size===1) {
      points.sort((a,b)=>a.time_utc.localeCompare(b.time_utc));
      forecasts.push([id,target,[...runs][0],start,JSON.stringify(points)]);
    }
  }
  if(forecasts.length!==3) throw Error(`Incomplete next-day forecast: ${forecasts.length}/3 stations`);
  const stmts=forecasts.map(values=>env.DB.prepare('INSERT OR IGNORE INTO forecast VALUES (?,?,?,?,?)').bind(...values));
  await env.DB.batch(stmts);
  const errors=[];
  for(const [id,c] of Object.entries(CITIES)) {
    try {
      const year=parts(now,c.timezone).date.slice(0,4);
      const reports=(await getJSON(`/json/cli.py?station=${c.station}&year=${year}`)).results;
      if(!Array.isArray(reports)) throw Error('Missing climate reports');
      const threshold=new Date(now.getTime()-14*86400000).toISOString().slice(0,10);
      const up=[];
      for(const r of reports) if(r.valid>=threshold && typeof r.high==='number') {
        up.push(env.DB.prepare('INSERT INTO climate VALUES(?,?,?,?,?) ON CONFLICT(city,target_date) DO UPDATE SET high=excluded.high, observed_at=excluded.observed_at, source=excluded.source').bind(id,r.valid,r.high,iso(new Date()),BASE+(r.link||'')));
      }
      if(up.length) await env.DB.batch(up);
    } catch(e) { errors.push(`${id}: ${e.message}`); }
  }
  const done=iso(new Date());
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').bind('last_success',done),
    env.DB.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').bind('last_error',errors.length ? 'Climate report partial: '+errors.join('; ') : ''),
    env.DB.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').bind('last_attempt',start),
  ]);
  return {done, errors};
}
export async function payload(env) {
  const cities=[];
  for(const [id,c] of Object.entries(CITIES)) {
    const row=await env.DB.prepare('SELECT * FROM forecast WHERE city=? ORDER BY target_date DESC, collected_at DESC LIMIT 1').bind(id).first();
    let forecast=null, runs=[];
    if(row) {
      const points=JSON.parse(row.points); forecast={date:row.target_date,model_run:row.model_run,collected_at:row.collected_at,points,sample_high:Math.max(...points.map(p=>p.temp_f))};
      const all=await env.DB.prepare('SELECT * FROM forecast WHERE city=? AND target_date=? ORDER BY collected_at ASC').bind(id,row.target_date).all();
      runs=all.results.map(r=>({model_run:r.model_run,collected_at:r.collected_at,sample_high:Math.max(...JSON.parse(r.points).map(p=>p.temp_f))}));
    }
    const history=await env.DB.prepare('SELECT f.*,c.high,c.source FROM forecast f JOIN climate c ON f.city=c.city AND f.target_date=c.target_date WHERE f.city=? ORDER BY f.target_date DESC,f.collected_at ASC').bind(id).all();
    const seen=new Set(),reviews=[];
    for(const h of history.results) { if(seen.has(h.target_date)) continue; seen.add(h.target_date); if(reviews.length>=12)break;
      reviews.push({date:h.target_date,forecast_high:Math.max(...JSON.parse(h.points).map(p=>p.temp_f)),actual_high:h.high,collected_at:h.collected_at,model_run:h.model_run,actual_source:h.source}); }
    cities.push({id,...c,forecast,runs,reviews});
  }
  const meta=await env.DB.prepare('SELECT key,value FROM meta').all();const map=Object.fromEntries(meta.results.map(r=>[r.key,r.value]));
  return {cities,status:{running:false,last_attempt:map.last_attempt||null,last_success:map.last_success||null,error:map.last_error||null},server_time:iso(new Date())};
}
export default {
 async scheduled(controller, env, ctx) { ctx.waitUntil(collect(env).catch(async e=>{await env.DB.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').bind('last_error',String(e.message).slice(0,300)).run(); throw e;})); },
 async fetch(request,env) {
   const url=new URL(request.url);if(url.pathname!='/weather.json' && url.pathname!='/health') return new Response('Not found',{status:404});
   try { const data=await payload(env);return Response.json(data,{headers:{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}}); }
   catch(e) { return Response.json({error:'Weather data unavailable'},{status:503,headers:{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}}); }
 }
};
