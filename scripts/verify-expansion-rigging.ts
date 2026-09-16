import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

type Region = 'kanto'|'johto'|'hoenn'|'sinnoh'|'unova'|'kalos'|'alola'|'galar'|'paldea';
const ranges: Record<Region,readonly [number,number]>={kanto:[1,151],johto:[152,251],hoenn:[252,386],sinnoh:[387,493],unova:[494,649],kalos:[650,721],alola:[722,809],galar:[810,905],paldea:[906,1025]};
const selected=process.argv.includes('--region')?process.argv[process.argv.indexOf('--region')+1] as Region|undefined:undefined;
if(selected&&!ranges[selected]) throw new Error(`--region must be one of ${Object.keys(ranges).join(', ')}`);
const idsArg=process.argv.includes('--ids')?process.argv[process.argv.indexOf('--ids')+1]:undefined;
const catalog=JSON.parse(readFileSync('src/data/pokemon-models-manifest.json','utf8')) as {catalog:{expandedEntries:Array<{id:number}>}};
const available=new Set([...Array.from({length:151},(_,index)=>index+1),...catalog.catalog.expandedEntries.map(entry=>entry.id)]);
const requested=idsArg?idsArg.split(',').map(Number):selected?Array.from({length:ranges[selected][1]-ranges[selected][0]+1},(_,i)=>i+ranges[selected][0]):[...available].filter(id=>id>=252).sort((a,b)=>a-b);
if(requested.some(id=>!Number.isInteger(id)||id<1||id>1025)) throw new Error('--ids must be comma-separated National Dex IDs 1..1025');
const ids=requested.filter(id=>available.has(id));
const expandedRoot='data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65';
const legacyRoot='data/local/pokemon-models/00d96f7f18894055e7f1db44fa0df6462e5e4c8a';
const sourcePath=(id:number)=>id<=151?`${legacyRoot}/${String(id).padStart(3,'0')}.glb`:`${expandedRoot}/${id}.glb`;
const out='artifacts/research/region-expansion';mkdirSync(out,{recursive:true});
const outputTag=selected?`-${selected}`:idsArg?'-selected':'';
const browser=await chromium.launch({headless:true});const page=await browser.newPage();
await page.route('**/rig-source/*.glb',async route=>{const id=Number(new URL(route.request().url()).pathname.match(/\/rig-source\/(\d+)\.glb$/)?.[1]);if(!id){await route.continue();return;}await route.fulfill({body:readFileSync(sourcePath(id)),contentType:'model/gltf-binary'});});
await page.goto('http://127.0.0.1:5173/data/connectome.json');
const results:unknown[]=[];
try{for(const id of ids){try{const result=await page.evaluate(async id=>{const path='/scripts/johto-rig-probe.ts';const {probeJohtoRig}=await import(/* @vite-ignore */ path);return probeJohtoRig(id,false);},id);if(process.argv.includes('--capture'))writeFileSync(`${out}/rig-${id}.png`,Buffer.from(result.image.split(',')[1],'base64'));results.push({...result,image:undefined,sourceSha256:createHash('sha256').update(readFileSync(sourcePath(id))).digest('hex'),visualReview:'requires-human-inspection'});console.log(JSON.stringify({id,passed:result.passed,sourceClips:result.sourceClips,authored:Boolean(result.authored),skin:result.skinnedMeshes,rigMs:Math.round(result.rigMs)}));}catch(error){results.push({id,passed:false,error:String(error),visualReview:'not-reached'});console.log(JSON.stringify({id,error:String(error)}));}
writeFileSync(`${out}/rig-verification${outputTag}.json`,JSON.stringify({schema:1,generatedAt:new Date().toISOString(),scope:{region:selected,ids:[ids[0],ids.at(-1)],count:ids.length,requested:requested.length,unavailable:requested.filter(id=>!available.has(id))},results},null,2)+'\n');}}
finally{await browser.close();}
const nativeResults=results.filter(result=>(result as {sourceClips?:number}).sourceClips).map(result=>{const value=result as {id:number,passed:boolean,sourceClips:number,sourceClipResults?:unknown[],authoredClipResults?:unknown[],sourceAnimationPassed?:boolean,authoredAnimationPassed?:boolean,authored?:{reason?:string,sourceClipsPreserved?:number},sourceSha256?:string,error?:string};return{id:value.id,sourceSha256:value.sourceSha256,sourceClips:value.sourceClips,sourceClipResults:value.sourceClipResults,sourceAnimationPassed:value.sourceAnimationPassed,authoredFallback:{reason:value.authored?.reason,sourceClipsPreserved:value.authored?.sourceClipsPreserved,clipResults:value.authoredClipResults,passed:value.authoredAnimationPassed},passed:value.passed,error:value.error};});
writeFileSync(`${out}/native-animation-verification${outputTag}.json`,JSON.stringify({schema:1,generatedAt:new Date().toISOString(),method:'Every source AnimationClip is sampled with AnimationMixer across 13 frames. SkinnedMesh vertices are compared before object transforms so rigid root motion cannot count as deformation. Every sampled pose must be finite and each species must have at least one source clip with measurable skin deformation, or preserve its static source clips and pass four explicitly marked authored fallback clips.',scope:{region:selected,ids:[ids[0],ids.at(-1)],count:ids.length,requested:requested.length,unavailable:requested.filter(id=>!available.has(id))},nativeSpecies:nativeResults.length,results:nativeResults},null,2)+'\n');
const failed=results.filter(result=>!(result as {passed:boolean}).passed);console.log(JSON.stringify({checked:results.length,passed:results.length-failed.length,failed:failed.length}));if(failed.length)process.exitCode=1;
