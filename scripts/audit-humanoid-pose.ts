import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

type ProbeResult = { id:number; passed:boolean; image?:string; poseImages?:Record<string,string>; humanoidArmPose:{arms:unknown[];maxRotationFromBindRadians:number;minimumVerticalRatio:number|null;hasLoweredOrBentMotion:boolean;bothArmsLoweredInMultipleFrames:boolean} };
const IDS = [68,122,124,448,475,534,810,811,812,815,817,818,862,866,908,911,914,920,936,937,959,983,1006];
const legacyRoot='data/local/pokemon-models/00d96f7f18894055e7f1db44fa0df6462e5e4c8a';
const expandedRoot='data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65';
const researchRoot='data/local/pokemon-models-research/27703273836f38f0e185976d955b1fbfb15448af';
const HOME_IDS=new Set([866,936]);
const sourcePath=(id:number)=>id<=151?`${legacyRoot}/${String(id).padStart(3,'0')}.glb`:HOME_IDS.has(id)?`${researchRoot}/${id}.glb`:`${expandedRoot}/${id}.glb`;
const output='artifacts/research/humanoid-pose-audit';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true}),page=await browser.newPage();
await page.route('**/rig-source/*.glb',async route=>{const id=Number(new URL(route.request().url()).pathname.match(/\/rig-source\/(\d+)\.glb$/)?.[1]);await route.fulfill({body:readFileSync(sourcePath(id)),contentType:'model/gltf-binary'});});
await page.goto('http://127.0.0.1:5173/data/connectome.json');
const results:ProbeResult[]=[];
try{for(const id of IDS){const result=await page.evaluate(async speciesId=>{const path='/scripts/johto-rig-probe.ts';const {probeJohtoRig}=await import(/* @vite-ignore */ path);return probeJohtoRig(speciesId,false,true);},id) as ProbeResult;const images=result.poseImages!;const previews:Record<string,{path:string;sha256:string}>={};for(const [pose,data] of Object.entries(images)){const bytes=Buffer.from(data.split(',')[1],'base64'),path=`${output}/${id}-${pose}.png`;writeFileSync(path,bytes);previews[pose]={path,sha256:createHash('sha256').update(bytes).digest('hex')};}results.push({...result,image:undefined,poseImages:undefined,previews,source:{path:sourcePath(id),sha256:createHash('sha256').update(readFileSync(sourcePath(id))).digest('hex'),classification:HOME_IDS.has(id)?'research-only-untextured-home-fallback':'primary-source'}} as ProbeResult);console.log(JSON.stringify({id,passed:result.passed,arms:result.humanoidArmPose.arms.length,maxRadians:result.humanoidArmPose.maxRotationFromBindRadians,minVertical:result.humanoidArmPose.minimumVerticalRatio,posePass:result.humanoidArmPose.bothArmsLoweredInMultipleFrames}));}}
finally{await browser.close();}
const failed=results.filter(row=>!row.passed||(row.humanoidArmPose.arms.length>0&&!row.humanoidArmPose.bothArmsLoweredInMultipleFrames&&row.id!==195));
writeFileSync(`${output}/verification.json`,JSON.stringify({schema:2,generatedAt:new Date().toISOString(),rigVersion:'regional-authored-v4',method:'Bind, idle-quarter, and walk-quarter screenshots plus upper-arm world direction at 25%, 50%, and 75% of both clips. Every detected upper arm must point below vertical ratio -0.28 in at least two samples of each ordinary clip; #195 is a documented coarse connected-shoulder exception.',scope:{requested:IDS.length,passed:IDS.length-failed.length,failed:failed.map(row=>row.id)},results},null,2)+'\n');
console.log(JSON.stringify({checked:IDS.length,failed:failed.map(row=>row.id)}));if(failed.length)process.exitCode=1;
