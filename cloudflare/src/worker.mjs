const CITIES = {
  NYC: { name: 'New York', station: 'KNYC', network:'NY_ASOS', timezone: 'America/New_York' },
  MDW: { name: 'Chicago', station: 'KMDW', network:'IL_ASOS', timezone: 'America/Chicago' },
  LAX: { name: 'Los Angeles', station: 'KLAX', network:'CA_ASOS', timezone: 'America/Los_Angeles' },
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
  // Observations are independent of the forecast; preserve the last good reading on failure.
  const observationErrors=[];
  for(const [id,c] of Object.entries(CITIES)) {
    try {
      const path=`/json/current.py?network=${c.network}&station=${id}`;
      const o=await getJSON(path), reading=o.last_ob;
      if(o.id!==id || o.network!==c.network || !reading || typeof reading['airtemp[F]']!=='number' || !Number.isFinite(reading['airtemp[F]']) || !reading.utc_valid || !Number.isFinite(Date.parse(reading.utc_valid)) || Date.parse(reading.utc_valid)>Date.now()+300000 || !String(reading.raw||'').startsWith(c.station+' ')) throw Error('Invalid station observation');
      const value={temperature_f:reading['airtemp[F]'],observed_at:reading.utc_valid,recorded_at:iso(new Date()),source:BASE+path};
      await env.DB.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').bind('observation_'+id,JSON.stringify(value)).run();
    } catch(e) { observationErrors.push(`${id}: ${e.message}`); }
  }
  await env.DB.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').bind('observation_error',observationErrors.join('; ')).run();
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
  const meta=await env.DB.prepare('SELECT key,value FROM meta').all();const map=Object.fromEntries(meta.results.map(r=>[r.key,r.value]));
  for(const [id,c] of Object.entries(CITIES)) {
    const data=await env.DB.prepare('SELECT * FROM forecast WHERE city=? AND target_date IN (SELECT DISTINCT target_date FROM forecast WHERE city=? ORDER BY target_date DESC LIMIT 5) ORDER BY target_date DESC, collected_at DESC').bind(id,id).all();
    const grouped=new Map();
    for(const r of data.results) {
      const points=JSON.parse(r.points);
      if(!grouped.has(r.target_date)) grouped.set(r.target_date,{forecast:{date:r.target_date,model_run:r.model_run,collected_at:r.collected_at,points,sample_high:Math.max(...points.map(p=>p.temp_f))},runs:[]});
      grouped.get(r.target_date).runs.push({model_run:r.model_run,collected_at:r.collected_at,sample_high:Math.max(...points.map(p=>p.temp_f))});
    }
    const forecast_days=[...grouped.values()];
    for(const d of forecast_days) d.runs.reverse();
    const forecast=forecast_days[0]?.forecast||null, runs=forecast_days[0]?.runs||[];
    // Fail closed: these exact source versions and values were manually checked
    // as next-day YESTERDAY reports. A corrected source must be verified again.
    const verified={
      NYC:{date:'2026-11-04',high:72,source:BASE+'/api/1/nwstext/202611050633-KOKX-CDUS41-CLINYC'},
      MDW:{date:'2026-11-04',high:69,source:BASE+'/api/1/nwstext/202611050634-KLOT-CDUS43-CLIMDW'},
      LAX:{date:'2026-11-04',high:75,source:BASE+'/api/1/nwstext/202611050940-KLOX-CDUS46-CLILAX'},
    };
    const verifiedNext={
      NYC:{date:'2026-11-05',high:72,source:BASE+'/api/1/nwstext/202611060645-KOKX-CDUS41-CLINYC'},
      MDW:{date:'2026-11-05',high:55,source:BASE+'/api/1/nwstext/202611060640-KLOT-CDUS43-CLIMDW'},
      LAX:{date:'2026-11-05',high:78,source:BASE+'/api/1/nwstext/202611060954-KLOX-CDUS46-CLILAX'},
    };
    const verifiedThird={
      NYC:{date:'2026-11-06',high:70,source:BASE+'/api/1/nwstext/202611070626-KOKX-CDUS41-CLINYC'},
      MDW:{date:'2026-11-06',high:48,source:BASE+'/api/1/nwstext/202611070637-KLOT-CDUS43-CLIMDW'},
      LAX:{date:'2026-11-06',high:83,source:BASE+'/api/1/nwstext/202611070935-KLOX-CDUS46-CLILAX'},
    };
    const verifiedFourth={
      NYC:{date:'2026-11-07',high:61,source:BASE+'/api/1/nwstext/202611080652-KOKX-CDUS41-CLINYC'},
      MDW:{date:'2026-11-07',high:52,source:BASE+'/api/1/nwstext/202611080649-KLOT-CDUS43-CLIMDW'},
      LAX:{date:'2026-11-07',high:85,source:BASE+'/api/1/nwstext/202611080940-KLOX-CDUS46-CLILAX'},
    };
    const verifiedFifth={
      NYC:{date:'2026-11-08',high:60,source:BASE+'/api/1/nwstext/202611090628-KOKX-CDUS41-CLINYC'},
      MDW:{date:'2026-11-08',high:60,source:BASE+'/api/1/nwstext/202611090641-KLOT-CDUS43-CLIMDW'},
      LAX:{date:'2026-11-08',high:88,source:BASE+'/api/1/nwstext/202611090940-KLOX-CDUS46-CLILAX'},
    };
    const verifiedSixth={
      NYC:{date:'2026-11-09',high:58,source:BASE+'/api/1/nwstext/202611100627-KOKX-CDUS41-CLINYC'},
      MDW:{date:'2026-11-09',high:61,source:BASE+'/api/1/nwstext/202611100645-KLOT-CDUS43-CLIMDW'},
      LAX:{date:'2026-11-09',high:86,source:BASE+'/api/1/nwstext/202611100940-KLOX-CDUS46-CLILAX'},
    };
    const verifiedSeventh={
      NYC:{date:'2026-11-10',high:62,source:BASE+'/api/1/nwstext/202611110618-KOKX-CDUS41-CLINYC'},
      MDW:{date:'2026-11-10',high:66,source:BASE+'/api/1/nwstext/202611110637-KLOT-CDUS43-CLIMDW'},
      LAX:{date:'2026-11-10',high:84,source:BASE+'/api/1/nwstext/202611110940-KLOX-CDUS46-CLILAX'},
    };
    const reviews=[];
    for(const v of [verifiedSeventh[id],verifiedSixth[id],verifiedFifth[id],verifiedFourth[id],verifiedThird[id],verifiedNext[id],verified[id]].filter(Boolean)) {
      const history=await env.DB.prepare('SELECT f.*,c.high,c.source FROM forecast f JOIN climate c ON f.city=c.city AND f.target_date=c.target_date WHERE f.city=? AND f.target_date=? AND c.source=? AND c.high=? ORDER BY f.collected_at ASC LIMIT 1').bind(id,v.date,v.source,v.high).all();
      for(const h of history.results) reviews.push({date:h.target_date,forecast_high:Math.max(...JSON.parse(h.points).map(p=>p.temp_f)),actual_high:h.high,collected_at:h.collected_at,model_run:h.model_run,actual_source:h.source});
    }
    let observation=null; try { observation=JSON.parse(map['observation_'+id]||'null'); } catch {}
    cities.push({id,...c,forecast,runs,forecast_days,reviews,observation});
  }
  return {cities,status:{running:false,last_attempt:map.last_attempt||null,last_success:map.last_success||null,error:map.last_error||null,observation_error:map.observation_error||null},server_time:iso(new Date())};
}
export default {
 async scheduled(controller, env, ctx) { ctx.waitUntil(collect(env).catch(async e=>{await env.DB.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').bind('last_error',String(e.message).slice(0,300)).run(); throw e;})); },
 async fetch(request,env) {
   const url=new URL(request.url);if(url.pathname!='/weather.json' && url.pathname!='/health') return new Response('Not found',{status:404});
   try { const data=await payload(env);return Response.json(data,{headers:{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}}); }
   catch(e) { return Response.json({error:'Weather data unavailable'},{status:503,headers:{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}}); }
 }
};
