import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const id=Number(process.argv[2]??914),root='data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65';
const browser=await chromium.launch({headless:true}),page=await browser.newPage();
await page.route('**/source.glb',route=>route.fulfill({body:readFileSync(`${root}/${id}.glb`),contentType:'model/gltf-binary'}));
await page.goto('http://127.0.0.1:5173/data/connectome.json');
const result=await page.evaluate(async()=>{const loaderPath='/src/three/gltf-loader.ts',threePath='/node_modules/three/build/three.module.js';const [{createGLTFLoader},{Box3,Vector3}]=await Promise.all([import(/* @vite-ignore */ loaderPath),import(/* @vite-ignore */ threePath)]);const asset=await createGLTFLoader().loadAsync('/source.glb');asset.scene.updateMatrixWorld(true);const rows:Array<{name:string;geometryName:string;visible:boolean;center:number[];size:number[];radius:number}>=[];asset.scene.traverse((o:{isMesh?:boolean;name:string;visible:boolean;geometry?:{name?:string}})=>{if(!o.isMesh)return;const b=new Box3().setFromObject(o,true),size=b.getSize(new Vector3()),center=b.getCenter(new Vector3());rows.push({name:o.name,geometryName:o.geometry?.name??'',visible:o.visible,center:center.toArray(),size:size.toArray(),radius:size.length()});});return{scene:new Box3().setFromObject(asset.scene,true).getSize(new Vector3()).toArray(),rows:rows.sort((a,b)=>b.radius-a.radius)};});
console.log(JSON.stringify(result,null,2));await browser.close();
