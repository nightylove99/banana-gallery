/** Isolated synthetic benchmark; never reads or writes the user's gallery. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import sharp from 'sharp'
import { createApp } from '../server/app'
import { filterGalleryImages } from '../src/lib/gallery-query'
import type { GalleryImage } from '../src/types'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-benchmark-'))
const results=[]
try {
 const width=2048,height=1536,pixels=Buffer.alloc(width*height*3)
 let random=123456789
 for(let i=0;i<pixels.length;i++){random^=random<<13;random^=random>>>17;random^=random<<5;pixels[i]=random&255}
 const imageDir=path.join(root,'images');await fs.mkdir(imageDir)
 const original=await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer()
 for(let i=0;i<12;i++)await fs.writeFile(path.join(imageDir,`fixture-${i}.png`),original)
 const dataFile=path.join(root,'gallery-data.json')
 const app=createApp({ai:{models:{generateContent:async()=>({candidates:[]})}},strategy:{mode:'apiKey',apiKey:'fixture'},dataFile,imagesDir:imageDir,referencesDir:path.join(root,'references'),userAuthMode:'local',localAuthSession:{user:{id:'benchmark',email:'benchmark@local.test'},workspace:{id:'benchmark',name:'Benchmark'}}})
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve))
 const address=server.address();if(!address||typeof address==='string')throw new Error('No port')
 const origin=`http://127.0.0.1:${address.port}`
 async function fetchBytes(url:string){const response=await fetch(origin+url);if(!response.ok)throw new Error(`HTTP ${response.status}`);return (await response.arrayBuffer()).byteLength}
 try {
 for(const count of [1000,5000]) {
 const images:GalleryImage[]=Array.from({length:count},(_,i)=>({id:String(i),filename:`fixture-${i%12}.png`,prompt:`Synthetic gallery English 柔和光线 编号${i} `+'test prompt '.repeat(40),referenceImages:[],tags:[`tag-${i%20}`],favorited:i%3===0,assetType:'recipe',createdAt:new Date(1700000000000+i*1000).toISOString(),width,height}))
 await fs.writeFile(dataFile,JSON.stringify({schemaVersion:1,images}))
 let start=performance.now();const baselineListBytes=await fetchBytes('/api/images');const baselineListMs=performance.now()-start
 start=performance.now();const firstPageBytes=await fetchBytes('/api/images?limit=120');const firstPageMs=performance.now()-start
 start=performance.now();const baselineBytes=(await Promise.all(Array.from({length:12},(_,i)=>fetchBytes(`/api/assets/images/fixture-${i}.png`)))).reduce((a,b)=>a+b,0);const originalsMs=performance.now()-start
 await fs.rm(path.join(root,'cache'),{recursive:true,force:true})
 start=performance.now();const thumbnailBytes=(await Promise.all(Array.from({length:12},(_,i)=>fetchBytes(`/api/assets/images/fixture-${i}.png?thumbnail=true`)))).reduce((a,b)=>a+b,0);const coldThumbnailsMs=performance.now()-start
 start=performance.now();await Promise.all(Array.from({length:12},(_,i)=>fetchBytes(`/api/assets/images/fixture-${i}.png?thumbnail=true`)));const warmThumbnailsMs=performance.now()-start
 const search=[];for(let i=0;i<100;i++){start=performance.now();filterGalleryImages(images,{q:`English 编号${i*7}`});search.push(performance.now()-start)}search.sort((a,b)=>a-b)
 results.push({count,baselineListBytes,baselineListMs,firstPageBytes,firstPageMs,baselineBytes,thumbnailBytes,transferReduction:1-thumbnailBytes/baselineBytes,originalsMs,coldThumbnailsMs,warmThumbnailsMs,searchP95Ms:search[94]})
 }
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
 console.log(JSON.stringify({fixture:'Deterministic 2048×1536 RGB noise PNG; 12 distinct filenames reused across synthetic metadata. HTTP on loopback, timings include response bodies. Image encoding is deliberately difficult and is not a photo-library forecast.',measuredAt:new Date().toISOString(),results},null,2))
}finally{await fs.rm(root,{recursive:true,force:true})}
