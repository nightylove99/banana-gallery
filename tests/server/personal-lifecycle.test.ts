import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import request from 'supertest'
import {expect,it,vi} from 'vitest'
import {createApp} from '../../server/app'
import {JsonGalleryRepository} from '../../server/gallery/json-gallery-repository'
import {GalleryBackups} from '../../server/personal/backups'
import {localNamingSuggestion} from '../../src/lib/naming-suggestions'
it('completes the personal lifecycle and restores images, history, materials, groups and preferences together',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'banana-lifecycle-')),dataFile=path.join(root,'gallery-data.json'),imagesDir=path.join(root,'public/images'),referencesDir=path.join(root,'public/references'),backupDir=path.join(root,'backups')
 const png=await sharp({create:{width:40,height:30,channels:3,background:'purple'}}).png().toBuffer()
 const warmed:string[]=[]
 const app=createApp({ai:{models:{generateContent:async()=>({candidates:[]})}},imageGenerationProvider:{generateImage:async()=>({buffer:png,mimeType:'image/png'})},strategy:{mode:'apiKey',apiKey:'fixture'},dataFile,imagesDir,referencesDir,backupDir,userAuthMode:'local',localAuthSession:{user:{id:'fixture',email:'fixture@local'},workspace:{id:'fixture',name:'fixture'}},thumbnailCache:{get:async source=>source,warm:async source=>{warmed.push(source);return source}}})
 try{
  const imported=await request(app).post('/api/external/gemini-web/import').field('metadata',JSON.stringify({prompt:'人像摄影，柔和光线',assetType:'recipe',requestId:'lifecycle-import',checkDuplicates:true})).attach('image',png,{filename:'input.png',contentType:'image/png'})
  expect(imported.status).toBe(200);let recipe=imported.body
  const suggestion=localNamingSuggestion(recipe)
  recipe=(await request(app).patch(`/api/images/${recipe.id}`).send({expectedVersion:0,title:suggestion.title,tags:suggestion.tags,favorited:true})).body
  const found=await request(app).get('/api/images').query({q:'人像',favorites:'true'});expect(found.body.some((image:{id:string})=>image.id===recipe.id)).toBe(true)
  const material=(await request(app).post('/api/reference-library/assets').send({kind:'images',filename:recipe.filename,name:'角色参考'})).body.asset
  const combo=(await request(app).post('/api/reference-library/combinations').send({name:'常用角色',items:[{assetId:material.id,versionId:material.currentVersionId,note:'角色'}]})).body
  const task=await request(app).post('/api/generation-tasks').send({key:'lifecycle-generate',prompt:recipe.prompt,provider:'google',model:'gemini-nano-banana-2.1',aspectRatio:'1:1',imageSize:'2K',referenceFilenames:[material.versions[0].filename],referenceNotes:['角色'],sourceAssetId:recipe.id})
  expect(task.status).toBe(202)
  await vi.waitFor(async()=>expect((await request(app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
  const work=(await request(app).post('/api/generate/save').send({taskId:task.body.id,assetType:'work'})).body
  expect(warmed).toEqual([path.join(imagesDir,recipe.filename),path.join(imagesDir,recipe.filename),path.join(imagesDir,work.filename),path.join(imagesDir,work.filename)])
  const group=(await request(app).post('/api/groups').send({name:'同一轮结果',assetType:'work',imageIds:[work.id]})).body
  expect((await request(app).patch(`/api/groups/${group.id}`).send({expectedVersion:0,bestId:work.id})).status).toBe(200)
  const recipeGroup=await request(app).post('/api/groups').send({name:'同一轮结果',assetType:'recipe',imageIds:[recipe.id]});expect(recipeGroup.status).toBe(201)
  const exported=await request(app).post('/api/organization/export').send({imageIds:[recipe.id,work.id]});expect(exported.status).toBe(200);expect(exported.headers['content-type']).toContain('zip')
  await request(app).delete(`/api/images/${work.id}`);expect((await request(app).post(`/api/trash/${work.id}/restore`)).body.sourceAssetId).toBe(recipe.id)
  expect((await request(app).patch('/api/preferences').send({expectedVersion:0,defaultGeneration:{provider:'google',model:'gemini-nano-banana-2.1',aspectRatio:'4:3',imageSize:'2K'},favoriteModels:[]})).status).toBe(200)
  const backup=(await request(app).post('/api/personal/backups')).body
  await app.locals.stopTaskQueue()
  const restored=path.join(root,'restored'),service=new GalleryBackups({dataFile,imagesDir,referencesDir,backupDir})
  await service.restoreTo(backup.id,restored)
  const data=JSON.parse(fs.readFileSync(path.join(restored,'gallery-data.json'),'utf8'))
  expect(data.resources.groups).toHaveLength(2);expect(data.resources.groups[1]).toMatchObject({assetType:'recipe',imageIds:[recipe.id]});expect(data.images).toHaveLength(2);expect(data.resources.referenceCombinations[0].id).toBe(combo.id);expect(data.resources.groups[0].bestId).toBe(work.id);expect(data.resources.preferences.defaultGeneration.aspectRatio).toBe('4:3')
  const resources = await new JsonGalleryRepository(path.join(restored, 'gallery-data.json')).readResources()
  expect(resources.generationTasks?.[0]).toMatchObject({ id: task.body.id, status: 'completed' })
  expect(fs.readFileSync(path.join(restored,'public/references',material.versions[0].filename))).toEqual(png)
 }finally{await app.locals.stopTaskQueue();fs.rmSync(root,{recursive:true,force:true})}
})
