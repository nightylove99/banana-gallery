import fs from 'node:fs/promises'
import path from 'node:path'
import type {GalleryImage} from '../../src/types'
import type {AssetStorage} from '../storage/asset-storage'
import {assetTitle,assetNotes} from '../../src/lib/gallery-query'
export interface ZipEntry {name:string;data?:Buffer;file?:string}
const table=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0})
function crc32(buffer:Buffer){let crc=0xffffffff;for(const b of buffer)crc=table[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0}
/** Streaming uncompressed ZIP: images are already compressed, no external archive dependency. */
export async function* zipEntries(entries:ZipEntry[]){
 const directory:Buffer[]=[];let offset=0
 for(const entry of entries){
  const name=Buffer.from(entry.name),data=entry.data||await fs.readFile(entry.file!),crc=crc32(data)
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26)
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42)
  directory.push(central,name);yield local;yield name;yield data;offset+=local.length+name.length+data.length
 }
 const centralSize=directory.reduce((n,b)=>n+b.length,0)
 for(const block of directory)yield block
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);yield end
}
export async function galleryExportEntries(images:GalleryImage[],storage:AssetStorage):Promise<ZipEntry[]>{
 const entries:ZipEntry[]=[],manifest=[];let bytes=0
 const add=async(name:string,filename:string,kind:'images'|'references')=>{
  if(!/^[a-zA-Z0-9._-]+$/.test(filename)||filename!==path.basename(filename)||filename==='.'||filename==='..')throw new Error('图片文件名无效')
  const file=kind==='images'?storage.getImagePath(filename):storage.getReferencePath(filename),stat=await fs.lstat(file)
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('图片缺失或不是普通文件')
  bytes+=stat.size;if(bytes>512*1024*1024)throw new Error('本次导出超过 512 MB，请减少选择')
  entries.push({name,file})
 }
 for(const [index,image] of images.entries()){
  const folder=`${String(index+1).padStart(3,'0')}-${image.id.replace(/[^a-zA-Z0-9_-]/g,'_')}`
  const main=`assets/image${path.extname(image.filename)}`,refs=image.referenceImages.map((filename,i)=>`assets/reference-${String(i+1).padStart(2,'0')}${path.extname(filename)}`)
  await add(`${folder}/${main}`,image.filename,'images')
  for(const [i,filename] of image.referenceImages.entries())await add(`${folder}/${refs[i]}`,filename,'references')
  const generation=image.generation?Object.fromEntries(['provider','model','aspectRatio','imageSize','quality','outputFormat'].flatMap(key=>{const value=image.generation![key as keyof NonNullable<GalleryImage['generation']>];return value===undefined?[]:[[key,value]]})):undefined
  const record={id:image.id,title:assetTitle(image),notes:assetNotes(image),prompt:image.prompt,assetType:image.assetType,tags:image.tags,favorited:image.favorited,pinned:image.pinned,createdAt:image.createdAt,generation,sourceAssetId:image.sourceAssetId,sourceTaskId:image.sourceTaskId,referenceNotes:image.referenceNotes,sourceUrl:image.sourceUrl&&/^https?:\/\//i.test(image.sourceUrl)?image.sourceUrl:undefined,sourceType:image.sourceType,capturedAt:image.capturedAt,image:main,referenceImages:refs}
  manifest.push({...record,directory:folder})
  const fence='`'.repeat(Math.max(3,...(image.prompt.match(/`+/g)||[]).map(s=>s.length+1)))
  const markdown=`# ${(record.title||'未命名条目').replace(/[\r\n]/g,' ')}\n\n![](${main})\n\n## 提示词\n\n${fence}text\n${image.prompt}\n${fence}\n\n## 备注\n\n${record.notes||'暂无'}\n\n## 有序参考图\n\n${refs.map((ref,i)=>`${i+1}. ![](${ref})${image.referenceNotes?.[i] ? ` — ${image.referenceNotes[i]}` : ""}`).join('\n')}\n\n## 参数\n\n${JSON.stringify(generation||{},null,2)}\n`
  entries.push({name:`${folder}/README.md`,data:Buffer.from(markdown)},{name:`${folder}/metadata.json`,data:Buffer.from(JSON.stringify(record,null,2))})
 }
 entries.push({name:'manifest.json',data:Buffer.from(JSON.stringify({format:1,images:manifest},null,2))})
 return entries
}
