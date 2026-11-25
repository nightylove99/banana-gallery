import {Router} from 'express'
import type {GalleryRepository} from '../gallery/gallery-repository'
import type {GalleryWriteCoordinator} from '../gallery/write-coordinator'
import type {ImageGenerationModelDefinition} from '../../src/lib/image-generation-providers'
import {imageGenerationModelKey,normalizeGenerationDefaults,normalizeGenerationPreferences,normalizeFavoriteModelKeys} from '../../src/lib/image-generation-providers'
import {parseTaskInput} from '../generation/task-input'
import {TaskError} from '../generation/task-queue'
export function createPreferencesRouter(repository:GalleryRepository,coordinator:GalleryWriteCoordinator,getModels:()=>ImageGenerationModelDefinition[]){
 const router=Router();router.use((req,res,next)=>{if(!req.authSession){res.status(401).json({error:'UNAUTHORIZED'});return}next()})
 router.get('/',async(req,res)=>{const session=req.authSession!,scope={workspaceId:session.workspace.id,ownerUserId:session.user.id};res.json(normalizeGenerationPreferences((await repository.readResources?.(scope))?.preferences||{version:0,favoriteModels:[]}))})
 router.patch('/',async(req,res)=>{try{const result=await coordinator.run(async()=>{
  const session=req.authSession!,scope={workspaceId:session.workspace.id,ownerUserId:session.user.id},resources=await repository.readResources?.(scope)||{},current=normalizeGenerationPreferences(resources.preferences||{version:0,favoriteModels:[]}),body=req.body||{}
  // Toolbar changes only own their gallery fields. Merge them under the same
  // write lock without bypassing the version check for any other preference.
  const galleryOnly = body.expectedVersion === undefined && Object.keys(body).length === 1 && Object.hasOwn(body, 'gallery')
  if(!galleryOnly && body.expectedVersion!==current.version)throw new TaskError('设置已在其他窗口修改，请刷新后重试',409)
  const models=getModels()
  const next={...current,version:current.version+1}
  if (body.defaultGeneration !== undefined) {
   const defaults = body.defaultGeneration?.provider === 'poe'
    ? normalizeGenerationDefaults(body.defaultGeneration)
    : body.defaultGeneration
   const {provider,model,aspectRatio,imageSize,quality} = parseTaskInput({...defaults,prompt:'validate',referenceFilenames:[]},models)
   next.defaultGeneration = {provider,model,aspectRatio,imageSize,quality}
  }
  const submittedFavorites: unknown = body.favoriteModels
  if (submittedFavorites !== undefined) {
   if (!Array.isArray(submittedFavorites) ||
    !submittedFavorites.every((key): key is string => typeof key === 'string')) {
    throw new TaskError('常用模型列表无效')
   }
   const favorites = normalizeFavoriteModelKeys(submittedFavorites)
   const modelKeys = new Set(models.map(model => imageGenerationModelKey(model.provider, model.model)))
   if (favorites.length > models.length || favorites.some(key => !modelKeys.has(key))) throw new TaskError('常用模型列表无效')
   next.favoriteModels = favorites
  }
  if(body.gallery!==undefined){
   const gallery = body.gallery
   if(!gallery || typeof gallery !== 'object' || Array.isArray(gallery)) throw new TaskError('图库显示设置无效')
   const keys = Object.keys(gallery)
   if(!keys.length || keys.some(key => key !== 'density' && key !== 'fit')) throw new TaskError('图库显示设置无效')
   const {density,fit} = galleryOnly ? {density:'standard',fit:'cover',...current.gallery,...gallery} : gallery
   if(!['compact','standard','roomy'].includes(density) || !['cover','contain'].includes(fit)) throw new TaskError('图库显示设置无效')
   next.gallery = {density,fit}
  }
  if(!repository.saveResources)throw new TaskError('当前存储不支持偏好保存',503)
  await repository.saveResources({...resources,preferences:next},scope);return next
 });res.json(result)}catch(error){res.status(error instanceof TaskError?error.status:500).json({error:error instanceof TaskError?error.message:'设置保存失败'})}})
 return router
}
