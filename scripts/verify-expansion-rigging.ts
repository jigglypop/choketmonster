import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

type Region = 'hoenn'|'sinnoh'|'unova';
const ranges: Record<Region,readonly [number,number]>={hoenn:[252,386],sinnoh:[387,493],unova:[494,649]};
const selected=process.argv.includes('--region')?process.argv[process.argv.indexOf('--region')+1] as Region|undefined:undefined;
if(selected&&!ranges[selected]) throw new Error('--region must be hoenn, sinnoh, or unova');
const idsArg=process.argv.includes('--ids')?process.argv[process.argv.indexOf('--ids')+1]:undefined;
const ids=idsArg?idsArg.split(',').map(Number):selected?Array.from({length:ranges[selected][1]-ranges[selected][0]+1},(_,i)=>i+ranges[selected][0]):Array.from({length:398},(_,i)=>i+252);
if(ids.some(id=>!Number.isInteger(id)||id<252||id>649)) throw new Error('--ids must be comma-separated National Dex IDs 252..649');
const sourceRoot='data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65';
const out='artifacts/research/region-expansion';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});const page=await browser.newPage();
await page.route('**/rig-source/*.glb',async route=>{const id=new URL(route.request().url()).pathname.match(/\/rig-source\/(\d+)\.glb$/)?.[1];if(!id){await route.continue();return;}await route.fulfill({body:readFileSync(`${sourceRoot}/${id}.glb`),contentType:'model/gltf-binary'});});
await page.goto('http://127.0.0.1:5173/data/connectome.json');
const results:unknown[]=[];
try{for(const id of ids){try{const result=await page.evaluate(async id=>{const path='/scripts/johto-rig-probe.ts';const {probeJohtoRig}=await import(/* @vite-ignore */ path);return probeJohtoRig(id,false);},id);if(process.argv.includes('--capture'))writeFileSync(`${out}/rig-${id}.png`,Buffer.from(result.image.split(',')[1],'base64'));results.push({...result,image:undefined,sourceSha256:createHash('sha256').update(readFileSync(`${sourceRoot}/${id}.glb`)).digest('hex'),visualReview:'requires-human-inspection'});console.log(JSON.stringify({id,passed:result.passed,sourceClips:result.sourceClips,authored:Boolean(result.authored),skin:result.skinnedMeshes,rigMs:Math.round(result.rigMs)}));}catch(error){results.push({id,passed:false,error:String(error),visualReview:'not-reached'});console.log(JSON.stringify({id,error:String(error)}));}
writeFileSync(`${out}/${idsArg?'rig-verification-selected.json':'rig-verification.json'}`,JSON.stringify({schema:1,generatedAt:new Date().toISOString(),scope:{ids:[ids[0],ids.at(-1)],count:ids.length},results},null,2)+'\n');}}
finally{await browser.close();}
const nativeResults=results.filter(result=>(result as {sourceClips?:number}).sourceClips).map(result=>{const value=result as {id:number,passed:boolean,sourceClips:number,sourceClipResults?:unknown[],authoredClipResults?:unknown[],sourceAnimationPassed?:boolean,authoredAnimationPassed?:boolean,authored?:{reason?:string,sourceClipsPreserved?:number},sourceSha256?:string,error?:string};return{id:value.id,sourceSha256:value.sourceSha256,sourceClips:value.sourceClips,sourceClipResults:value.sourceClipResults,sourceAnimationPassed:value.sourceAnimationPassed,authoredFallback:{reason:value.authored?.reason,sourceClipsPreserved:value.authored?.sourceClipsPreserved,clipResults:value.authoredClipResults,passed:value.authoredAnimationPassed},passed:value.passed,error:value.error};});
writeFileSync(`${out}/${idsArg?'native-animation-verification-selected.json':'native-animation-verification.json'}`,JSON.stringify({schema:1,generatedAt:new Date().toISOString(),method:'Every source AnimationClip is sampled with AnimationMixer across 13 frames. SkinnedMesh vertices are compared before object transforms so rigid root motion cannot count as deformation. Every sampled pose must be finite and each species must have at least one source clip with measurable skin deformation, or preserve its static source clips and pass four explicitly marked authored fallback clips.',scope:{ids:[ids[0],ids.at(-1)],count:ids.length},expectedNativeSpecies:idsArg?undefined:23,nativeSpecies:nativeResults.length,results:nativeResults},null,2)+'\n');
const failed=results.filter(result=>!(result as {passed:boolean}).passed);console.log(JSON.stringify({checked:results.length,passed:results.length-failed.length,failed:failed.length}));if(failed.length)process.exitCode=1;
