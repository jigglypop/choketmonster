import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../src/data/pokemon-models-manifest.json' with { type: 'json' };

type Region = 'hoenn' | 'sinnoh' | 'unova' | 'kalos' | 'alola' | 'galar' | 'paldea';
const ranges: Record<Region, readonly [number, number]> = { hoenn: [252,386], sinnoh: [387,493], unova: [494,649], kalos:[650,721], alola:[722,809], galar:[810,905], paldea:[906,1025] };
const commit = manifest.source.commit, cache = join('data','local','pokemon-models-expanded',commit);
const entries = new Map(manifest.catalog.expandedEntries.map(entry => [entry.id, entry]));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const gitSha1 = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function inspect(id:number) {
  const entry=entries.get(id); if(!entry) throw new Error(`${id}: catalog entry missing`);
  const path=join(cache,`${id}.glb`),bytes=readFileSync(path);
  if(bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length) throw new Error(`${id}: invalid GLB header`);
  let offset=12,document:any; while(offset<bytes.length){const length=bytes.readUInt32LE(offset),type=bytes.readUInt32LE(offset+4);offset+=8;const chunk=bytes.subarray(offset,offset+length);offset+=length;if(type===0x4e4f534a)document=JSON.parse(chunk.toString('utf8').replace(/[\u0000\u0020]+$/g,''));}
  if(!document?.meshes?.length) throw new Error(`${id}: geometry missing`);
  const actualGitSha1=gitSha1(bytes); if(bytes.length!==entry.bytes||actualGitSha1!==entry.sourceGitBlobSha1) throw new Error(`${id}: pinned source identity mismatch`);
  return {id,path:path.replaceAll('\\','/'),bytes:bytes.length,sha256:sha256(bytes),sourceGitBlobSha1:actualGitSha1,meshes:document.meshes.length,primitives:document.meshes.flatMap((mesh:any)=>mesh.primitives??[]).length,skins:document.skins?.length??0,joints:document.skins?.reduce((sum:number,skin:any)=>sum+(skin.joints?.length??0),0)??0,animations:document.animations?.length??0,materials:document.materials?.length??0,images:document.images?.length??0};
}
const results: Array<ReturnType<typeof inspect> & { region: Region }> = [];
for(const [region,[first,last]] of Object.entries(ranges) as Array<[Region,readonly [number,number]]>) for(let id=first;id<=last;id++) if(entries.has(id)) results.push({...inspect(id),region});
const summary=Object.fromEntries((Object.keys(ranges) as Region[]).map(region=>{
  const rows=results.filter(row=>row.region===region);
  return [region,{species:rows.length,bytes:rows.reduce((sum,row)=>sum+row.bytes,0),geometry:rows.filter(row=>row.meshes>0&&row.primitives>0).length,skinned:rows.filter(row=>row.skins>0).length,animated:rows.filter(row=>row.animations>0).length,riggedAnimated:rows.filter(row=>row.skins>0&&row.animations>0).length,needsAuthoredRig:rows.filter(row=>!row.skins&&!row.animations).length,needsAuthoredMotion:rows.filter(row=>row.skins>0&&!row.animations).length}];
}));
const output={schema:1,generatedAt:new Date().toISOString(),source:{repository:manifest.source.repository,commit,rights:manifest.rights},scope:{nationalDex:[252,1025],species:results.length,missingSpecies:manifest.catalog.missingIds,bytes:results.reduce((sum,row)=>sum+row.bytes,0)},summary,results};
const out=join('artifacts','research','region-expansion');mkdirSync(out,{recursive:true});writeFileSync(join(out,'model-audit.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
