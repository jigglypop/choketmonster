import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const baseURL = process.env.CHOKETMON_BASE_URL ?? 'http://127.0.0.1:5173';
const output = process.env.CHOKETMON_GUI_PROFILE_ARTIFACTS ?? 'artifacts/save-gui-profile';
const includeRafControl = process.env.CHOKETMON_GUI_PROFILE_SUSPEND_RAF === '1';
const putDelayMs = Number(process.env.CHOKETMON_GUI_PROFILE_PUT_DELAY_MS ?? 0);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
const username = `gui_profile_${Date.now().toString(36)}`, password = `Test-${crypto.randomUUID()}-pass`;
try {
  await page.goto('/data/connectome.json');
  const seeded = await page.evaluate(async ({ username, password }) => {
    const enginePath='/src/game/engine.ts', connectomePath='/src/game/connectome.ts', storagePath='/src/game/storage.ts', simulationPath='/src/openworld/simulation.ts';
    const [{createGame},{ConnectomeController},storage,{OpenWorldSimulation}] = await Promise.all([import(/* @vite-ignore */enginePath),import(/* @vite-ignore */connectomePath),import(/* @vite-ignore */storagePath),import(/* @vite-ignore */simulationPath)]);
    const graph=await fetch('/data/connectome.json').then(r=>r.json());
    const game=createGame(4,`gui-profile-${Date.now()}`); new ConnectomeController(graph).ensure(game.player.team[0]);
    const world=new OpenWorldSimulation(graph,game,789123).snapshot();
    const save=storage.packSave(game,graph,{...storage.defaultView(),openWorld:world,openWorldPaused:true});
    const response=await fetch('/api/auth/register',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
    if(!response.ok) throw new Error(`register ${response.status}`); const {user}=await response.json();
    await storage.activateSaveProfile(user); await storage.writeSave(save); const checkpoint=await storage.checkpointSave('manual');
    return {bytes:JSON.stringify(save).length,revision:checkpoint.revision};
  }, {username,password});
  await page.goto('/');
  await page.waitForSelector('#ow-host[data-ready="true"]',{timeout:30000});
  await page.waitForSelector('.account-name:not([hidden])',{timeout:30000});
  await page.waitForTimeout(2000);

  const measure = async (suspendRaf) => page.evaluate(async ({suspendRaf,putDelayMs}) => {
    const started=performance.now(), events=[], longTasks=[];
    const note=(name,detail={})=>events.push({name,atMs:performance.now()-started,...detail});
    const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries()) longTasks.push({startMs:entry.startTime-started,durationMs:entry.duration});});
    try{observer.observe({entryTypes:['longtask']});}catch{}
    const originalPut=IDBObjectStore.prototype.put, originalFetch=window.fetch, originalRaf=window.requestAnimationFrame;
    IDBObjectStore.prototype.put=function(value,key){
      const store=this.name, tx=this.transaction; note(`idb:${store}:put-call`,{key:String(key??'')});
      const request=originalPut.call(this,value,key); request.addEventListener('success',()=>note(`idb:${store}:request-success`,{key:String(key??'')}),{once:true});
      tx.addEventListener('complete',()=>note(`idb:${store}:tx-complete`,{key:String(key??'')}),{once:true}); return request;
    };
    window.fetch=(async(input,init)=>{if(init?.method==='PUT'&&String(input).includes('/api/saves/current')){note('fetch:put-call',{bytes:typeof init.body==='string'?init.body.length:0});const response=await originalFetch(input,init);note('fetch:put-response',{status:response.status});if(putDelayMs>0){await new Promise(resolve=>setTimeout(resolve,putDelayMs));note('fetch:put-delay-released',{putDelayMs});}return response;}return originalFetch(input,init);});
    if(suspendRaf){window.requestAnimationFrame=(()=>0);await new Promise(resolve=>setTimeout(resolve,100));note('raf:suspended');}
    const toast=document.querySelector('#toast'); toast.textContent=''; toast.hidden=true;
    const clickStart=performance.now(); document.querySelector('#save-now').click(); note('click:return',{durationMs:performance.now()-clickStart});
    const deadline=performance.now()+30000;
    while(performance.now()<deadline){if(toast.textContent.includes('서버와 동기화했습니다.'))break;await new Promise(resolve=>setTimeout(resolve,20));}
    note('toast:complete',{text:toast.textContent}); await new Promise(resolve=>setTimeout(resolve,100));
    observer.disconnect(); IDBObjectStore.prototype.put=originalPut; window.fetch=originalFetch; if(suspendRaf)window.requestAnimationFrame=originalRaf;
    return {suspendRaf,totalMs:performance.now()-started,events,longTasks};
  }, {suspendRaf,putDelayMs});
  const active=await measure(false);
  const suspended=includeRafControl?(await page.waitForTimeout(1500),await measure(true)):undefined;
  const result={seeded,active,...(suspended?{suspended}:{})};
  mkdirSync(output,{recursive:true}); writeFileSync(`${output}/gui-stages.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally { await context.close(); await browser.close(); }

