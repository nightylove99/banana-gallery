import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import sharp from 'sharp'
import {afterEach,expect,it,vi} from 'vitest'
import {createApp} from '../../server/app'
const apps:ReturnType<typeof createApp>[]=[]
const roots:string[]=[]
afterEach(async()=>{for(const app of apps.splice(0))await app.locals.stopTaskQueue();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})

async function fixture(){const png=await sharp({create:{width:2,height:2,channels:3,background:"red"}}).png().toBuffer();const root=fs.mkdtempSync(path.join(os.tmpdir(),'banana-library-'));roots.push(root);const dataFile=path.join(root,'gallery.json');fs.writeFileSync(dataFile,JSON.stringify({images:[{id:'original',filename:'original.png',prompt:'original',referenceImages:['existing.png'],tags:[],favorited:false,assetType:'work',width:1,height:1,createdAt:'2026-09-11'}]}));const app=createApp({ai:{models:{generateContent:async()=>({candidates:[]})}},imageGenerationProvider:{generateImage:async()=>({buffer:png,mimeType:'image/png'})},strategy:{mode:'apiKey',apiKey:'test'},dataFile,imagesDir:path.join(root,'images'),referencesDir:path.join(root,'references'),userAuthMode:'local',localAuthSession:{user:{id:'test',email:'test@local'},workspace:{id:'test',name:'test'}}});fs.writeFileSync(path.join(root,'images','original.png'),png);fs.writeFileSync(path.join(root,'references','existing.png'),png);apps.push(app);return {app,root,dataFile}}
it('adds owned main images and references, suggests/reuses identical bytes, and keeps independent metadata',async()=>{
 const {app,root}=await fixture();const a=await request(app).post('/api/reference-library/assets').send({kind:'images',filename:'original.png',name:'角色'});expect(a.status).toBe(201)
 const b=await request(app).post('/api/reference-library/assets').send({kind:'references',filename:'existing.png',name:'姿势'});expect(b.status).toBe(201);expect(b.body.asset.id).not.toBe(a.body.asset.id);expect(b.body.asset.versions[0].filename).toBe(a.body.asset.versions[0].filename);expect(b.body.duplicates).toContain(a.body.asset.id)
 await request(app).patch(`/api/reference-library/assets/${a.body.asset.id}`).send({expectedVersion:0,name:'角色 A',tags:['角色'],favorited:true})
 const library=(await request(app).get('/api/reference-library')).body;expect(library.assets.find((item:{id:string})=>item.id===b.body.asset.id).name).toBe('姿势')
 await request(app).delete('/api/images/original');await request(app).delete('/api/trash/original').send({confirm:true})
 expect(fs.existsSync(path.join(root,'references',a.body.asset.versions[0].filename))).toBe(true)
 expect((await request(app).post('/api/reference-library/assets').send({kind:'images',filename:'foreign.png',name:'no'})).status).toBe(404)
})
it('freezes ordered combination versions through asset replacement, trash and backup',async()=>{
 const {app,root}=await fixture();const asset=(await request(app).post('/api/reference-library/assets').send({kind:'references',filename:'existing.png',name:'图'})).body.asset
 const items=[{assetId:asset.id,versionId:asset.currentVersionId,note:'先用作姿势'},{assetId:asset.id,versionId:asset.currentVersionId,note:'再用作风格'}]
 const combo=await request(app).post('/api/reference-library/combinations').send({name:'有序组合',items});expect(combo.status).toBe(201)
 fs.writeFileSync(path.join(root,'images','original.png'),await sharp({create:{width:2,height:2,channels:3,background:'blue'}}).png().toBuffer())
 const replacement=await request(app).post(`/api/reference-library/assets/${asset.id}/versions`).send({expectedVersion:0,kind:'images',filename:'original.png'});expect(replacement.status).toBe(200);expect(replacement.body.asset.versions).toHaveLength(2);expect(replacement.body.asset.versions[1].filename).not.toBe(asset.versions[0].filename)
 expect((await request(app).patch(`/api/reference-library/assets/${asset.id}`).send({expectedVersion:0,name:'stale'})).status).toBe(409)
 await request(app).patch(`/api/reference-library/assets/${asset.id}`).send({expectedVersion:1,deleted:true})
 const library=(await request(app).get('/api/reference-library')).body;expect(library.combinations[0].items).toEqual(items);expect(library.assets[0].deletedAt).toBeTruthy()
 const backup=await request(app).post('/api/personal/backups');expect(backup.status).toBe(201);expect(fs.existsSync(path.join(root,'backups',backup.body.id,'public','references',asset.versions[0].filename))).toBe(true)
})

it('ordered material notes survive submission, later replacement and saving as a recipe',async()=>{
 const {app}=await fixture()
 const asset=(await request(app).post('/api/reference-library/assets').send({kind:'references',filename:'existing.png',name:'素材'})).body.asset
 const filename=asset.versions[0].filename
 const response=await request(app).post('/api/generation-tasks').send({key:'ordered-materials',prompt:'test',provider:'google',model:'gemini-nano-banana-2.1',aspectRatio:'1:1',imageSize:'2K',referenceFilenames:[filename,filename],referenceNotes:['角色','姿势']})
 expect(response.status).toBe(202)
 await vi.waitFor(async()=>expect((await request(app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 await request(app).post(`/api/reference-library/assets/${asset.id}/versions`).send({expectedVersion:0,kind:'images',filename:'original.png'})
 const saved=await request(app).post('/api/generate/save').send({taskId:response.body.id,assetType:'recipe'})
 expect(saved.body.referenceImages).toEqual([filename,filename]);expect(saved.body.referenceNotes).toEqual(['角色','姿势'])
})
