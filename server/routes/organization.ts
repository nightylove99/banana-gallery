import { normalizeCollections, preserveCollectionOwnership } from '../gallery/collections'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { galleryExportEntries, zipEntries } from '../gallery/export'
import type { AssetStorage } from '../storage/asset-storage'
import {Router,type Request} from 'express'
import {randomUUID} from 'node:crypto'
import type {GalleryImage,ResultGroup} from '../../src/types'
import type {GalleryRepository} from '../gallery/gallery-repository'
import {JsonGalleryRepository} from '../gallery/json-gallery-repository'
import type {GalleryWriteCoordinator} from '../gallery/write-coordinator'
export function createOrganizationRouter(repository:GalleryRepository,coordinator:GalleryWriteCoordinator,assetStorage:AssetStorage){
 const router=Router()
 router.use((req,res,next)=>{if(!req.authSession)return res.status(401).json({error:'UNAUTHORIZED'});next()})
 const scope=(req:Request)=>({workspaceId:req.authSession!.workspace.id,ownerUserId:req.authSession!.user.id})
 router.post('/organization/batch',async(req,res)=>coordinator.run(async()=>{
  const {targets,action}=req.body||{}
  if(!Array.isArray(targets)||targets.length<1||targets.length>500||targets.some(t=>!t||typeof t.id!=='string'||!Number.isInteger(t.version)||t.version<0)||new Set(targets.map(t=>t.id)).size!==targets.length)return res.status(400).json({error:'请选择 1–500 个不同条目并提供版本'})
  if(!action||!['addTags','removeTags','favorite','assetType','trash'].includes(action.type))return res.status(400).json({error:'不支持的批量操作'})
  if(['addTags','removeTags'].includes(action.type)&&(!Array.isArray(action.tags)||action.tags.length>50||action.tags.some((t:unknown)=>typeof t!=='string'||!t.trim()||t.length>80)))return res.status(400).json({error:'标签格式无效'})
  if(action.type==='favorite'&&typeof action.value!=='boolean'||action.type==='assetType'&&!['work','recipe'].includes(action.value))return res.status(400).json({error:'操作值无效'})
  const images=await repository.listImages(scope(req));const changes=new Map<string,GalleryImage>()
  const results=targets.map((target:{id:string;version:number})=>{
   const image=images.find(i=>i.id===target.id&&!i.deletedAt)
   if(!image)return {id:target.id,ok:false,error:'条目不存在或已移入回收站'}
   if((image.version||0)!==target.version)return {id:target.id,ok:false,error:'条目已变化，请重新读取后重试'}
   const next={...image,version:(image.version||0)+1,updatedAt:new Date().toISOString()}
   if(action.type==='addTags')next.tags=[...new Set([...image.tags,...action.tags.map((t:string)=>t.trim())])] as string[]
   if(action.type==='removeTags')next.tags=image.tags.filter(t=>!action.tags.includes(t))
   if(action.type==='favorite')next.favorited=action.value
   if(action.type==='assetType')next.assetType=action.value
   if(action.type==='trash')next.deletedAt=new Date().toISOString()
   changes.set(image.id,next);return {id:image.id,ok:true,image:next}
  })
  try{if(changes.size&&action.type==='assetType')await preserveCollectionOwnership(repository,images,scope(req));if(changes.size)await repository.saveImages(images.map(i=>changes.get(i.id)||i),scope(req))}
  catch{return res.json({results:results.map(r=>r.ok?{id:r.id,ok:false,error:'保存失败，原记录未确认修改，请刷新核对后重试'}:r)})}
  res.json({results})
 }))
 router.post('/organization/export',async(req,res)=>{
  const ids=req.body?.imageIds
  if(!Array.isArray(ids)||ids.length<1||ids.length>100||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)return res.status(400).json({error:'每次请选择 1–100 项导出'})
  let temporary:string|undefined
  try{
   const entries=await coordinator.run(async()=>{
    const images=await repository.listImages(scope(req)),selected=ids.map(id=>images.find(image=>image.id===id&&!image.deletedAt))
    if(selected.some(image=>!image))throw new Error('包含不可访问条目，请刷新后重选')
    const entries=await galleryExportEntries(selected as GalleryImage[],assetStorage)
    temporary=await fs.mkdtemp(path.join(os.tmpdir(),'banana-export-'))
    for(const entry of entries)if(entry.file){const target=path.join(temporary,entry.name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(entry.file,target);entry.file=target}
    return entries
   })
   res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition','attachment; filename="banana-gallery-export.zip"');res.setHeader('Cache-Control','no-store')
   await pipeline(Readable.from(zipEntries(entries)),res)
  }catch(error){if(!res.headersSent)res.status(400).json({error:error instanceof Error?error.message:'导出失败'});else res.destroy()}
  finally{if(temporary)await fs.rm(temporary,{recursive:true,force:true})}
 })
 router.get('/groups',async(req,res)=>{
  if(repository instanceof JsonGalleryRepository){
   const {resources,images}=repository.readOnlySnapshot()
   return res.json(normalizeCollections(resources.groups||[],images))
  }
  const [resources,images]=await Promise.all([repository.readResources?.(scope(req)),repository.listImages(scope(req))])
  res.json(normalizeCollections(resources?.groups||[],images))
 })
 router.post('/groups',async(req,res)=>coordinator.run(async()=>{
  if(!repository.readResources||!repository.saveResources)return res.status(503).json({error:'当前存储不支持收藏夹'})
  const {name,imageIds,assetType:requestedType}=req.body||{}
  if(typeof name!=='string'||!name.trim()||name.length>100||!Array.isArray(imageIds)||imageIds.length>500||imageIds.some(id=>typeof id!=='string'))return res.status(400).json({error:'请填写收藏夹名称，最多收纳 500 个条目'})
  const images=await repository.listImages(scope(req));if(imageIds.some(id=>!images.some(i=>i.id===id&&!i.deletedAt)))return res.status(404).json({error:'包含不可用条目'})
  const types=new Map(images.map(image=>[image.id,image.assetType]))
  const assetType=requestedType===undefined?(imageIds.length?types.get(imageIds[0]):'recipe'):requestedType
  if(!['recipe','work'].includes(assetType)||imageIds.some((id:string)=>types.get(id)!==assetType))return res.status(400).json({error:'收藏夹只能加入同类型条目'})
  const group:ResultGroup={id:randomUUID(),assetType,name:name.trim(),imageIds:[...new Set(imageIds)] as string[],coverId:imageIds[0],version:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
  const resources=await repository.readResources(scope(req));await repository.saveResources({...resources,groups:[...normalizeCollections(resources.groups||[],images),group]},scope(req));res.status(201).json(group)
 }))
 router.patch('/groups/:id',async(req,res)=>coordinator.run(async()=>{
  if(!repository.readResources||!repository.saveResources)return res.status(503).json({error:'当前存储不支持收藏夹'})
  const resources=await repository.readResources(scope(req)),images=await repository.listImages(scope(req)),groups=normalizeCollections(resources.groups||[],images),group=groups.find(g=>g.id===req.params.id)
  const types=new Map(images.map(image=>[image.id,image]))
  if(!group)return res.status(404).json({error:'收藏夹不存在'})
  if(req.body.expectedVersion!==group.version)return res.status(409).json({error:'收藏夹已变化，请刷新后重试'})
  if(req.body.assetType!==undefined&&req.body.assetType!==group.assetType)return res.status(400).json({error:'不能改变收藏夹归属'})
  const next={...group,version:group.version+1,updatedAt:new Date().toISOString()}
  if(req.body.name!==undefined){if(typeof req.body.name!=='string'||!req.body.name.trim()||req.body.name.length>100)return res.status(400).json({error:'收藏夹名称无效'});next.name=req.body.name.trim()}
  if(req.body.imageIds!==undefined){
   const ids=req.body.imageIds
   if(!Array.isArray(ids)||ids.length>500||ids.some(id=>typeof id!=='string'||(!group.imageIds.includes(id)&&(!types.has(id)||types.get(id)!.deletedAt||types.get(id)!.assetType!==group.assetType))))return res.status(400).json({error:'收藏夹成员无效'})
   next.imageIds=[...new Set(ids)] as string[]
   if(!next.imageIds.includes(next.coverId||''))next.coverId=next.imageIds.find(id=>types.get(id)?.assetType===group.assetType&&!types.get(id)?.deletedAt)
   if(!next.imageIds.includes(next.bestId||''))delete next.bestId
  }
  for(const key of ['coverId','bestId'] as const)if(req.body[key]!==undefined){if(req.body[key]!==null&&(!next.imageIds.includes(req.body[key])||(req.body[key]!==group[key]&&(types.get(req.body[key])?.assetType!==group.assetType||types.get(req.body[key])?.deletedAt))))return res.status(400).json({error:'封面与最佳结果必须属于本收藏夹'});next[key]=req.body[key]||undefined}
  await repository.saveResources({...resources,groups:groups.map(g=>g.id===group.id?next:g)},scope(req));res.json(next)
 }))
 router.delete('/groups/:id',async(req,res)=>coordinator.run(async()=>{
  if(!repository.readResources||!repository.saveResources)return res.status(503).json({error:'当前存储不支持收藏夹'})
  const resources=await repository.readResources(scope(req)),groups=normalizeCollections(resources.groups||[],await repository.listImages(scope(req)));const group=groups.find(g=>g.id===req.params.id)
  if(group&&req.body.expectedVersion!==group.version)return res.status(409).json({error:'收藏夹已变化，请刷新后重试'})
  await repository.saveResources({...resources,groups:groups.filter(g=>g.id!==req.params.id)},scope(req));res.json({ok:true})
 }))
 return router
}
