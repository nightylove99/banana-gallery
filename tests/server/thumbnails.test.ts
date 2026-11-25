import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { expect,it,vi } from 'vitest'
import { ThumbnailCache } from '../../server/storage/thumbnails'
import { createApp } from '../../server/app'
it('creates cached bounded thumbnails without changing originals and rebuilds missing cache',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-thumbnails-'))
 try {
 const source=path.join(root,'original.png'); await sharp({create:{width:2048,height:1024,channels:3,background:'#aabbcc'}}).png().toFile(source)
 const original=await fs.readFile(source), cache=new ThumbnailCache(path.join(root,'cache'))
 const [a,b]=await Promise.all([cache.get(source),cache.get(source)]);expect(a).toBe(b)
 // Reading metadata from a path can make libvips hold it open on Windows.
 const meta=await sharp(await fs.readFile(a)).metadata();expect(meta.width).toBe(480);expect(meta.height).toBe(240);expect(await fs.readFile(source)).toEqual(original)
 await fs.unlink(a);expect(await cache.get(source)).toBe(a);expect((await fs.stat(a)).size).toBeGreaterThan(0)
 } finally {await fs.rm(root,{recursive:true,force:true})}
})

it('creates a separate lightweight preview without changing the standard cache or original', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-preview-'))
 try {
  const source=path.join(root,'original.png');await sharp({create:{width:2048,height:3072,channels:3,background:'#aabbcc'}}).png().toFile(source)
  const original=await fs.readFile(source),cache=new ThumbnailCache(path.join(root,'cache'))
  const standard=await cache.get(source),preview=await cache.get(source,'preview')
  expect(preview).not.toBe(standard)
  const meta=await sharp(await fs.readFile(preview)).metadata();expect(meta.width).toBe(96);expect(meta.height).toBe(144)
  expect(await fs.readFile(source)).toEqual(original)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

it('releases a WebP original after encoding its thumbnail', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-webp-thumbnail-'))
 try {
  const source = path.join(root, 'original.webp')
  await sharp({ create: { width: 512, height: 256, channels: 3, background: 'red' } }).webp().toFile(source)
  const thumbnail = await new ThumbnailCache(path.join(root, 'cache')).get(source)
  await fs.unlink(source)
  expect((await fs.stat(thumbnail)).size).toBeGreaterThan(0)
 } finally { await fs.rm(root, { recursive: true, force: true }) }
})

it('invalidates disk thumbnails when a restored file has the same size and modification time',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-thumbnail-restore-'))
 try {
  const source=path.join(root,'source.png');await fs.writeFile(source,'first');await fs.utimes(source,1700000000,1700000000)
  const cache=new ThumbnailCache(path.join(root,'cache'),{encode:(from,to)=>fs.copyFile(from,to)})
  const first=await cache.get(source),stat=await fs.stat(source)
  const replacement=source+'.new';await fs.writeFile(replacement,'other');await fs.utimes(replacement,stat.atime,stat.mtime);await fs.rename(replacement,source)
  const restored=await cache.get(source)
  expect(await fs.readFile(first,'utf8')).toBe('first')
  expect(await fs.readFile(restored,'utf8')).toBe('other')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

it('returns file-based thumbnail versions and explicit failures for modern thumbnail requests', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-thumbnail-api-'))
 try {
  const imagesDir=path.join(root,'images'),referencesDir=path.join(root,'references'),dataFile=path.join(root,'gallery.json')
  await fs.mkdir(imagesDir);await fs.mkdir(referencesDir)
  const source=path.join(imagesDir,'one.png');await sharp({create:{width:10,height:10,channels:3,background:'red'}}).png().toFile(source)
  await fs.writeFile(dataFile,JSON.stringify({images:[{id:'one',filename:'one.png',prompt:'fixture',referenceImages:[],tags:[],favorited:false,assetType:'work',createdAt:'2026-10-12',width:10,height:10}]}))
  const app=createApp({ai:{models:{generateContent:async()=>({candidates:[]})}},strategy:{mode:'apiKey',apiKey:'fixture'},dataFile,imagesDir,referencesDir,userAuthMode:'local',localAuthSession:{user:{id:'test',email:'test@local'},workspace:{id:'test',name:'Test'}},thumbnailCache:{get:async()=>{throw new Error('Thumbnail queue busy')},warm:async()=>source}})
  const request=(await import('supertest')).default
  const first=await request(app).get('/api/images?limit=1')
  expect(typeof first.body.items[0].thumbnailVersion).toBe('string')
  expect(first.body.items[0].thumbnailVersion).toMatch(/^[a-f0-9]{64}$/)
  const version=first.body.items[0].thumbnailVersion
  const patched=await request(app).patch('/api/images/one').send({ title:'Renamed', favorited:true }).expect(200)
  expect(patched.body).toMatchObject({title:'Renamed',favorited:true,thumbnailVersion:version})
  expect(JSON.parse(await fs.readFile(dataFile,'utf8')).images[0]).not.toHaveProperty('thumbnailVersion')
  expect((await request(app).get('/api/assets/images/one.png?thumbnail=true&size=preview&v='+version)).status).toBe(503)
  expect((await request(app).get('/api/assets/images/one.png?thumbnail=true&size=bad')).status).toBe(400)
  expect((await request(app).get('/api/assets/images/one.png?thumbnail=true')).status).toBe(200)
  await sharp({create:{width:11,height:10,channels:3,background:'blue'}}).png().toFile(source)
  expect((await request(app).get('/api/images?limit=1')).body.items[0].thumbnailVersion).not.toBe(version)
  expect((await request(app).get('/api/assets/images/one.png?thumbnail=true&size=standard&v='+version)).status).toBe(409)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

it('runs a newly visible thumbnail before queued background warmups',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-thumbnail-priority-'))
 try{
  const sources=Object.fromEntries(await Promise.all(['first','background','visible'].map(async name=>{
   const filename=path.join(root,`${name}.png`);await fs.writeFile(filename,name);return [name,filename]
  }))) as Record<string,string>
  const started:string[]=[]
  let releaseFirst!:()=>void,markFirstStarted!:()=>void
  const firstHeld=new Promise<void>(resolve=>{releaseFirst=resolve})
  const firstStarted=new Promise<void>(resolve=>{markFirstStarted=resolve})
  const TestableCache=ThumbnailCache as unknown as new(directory:string,options:{concurrency:number;encode:(source:string,target:string)=>Promise<void>})=>ThumbnailCache&{warm:(source:string)=>Promise<string>}
  const cache=new TestableCache(path.join(root,'cache'),{concurrency:1,encode:async(source,target)=>{
   const name=path.basename(source,'.png');started.push(name)
   if(name==='first'){markFirstStarted();await firstHeld}
   await fs.copyFile(source,target)
  }})
  expect(typeof cache.warm).toBe('function')
  const first=cache.warm(sources.first);await firstStarted
  const background=cache.warm(sources.background)
  const visible=cache.get(sources.visible)
  await new Promise(resolve=>setTimeout(resolve,0));releaseFirst()
  await Promise.all([first,background,visible])
  expect(started).toEqual(['first','visible','background'])
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

it('backfills personal thumbnails one at a time and can stop before the next image',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-thumbnail-backfill-'))
 try{
  const dataFile=path.join(root,'gallery.json'),imagesDir=path.join(root,'images'),referencesDir=path.join(root,'references')
  await fs.mkdir(imagesDir,{recursive:true});await fs.mkdir(referencesDir,{recursive:true})
  const images=['one.png','two.png'].map((filename,index)=>({id:String(index),filename,prompt:'fixture',referenceImages:[],tags:[],favorited:false,assetType:'work',createdAt:'2026-09-19',width:1,height:1}))
  await fs.writeFile(dataFile,JSON.stringify({images}));await Promise.all(images.map(image=>fs.writeFile(path.join(imagesDir,image.filename),image.filename)))
  const warmed:string[]=[];let release!:()=>void
  const held=new Promise<string>(resolve=>{release=()=>resolve('done')})
  const app=createApp({ai:{models:{generateContent:async()=>({candidates:[]})}},strategy:{mode:'apiKey',apiKey:'fixture'},dataFile,imagesDir,referencesDir,userAuthMode:'local',localAuthSession:{user:{id:'test',email:'test@local'},workspace:{id:'test',name:'Test'}},thumbnailCache:{get:async source=>source,warm:source=>{warmed.push(source);return held}}})
  expect(typeof app.locals.startThumbnailWarmup).toBe('function')
  const stop=app.locals.startThumbnailWarmup()
  await vi.waitFor(()=>expect(warmed).toHaveLength(1))
  stop();release();await new Promise(resolve=>setTimeout(resolve,0))
  expect(warmed).toHaveLength(1)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

it('admits a visible thumbnail when the bounded queue is full of background work',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-thumbnail-full-'))
 try{
  const names=['first',...Array.from({length:64},(_,index)=>`background-${index}`),'visible']
  const sources=Object.fromEntries(await Promise.all(names.map(async name=>{const filename=path.join(root,`${name}.png`);await fs.writeFile(filename,name);return[name,filename]}))) as Record<string,string>
  const started:string[]=[];let release!:()=>void,markStarted!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve}),firstStarted=new Promise<void>(resolve=>{markStarted=resolve})
  const cache=new ThumbnailCache(path.join(root,'cache'),{concurrency:1,encode:async(source,target)=>{const name=path.basename(source,'.png');started.push(name);if(name==='first'){markStarted();await held}await fs.copyFile(source,target)}})
  const first=cache.warm(sources.first);await firstStarted
  const background=Array.from({length:64},(_,index)=>cache.warm(sources[`background-${index}`]).catch(error=>error))
  await new Promise(resolve=>setTimeout(resolve,0))
  const visible=cache.get(sources.visible).then(value=>({value}),error=>({error}))
  await new Promise(resolve=>setTimeout(resolve,0));release()
  const visibleResult=await visible;await first;await Promise.all(background)
  expect(visibleResult).toHaveProperty('value')
  expect(started[1]).toBe('visible')
  expect(started).toHaveLength(65)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

it('evicts the least recently accessed cache entry when the disk byte budget is exceeded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-thumbnail-budget-'))
  try {
    const directory = path.join(root, 'cache')
    const sources = ['a', 'b', 'c'].map(name => path.join(root, name + '.png'))
    await Promise.all(sources.map(source => fs.writeFile(source, '1234')))
    const cache = new ThumbnailCache(directory, { maxBytes: 8, encode: (source, target) => fs.copyFile(source, target) })
    const a = await cache.get(sources[0])
    const b = await cache.get(sources[1])
    await fs.utimes(a, 1, 1)
    await fs.utimes(b, 2, 2)
    await cache.get(sources[0])
    const c = await cache.get(sources[2])
    await vi.waitFor(async () => expect((await fs.readdir(directory)).sort()).toEqual([path.basename(a), path.basename(c)].sort()), { timeout: 1500 })
    expect(await fs.readFile(sources[1], 'utf8')).toBe('1234')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('leaves an encoder slot free for visible images while warming in the background', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-thumbnail-background-slot-'))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const jobs: Promise<string>[] = []
  try {
    const sources = ['first', 'second', 'visible'].map(name => path.join(root, name + '.png'))
    await Promise.all(sources.map(source => fs.writeFile(source, 'fixture')))
    const started: string[] = []
    const cache = new ThumbnailCache(path.join(root, 'cache'), {
      concurrency: 2,
      encode: async (source, target) => {
        started.push(source)
        if (source !== sources[2]) await held
        await fs.copyFile(source, target)
      },
    })
    jobs.push(cache.warm(sources[0]))
    await vi.waitFor(() => expect(started).toEqual([sources[0]]))
    jobs.push(cache.warm(sources[1]), cache.get(sources[2]))
    await vi.waitFor(() => expect(started).toContain(sources[2]), { timeout: 1000 })
    expect(started.filter(source => source !== sources[2])).toHaveLength(1)
  } finally {
    release()
    await Promise.allSettled(jobs)
    await fs.rm(root, { recursive: true, force: true })
  }
})
