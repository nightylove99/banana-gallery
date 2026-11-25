import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash,randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { readSharpInput } from './sharp-input.js'

type ThumbnailPriority = 'foreground' | 'background'
export type ThumbnailSize = 'standard' | 'preview'
export async function thumbnailVersion(source: string): Promise<string> {
 const stat = await fs.stat(source, { bigint: true })
 return createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:thumbnails-v2`).digest('hex')
}
interface ThumbnailJob {
 key:string
 source:string
 target:string
 priority:ThumbnailPriority
 size:ThumbnailSize
 started:boolean
 resolve:(target:string)=>void
 reject:(error:unknown)=>void
}
interface ThumbnailCacheOptions {
 concurrency?:number
 maxBytes?:number
 encode?:(source:string,target:string,size:ThumbnailSize)=>Promise<void>
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const EVICTION_DELAY_MS = 500

/** Rebuildable disk cache with foreground-first, bounded thumbnail encoding. */
export class ThumbnailCache {
 private active=0
 private queue:ThumbnailJob[]=[]
 private pending=new Map<string,{promise:Promise<string>;job:ThumbnailJob}>()
 private readonly directory:string
 private readonly concurrency:number
 private readonly maxBytes:number
 private evictionTimer?: ReturnType<typeof setTimeout>
 private evicting = false
 private evictionRequested = false
 private readonly encode:(source:string,target:string,size:ThumbnailSize)=>Promise<void>

 constructor(directory:string,options:ThumbnailCacheOptions={}){
  this.directory=directory
  this.concurrency=Math.max(1,options.concurrency??2)
  this.maxBytes = options.maxBytes !== undefined && Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
   ? options.maxBytes : DEFAULT_MAX_BYTES
  this.encode=options.encode??(async(source,target,size)=>{
   const preview=size==='preview'
   await sharp(await readSharpInput(source),{limitInputPixels:100_000_000}).rotate().resize({width:preview?96:480,height:preview?144:720,fit:'inside',withoutEnlargement:true}).webp({quality:preview?50:75}).toFile(target)
  })
  this.scheduleEviction()
 }

 async get(source:string,size:ThumbnailSize='standard'):Promise<string>{return this.request(source,'foreground',size)}
 async warm(source:string,size:ThumbnailSize='standard'):Promise<string>{return this.request(source,'background',size)}

 private async request(source:string,priority:ThumbnailPriority,size:ThumbnailSize):Promise<string>{
  const revision=await thumbnailVersion(source)
  const key=createHash('sha256').update(`${source}:${revision}:${size==='preview'?'96:webp:50':'480:webp:75'}:v2`).digest('hex')
  const target=path.join(this.directory,`${key}.webp`)
  try {
   if (priority === 'foreground') {
    // Track user-visible hits explicitly: filesystem atime can be disabled or coarse.
    const now = new Date()
    await fs.utimes(target, now, now)
   } else {
    await fs.access(target)
   }
   return target
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const existing=this.pending.get(key)
  if(existing){
   if(priority==='foreground'&&!existing.job.started)existing.job.priority='foreground'
   return existing.promise
  }
  if(this.queue.length>=64){
   if(priority==='background')throw new Error('Thumbnail queue busy')
   let evictedIndex=-1
   for(let index=this.queue.length-1;index>=0;index--)if(this.queue[index].priority==='background'){evictedIndex=index;break}
   if(evictedIndex<0)throw new Error('Thumbnail queue busy')
   const [evicted]=this.queue.splice(evictedIndex,1)
   this.pending.delete(evicted.key)
   evicted.reject(new Error('Thumbnail background job superseded'))
  }
  let resolve!:(target:string)=>void,reject!:(error:unknown)=>void
  const promise=new Promise<string>((onResolve,onReject)=>{resolve=onResolve;reject=onReject})
  const job:ThumbnailJob={key,source,target,priority,size,started:false,resolve,reject}
  this.pending.set(key,{promise,job});this.queue.push(job);this.pump()
  return promise
 }

 private pump(){
  while(this.active<this.concurrency&&this.queue.length){
   const foreground=this.queue.findIndex(job=>job.priority==='foreground')
   // A warmup may run alone, but never occupy additional encoder slots.
   if (foreground < 0 && this.active > 0) return
   const [job]=this.queue.splice(foreground>=0?foreground:0,1)
   job.started=true;this.active++
   void this.generate(job.source,job.target,job.size)
    .then(job.resolve,job.reject)
    .finally(()=>{this.pending.delete(job.key);this.active--;this.pump()})
  }
 }

 private async generate(source:string,target:string,size:ThumbnailSize){
  const temporary=`${target}.${randomUUID()}.tmp`
  try{
   await fs.mkdir(this.directory,{recursive:true})
   await this.encode(source,temporary,size)
   await fs.rename(temporary,target)
   this.scheduleEviction()
   return target
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{})}
 }
 private scheduleEviction() {
  this.evictionRequested = true
  if (this.evictionTimer || this.evicting) return
  this.evictionTimer = setTimeout(() => {
   this.evictionTimer = undefined
   this.evictionRequested = false
   this.evicting = true
   void this.evict().catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[thumbnails] 缓存清理失败', error)
   }).finally(() => {
    this.evicting = false
    if (this.evictionRequested) this.scheduleEviction()
   })
  }, EVICTION_DELAY_MS).unref()
 }

 private async evict() {
  const entries: Array<{ file: string; bytes: number; accessedAt: number }> = []
  let totalBytes = 0
  const directory = await fs.opendir(this.directory)
  for await (const entry of directory) {
   if (!entry.isFile() || !/^[a-f0-9]{64}\.webp$/.test(entry.name)) continue
   const file = path.join(this.directory, entry.name)
   const stat = await fs.stat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
   })
   if (!stat) continue
   entries.push({ file, bytes: stat.size, accessedAt: stat.mtimeMs })
   totalBytes += stat.size
  }
  if (totalBytes <= this.maxBytes) return
  entries.sort((first, second) => first.accessedAt - second.accessedAt)
  for (const entry of entries) {
   const current = await fs.stat(entry.file).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
   })
   if (current && current.mtimeMs !== entry.accessedAt) {
    // A foreground hit refreshed this entry during the scan.
    this.evictionRequested = true
    continue
   }
   if (current) await fs.rm(entry.file, { force: true })
   totalBytes -= entry.bytes
   if (totalBytes <= this.maxBytes) return
  }
 }

}
