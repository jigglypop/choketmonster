import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const revision='8fe210b21c9abbe73de93670f3d5a346c80a3625';
const url=`https://raw.githubusercontent.com/PokeAPI/pokeapi/${revision}/data/v2/csv/pokemon.csv`;
const target=resolve('data/local/region-expansion-source',revision,'pokemon.csv'),partial=`${target}.part`;
const digest=async(path:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk as Buffer);return hash.digest('hex');};
await mkdir(dirname(target),{recursive:true});
let exists=false;try{await stat(target);exists=true;}catch{}
if(!exists){const offset=await stat(partial).then(value=>value.size).catch(()=>0);const response=await fetch(url,{headers:{'User-Agent':'choketmon-region-source/1.0',...(offset?{Range:`bytes=${offset}-`}:{})}});if(!response.ok||!response.body)throw new Error(`pokemon.csv HTTP ${response.status}`);if(offset&&response.status!==206){await rm(partial,{force:true});throw new Error('Pinned source did not honor resume');}await pipeline(response.body as unknown as NodeJS.ReadableStream,createWriteStream(partial,{flags:offset?'a':'w'}));await rename(partial,target);}
const bytes=(await stat(target)).size,sha256=await digest(target);if(!bytes)throw new Error('pokemon.csv is empty');
const manifest={schema:1,source:'https://github.com/PokeAPI/pokeapi',revision,license:'BSD-3-Clause',files:[{name:'pokemon.csv',url,bytes,sha256}]};
await writeFile(resolve(dirname(target),'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
