import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import type {GalleryImage} from '../../src/types'
import type {AssetStorage} from '../storage/asset-storage'
export const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
export async function importCandidates(images:GalleryImage[],incoming:{imageHash:string;referenceHashes:string[];prompt:string;sourceUrl?:string},storage:AssetStorage){
 let inspected=0
 const candidates:Array<{id:string;title:string;evidence:string[];deleted:boolean}>=[]
 for(const image of images){
  const samePrompt=image.prompt.trim()===incoming.prompt.trim(),sameSource=!!incoming.sourceUrl&&image.sourceUrl===incoming.sourceUrl
  let hash=image.contentHash
  // For old entries, inspect at most 20 same-prompt candidates; never hash the whole library on import.
  if(!hash&&samePrompt&&inspected++<20){try{hash=sha256(await fs.readFile(storage.getImagePath(image.filename)))}catch{/* Missing old bytes cannot establish a duplicate. */}}
  const sameImage=hash===incoming.imageHash,sameReferences=JSON.stringify(image.referenceHashes)===JSON.stringify(incoming.referenceHashes)
  if(sameImage||(samePrompt&&sameSource&&sameReferences))candidates.push({id:image.id,title:image.title||image.generation?.title||image.prompt.slice(0,60)||'未命名条目',evidence:[...(sameImage?['图片内容相同']:[]),...(samePrompt?['提示词相同']:[]),...(sameSource?['来源相同']:[]),...(sameReferences?['参考图及顺序相同']:[])],deleted:!!image.deletedAt})
  if(candidates.length>=20)break
 }
 return candidates
}
