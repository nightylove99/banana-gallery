import { resourceFiles } from '../gallery/resource-files'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {Router, type Request} from 'express'
import sharp from 'sharp'
import type {GalleryResources,GenerationTaskScope,ReferenceAsset,ReferenceCombinationItem} from '../../src/types'
import type {GalleryRepository} from '../gallery/gallery-repository'
import type {AssetStorage} from '../storage/asset-storage'
import type {GalleryWriteCoordinator} from '../gallery/write-coordinator'
import {TaskError} from '../generation/task-queue'
interface Options {repository:GalleryRepository;storage:AssetStorage;coordinator:GalleryWriteCoordinator;canAccess:(scope:GenerationTaskScope,kind:'images'|'references',filename:string)=>Promise<boolean>}
const nameOf=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.length>120)throw new TaskError('名称应为 1–120 字');return value.trim()}
export function createReferenceLibraryRouter({repository,storage,coordinator,canAccess}:Options){
 const router=Router()
 router.use((req,res,next)=>{if(!req.authSession){res.status(401).json({error:'UNAUTHORIZED'});return}next()})
 const scopeOf=(session:NonNullable<Request['authSession']>):GenerationTaskScope=>({workspaceId:session.workspace.id,userId:session.user.id,ownerUserId:session.user.id})
 const read=async(scope:GenerationTaskScope)=>await repository.readResources?.(scope)||{}
 const save=async(resources:GalleryResources,scope:GenerationTaskScope)=>{if(!repository.saveResources)throw new TaskError('当前存储不支持素材库',503);await repository.saveResources(resources,scope)}
 async function versionFrom(body:Record<string,unknown>,resources:GalleryResources,scope:GenerationTaskScope,rollback:Array<()=>Promise<void>>){
  const kind=body.kind,filename=body.filename
  if((kind!=='images'&&kind!=='references')||typeof filename!=='string'||filename!==path.basename(filename)||!filename||filename.startsWith('.')||/[\\/\0]/.test(filename))throw new TaskError('素材文件无效')
  if(!await canAccess(scope,kind,filename))throw new TaskError('文件不存在或无权访问',404)
  const source=kind==='images'?storage.getImagePath(filename):storage.getReferencePath(filename)
  let bytes:Buffer,format:string
  try{const stat=await fs.lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>100*1024*1024)throw new Error('size');bytes=await fs.readFile(source);const metadata=await sharp(bytes).metadata();format=metadata.format||'';if(!['png','jpeg','webp'].includes(format))throw new Error('format');await sharp(bytes).resize(1,1).toBuffer()}catch{throw new TaskError('素材必须为可读取的 PNG、JPEG 或 WebP，且不超过 100 MB')}
  const sha256=createHash('sha256').update(bytes).digest('hex')
  const duplicates=(resources.referenceAssets||[]).filter(asset=>asset.versions.some(version=>version.sha256===sha256))
  const match=duplicates.flatMap(asset=>asset.versions).find(version=>version.sha256===sha256)
  let reusable=false
  if(match)try{const file=storage.getReferencePath(match.filename),stat=await fs.lstat(file);reusable=stat.isFile()&&!stat.isSymbolicLink()&&stat.size===bytes.length&&createHash('sha256').update(await fs.readFile(file)).digest('hex')===sha256}catch{/* Retain the broken old version for diagnosis; use intact input for the new version. */}
  const target=reusable?match!.filename:kind==='references'?filename:`ref_${randomUUID()}.${format==='jpeg'?'jpg':format}`
  let created=false
  if(!reusable&&kind==='images'){
   await fs.writeFile(storage.getReferencePath(target),bytes,{flag:'wx'});created=true
   rollback.push(async()=>{
    // A write error can have an uncertain commit outcome. Keep files if the authoritative index references them.
    if(resourceFiles(await read(scope)).references.has(target)||(await repository.listImages(scope)).some(image=>image.referenceImages.includes(target)))return
    await storage.deleteReferences([target])
   })
   await storage.finalizeReferences([target])
  }
  return {version:{id:randomUUID(),filename:target,sha256,createdAt:new Date().toISOString()},duplicates:duplicates.map(asset=>asset.id),reusedFile:!created}
 }
 const route=(method:'post'|'patch',url:string,handler:(body:Record<string,unknown>,params:Record<string,string>,resources:GalleryResources,scope:GenerationTaskScope,rollback:Array<()=>Promise<void>>)=>Promise<unknown>)=>{
  router[method](url,async(req,res)=>{try{const result=await coordinator.run(async()=>{const scope=scopeOf(req.authSession!),resources=await read(scope),rollback:Array<()=>Promise<void>>=[];try{const result=await handler(req.body||{},req.params as Record<string,string>,resources,scope,rollback);await save(resources,scope);return result}catch(error){for(const cleanup of rollback)try{await cleanup()}catch{/* Keep unconfirmed files for inspection. */}throw error}});res.status(method==='post'&&!url.includes('/versions')?201:200).json(result)}catch(error){res.status(error instanceof TaskError?error.status:500).json({error:error instanceof TaskError?error.message:'素材操作失败，请刷新后重试'})}})
 }
 router.get('/',async(req,res)=>{const resources=await read(scopeOf(req.authSession!));res.json({assets:resources.referenceAssets||[],combinations:resources.referenceCombinations||[]})})
 route('post','/assets',async(body,_params,resources,scope,rollback)=>{
  const name=nameOf(body.name),prepared=await versionFrom(body,resources,scope,rollback),now=new Date().toISOString()
  const asset:ReferenceAsset={id:randomUUID(),name,tags:[],favorited:false,versions:[prepared.version],currentVersionId:prepared.version.id,version:0,createdAt:now,updatedAt:now}
  resources.referenceAssets=[...(resources.referenceAssets||[]),asset];return {asset,duplicates:prepared.duplicates,reusedFile:prepared.reusedFile}
 })
 route('patch','/assets/:id',async(body,params,resources)=>{
  const asset=resources.referenceAssets?.find(asset=>asset.id===params.id);if(!asset)throw new TaskError('素材不存在',404)
  if(body.expectedVersion!==asset.version)throw new TaskError('素材已在其他窗口修改，请刷新后重试',409)
  if(body.name!==undefined)asset.name=nameOf(body.name)
  if(body.tags!==undefined){if(!Array.isArray(body.tags)||body.tags.length>30||body.tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>50))throw new TaskError('标签格式无效');asset.tags=[...new Set(body.tags.map(tag=>(tag as string).trim()))]}
  if(body.favorited!==undefined){if(typeof body.favorited!=='boolean')throw new TaskError('收藏状态无效');asset.favorited=body.favorited}
  if(body.deleted===true)asset.deletedAt=new Date().toISOString();if(body.deleted===false)delete asset.deletedAt
  asset.version++;asset.updatedAt=new Date().toISOString();return asset
 })
 route('post','/assets/:id/versions',async(body,params,resources,scope,rollback)=>{
  const asset=resources.referenceAssets?.find(asset=>asset.id===params.id);if(!asset)throw new TaskError('素材不存在',404)
  if(body.expectedVersion!==asset.version)throw new TaskError('素材已变化，请刷新后再替换',409)
  const prepared=await versionFrom(body,resources,scope,rollback);asset.versions.push(prepared.version);asset.currentVersionId=prepared.version.id;asset.version++;asset.updatedAt=new Date().toISOString();return {asset,duplicates:prepared.duplicates,reusedFile:prepared.reusedFile}
 })
 function itemsOf(body:Record<string,unknown>,resources:GalleryResources):ReferenceCombinationItem[]{
  if(!Array.isArray(body.items)||!body.items.length||body.items.length>14)throw new TaskError('组合需包含 1–14 张有序参考图')
  return body.items.map(item=>{if(!item||typeof item!=='object')throw new TaskError('组合内容无效');const {assetId,versionId,note=''}=item as ReferenceCombinationItem
   if(!resources.referenceAssets?.some(asset=>asset.id===assetId&&asset.versions.some(version=>version.id===versionId)))throw new TaskError('组合中的素材版本不存在',404)
   if(typeof note!=='string'||note.length>500)throw new TaskError('用途备注最多 500 字');return {assetId,versionId,note}
  })
 }
 route('post','/combinations',async(body,_params,resources)=>{const name=nameOf(body.name),items=itemsOf(body,resources),now=new Date().toISOString();const combination={id:randomUUID(),name,items,version:0,createdAt:now,updatedAt:now};resources.referenceCombinations=[...(resources.referenceCombinations||[]),combination];return combination})
 route('patch','/combinations/:id',async(body,params,resources)=>{
  const combo=resources.referenceCombinations?.find(item=>item.id===params.id);if(!combo)throw new TaskError('组合不存在',404);if(body.expectedVersion!==combo.version)throw new TaskError('组合已变化，请刷新后重试',409)
  if(body.name!==undefined)combo.name=nameOf(body.name);if(body.items!==undefined)combo.items=itemsOf(body,resources)
  if(body.deleted===true)combo.deletedAt=new Date().toISOString();if(body.deleted===false)delete combo.deletedAt
  combo.version++;combo.updatedAt=new Date().toISOString();return combo
 })
 return router
}
