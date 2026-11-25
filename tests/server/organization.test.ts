import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import {afterEach,expect,it,vi} from 'vitest'
import {JsonGalleryRepository} from '../../server/gallery/json-gallery-repository'
import {createApp} from '../../server/app'
const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
function fixture(resources:Record<string,unknown>={},workIds:string[]=[]){const root=fs.mkdtempSync(path.join(os.tmpdir(),'banana-organize-'));roots.push(root);const dataFile=path.join(root,'gallery-data.json');fs.writeFileSync(dataFile,JSON.stringify({resources,images:Array.from({length:21},(_,i)=>({id:String(i),filename:'a.png',prompt:'same prompt',referenceImages:[],tags:['gemini-web'],favorited:false,createdAt:'2026-09-11',width:1,height:1,assetType:workIds.includes(String(i))?'work':'recipe'}))}));const app=createApp({ai:{models:{generateContent:async()=>({candidates:[]})}},strategy:{mode:'apiKey',apiKey:'fixture'},dataFile,imagesDir:path.join(root,'images'),referencesDir:path.join(root,'references'),userAuthMode:'local',localAuthSession:{user:{id:'test',email:'test@local'},workspace:{id:'test',name:'Test'}}});fs.writeFileSync(path.join(root,'images','a.png'),'fixture bytes');return {app,dataFile}}
it('modifies only explicit IDs, reports missing/conflicting items, and preserves independent prompts',async()=>{
 const {app}=fixture();const targets=Array.from({length:20},(_,i)=>({id:String(i),version:0}));
 const response=await request(app).post('/api/organization/batch').send({targets:[...targets,{id:'missing',version:0}],action:{type:'addTags',tags:['portrait']}})
 expect(response.status).toBe(200);expect(response.body.results.filter((r:{ok:boolean})=>r.ok)).toHaveLength(20);expect(response.body.results.at(-1).ok).toBe(false)
 expect((await request(app).get('/api/images/20')).body.tags).toEqual(['gemini-web'])
 const conflict=await request(app).post('/api/organization/batch').send({targets:[{id:'0',version:0}],action:{type:'favorite',value:true}});expect(conflict.body.results[0].ok).toBe(false)
})
it('persists groups, validates cover and best membership, and keeps membership through trash/restore',async()=>{
 const {app,dataFile}=fixture();const group=await request(app).post('/api/groups').send({name:'光线实验',imageIds:['0','1']});expect(group.status).toBe(201)
 const id=group.body.id;expect(JSON.parse(fs.readFileSync(dataFile,'utf8')).resources.groups[0].id).toBe(id)
 expect((await request(app).patch(`/api/groups/${id}`).send({expectedVersion:0,bestId:'20'})).status).toBe(400)
 expect((await request(app).patch(`/api/groups/${id}`).send({expectedVersion:0,bestId:'1',coverId:'0'})).status).toBe(200)
 await request(app).delete('/api/images/1');await request(app).post('/api/trash/1/restore')
 expect((await request(app).get('/api/groups')).body[0].imageIds).toEqual(['0','1'])
 expect((await request(app).get('/api/groups')).body[0].bestId).toBe('1')
 const backup=await request(app).post('/api/personal/backups');expect(backup.status).toBe(201)
 const snapshot=JSON.parse(fs.readFileSync(path.join(path.dirname(dataFile),'backups',backup.body.id,'gallery-data.json'),'utf8'))
 expect(snapshot.resources.groups[0].bestId).toBe('1')
})
it('creates empty collections and assigns their first member as cover without changing image likes',async()=>{
 const {app}=fixture()
 const created=await request(app).post('/api/groups').send({name:'居家系列',imageIds:[]})
 expect(created.status).toBe(201);expect(created.body.imageIds).toEqual([])
 const added=await request(app).patch(`/api/groups/${created.body.id}`).send({expectedVersion:0,imageIds:['0']})
 expect(added.status).toBe(200);expect(added.body.coverId).toBe('0')
 expect((await request(app).get('/api/images/0')).body.favorited).toBe(false)
 expect((await request(app).delete(`/api/groups/${created.body.id}`).send({expectedVersion:1})).status).toBe(200)
 expect((await request(app).get('/api/images/0')).status).toBe(200)
})

const legacyGroup = (id:string,imageIds:string[]) => ({id,name:id,imageIds,coverId:imageIds[0],bestId:imageIds.at(-1),version:2,createdAt:'2026-01-01',updatedAt:'2026-01-02'})
it('reads legacy mixed, empty, trashed and missing members without writing and splits deterministically',async()=>{
 const raw=[{...legacyGroup('mixed',['0','1','missing']),bestId:'1'},legacyGroup('empty',[]),legacyGroup('work',['1']),legacyGroup('mixed:work',[])]
 const {app,dataFile}=fixture({groups:raw},['1'])
 await request(app).delete('/api/images/1')
 let before=fs.readFileSync(dataFile,'utf8')
 const groups=(await request(app).get('/api/groups')).body
 expect(groups).toHaveLength(5)
 expect(groups.find((g:{id:string})=>g.id==='mixed')).toMatchObject({assetType:'recipe',imageIds:['0','missing'],coverId:'0',version:3})
 const work=groups.find((g:{name:string;assetType:string})=>g.name==='mixed'&&g.assetType==='work')
 expect(work).toMatchObject({imageIds:['1'],coverId:'1',bestId:'1'});expect(work.id).not.toBe('mixed:work')
 await request(app).post('/api/trash/1/restore')
 expect((await request(app).get(`/api/images?group=${encodeURIComponent(work.id)}&assetType=work`)).body.map((i:{id:string})=>i.id)).toEqual(['1'])
 expect((await request(app).get(`/api/gallery/stats?group=${encodeURIComponent(work.id)}&assetType=work`)).body.total).toBe(1)
 await request(app).delete('/api/images/1')
 before=fs.readFileSync(dataFile,'utf8')
 expect(groups.find((g:{id:string})=>g.id==='empty').assetType).toBe('recipe')
 expect(groups.find((g:{id:string})=>g.id==='work').assetType).toBe('work')
 expect((await request(app).get('/api/groups')).body).toEqual(groups)
 expect(fs.readFileSync(dataFile,'utf8')).toBe(before)
 expect((await request(app).patch('/api/groups/mixed').send({expectedVersion:2,name:'stale'})).status).toBe(409)
 expect((await request(app).patch('/api/groups/mixed').send({expectedVersion:3,name:'renamed'})).status).toBe(200)
 expect(JSON.parse(fs.readFileSync(dataFile,'utf8')).resources.groups).toHaveLength(5)
 expect((await request(app).get('/api/groups')).body.find((g:{id:string})=>g.id===work.id)).toEqual(work)
})
it('creates independently typed empty folders and rejects mixed or invalid new members',async()=>{
 const {app}=fixture()
 await request(app).post('/api/organization/batch').send({targets:[{id:'1',version:0}],action:{type:'assetType',value:'work'}})
 const work=await request(app).post('/api/groups').send({name:'same',imageIds:[],assetType:'work'})
 const recipe=await request(app).post('/api/groups').send({name:'same',imageIds:[],assetType:'recipe'})
 expect(work.body.assetType).toBe('work');expect(recipe.body.assetType).toBe('recipe')
 expect((await request(app).post('/api/groups').send({name:'bad',imageIds:[],assetType:'invalid'})).status).toBe(400)
 expect((await request(app).post('/api/groups').send({name:'bad',imageIds:['0','1']})).status).toBe(400)
 expect((await request(app).post('/api/groups').send({name:'bad',imageIds:['0'],assetType:'work'})).status).toBe(400)
 expect((await request(app).post('/api/groups').send({name:'inferred',imageIds:['1']})).body.assetType).toBe('work')
 expect((await request(app).patch(`/api/groups/${work.body.id}`).send({expectedVersion:0,assetType:'recipe'})).status).toBe(400)
 expect((await request(app).patch(`/api/groups/${work.body.id}`).send({expectedVersion:0,imageIds:['0']})).status).toBe(400)
 expect((await request(app).patch(`/api/groups/${work.body.id}`).send({expectedVersion:0,imageIds:['1']})).status).toBe(200)
 expect((await request(app).delete(`/api/groups/${recipe.body.id}`).send({expectedVersion:0})).status).toBe(200)
 expect((await request(app).get('/api/groups')).body.some((g:{id:string})=>g.id===work.body.id)).toBe(true)
})
it('keeps fixed ownership and old references after reclassification, including missing members',async()=>{
 const {app}=fixture({groups:[{...legacyGroup('typed',['0','missing']),coverId:'missing',assetType:'recipe'}]})
 await request(app).post('/api/organization/batch').send({targets:[{id:'0',version:0}],action:{type:'assetType',value:'work'}})
 expect((await request(app).get('/api/groups')).body[0]).toMatchObject({assetType:'recipe',imageIds:['0','missing']})
 expect((await request(app).patch('/api/groups/typed').send({expectedVersion:2,imageIds:['0','missing','2']})).status).toBe(200)
 expect((await request(app).patch('/api/groups/typed').send({expectedVersion:3,coverId:'0'})).status).toBe(400)
})

it('does not persist partial normalization on a failed group write and preserves other resources',async()=>{
 const {app,dataFile}=fixture({groups:[legacyGroup('old',['0'])],preferences:{marker:'keep'}})
 const before=fs.readFileSync(dataFile,'utf8')
 const save=vi.spyOn(JsonGalleryRepository.prototype,'saveResources').mockRejectedValueOnce(new Error('disk unavailable'))
 try {
  expect((await request(app).patch('/api/groups/old').send({expectedVersion:3,name:'new'})).status).toBe(500)
  expect(fs.readFileSync(dataFile,'utf8')).toBe(before)
 } finally {save.mockRestore()}
 expect((await request(app).patch('/api/groups/old').send({expectedVersion:3,name:'new'})).status).toBe(200)
 const stored=JSON.parse(fs.readFileSync(dataFile,'utf8')).resources
 expect(stored.preferences).toEqual({marker:'keep'})
 expect(stored.groups[0]).toMatchObject({assetType:'recipe',name:'new',version:4})
 const restarted=new JsonGalleryRepository(dataFile)
 expect((await restarted.readResources()).groups).toEqual((await request(app).get('/api/groups')).body)
})

it.each(['batch','patch'])('freezes legacy ownership before %s reclassification and prevents editing the opposite folder',async(mode)=>{
 const {app}=fixture({groups:[legacyGroup('mixed',['0','1'])]},['1'])
 const before=(await request(app).get('/api/groups')).body
 expect(before).toHaveLength(2)
 if(mode==='batch')await request(app).post('/api/organization/batch').send({targets:[{id:'0',version:0}],action:{type:'assetType',value:'work'}})
 else {
  const patched=await request(app).patch('/api/images/0').send({expectedVersion:0,assetType:'work'})
  expect(patched.body.assetType).toBe('recipe') // Metadata endpoint does not accept reclassification.
 }
 expect((await request(app).get('/api/groups')).body).toEqual(before)
 expect((await request(app).get('/api/images?group=mixed&assetType=work')).body).toEqual([])
 const renamed=await request(app).patch('/api/groups/mixed').send({expectedVersion:before[0].version,name:'recipe renamed'})
 expect(renamed.body.assetType).toBe('recipe')
 expect((await request(app).get('/api/groups')).body.find((g:{assetType:string})=>g.assetType==='work').name).toBe('mixed')
})

it('freezes a legacy work folder before its last member is permanently removed',async()=>{
 const {app}=fixture({groups:[legacyGroup('work',['1'])]},['1'])
 await request(app).delete('/api/images/1')
 const before=(await request(app).get('/api/groups')).body
 expect((await request(app).delete('/api/trash/1').send({confirm:true})).status).toBe(200)
 expect((await request(app).get('/api/groups')).body).toEqual(before)
})
it('does not reclassify an image when preserving ownership fails',async()=>{
 const {app}=fixture({groups:[legacyGroup('recipe',['0'])]})
 const save=vi.spyOn(JsonGalleryRepository.prototype,'saveResources').mockRejectedValueOnce(new Error('disk unavailable'))
 try{
  expect((await request(app).post('/api/organization/batch').send({targets:[{id:'0',version:0}],action:{type:'assetType',value:'work'}})).body.results[0].ok).toBe(false)
  expect((await request(app).get('/api/images/0')).body.assetType).toBe('recipe')
 }finally{save.mockRestore()}
})
