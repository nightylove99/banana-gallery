import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import {afterEach,expect,it} from 'vitest'
import {createApp} from '../../server/app'
const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'banana-personal-settings-')),dataFile=path.join(root,'gallery.json');roots.push(root);fs.writeFileSync(dataFile,JSON.stringify({images:[]}));const options={ai:{models:{generateContent:async()=>({candidates:[]})}},strategy:{mode:'googleUnavailable' as const},dataFile,imagesDir:path.join(root,'images'),referencesDir:path.join(root,'references'),userAuthMode:'local' as const,localAuthSession:{user:{id:'test',email:'fake@local'},workspace:{id:'test',name:'test'}}};return {root,options,app:createApp(options)}}
it('reads retired Poe preferences through both endpoints without rewriting stored data', async () => {
 const {app,options} = fixture()
 const stored = JSON.stringify({images:[],resources:{preferences:{
  version: 3,
  defaultGeneration: {provider:'poe',model:'gpt-image-2',aspectRatio:'auto',quality:'medium'},
  favoriteModels: ['poe:gpt-image-2','seedream:doubao-seedream-5-5-261028'],
 }}})
 fs.writeFileSync(options.dataFile, stored)
 const {body: preferences} = await request(app).get('/api/preferences').expect(200)
 const {body: models} = await request(app).get('/api/generation/models').expect(200)
 const google = {provider:'google',model:'gemini-nano-banana-2.1'}
 expect(preferences).toMatchObject({
  version: 3,
  defaultGeneration: {...google,aspectRatio:'1:1',imageSize:'2K'},
  favoriteModels: ['seedream:doubao-seedream-5-5-261028'],
 })
 expect(models.defaultSettings).toEqual(preferences.defaultGeneration)
 expect(models.defaultModel).toEqual(google)
 expect(models.models[0].provider).toBe('seedream')
 expect(fs.readFileSync(options.dataFile,'utf8')).toBe(stored)
})

it('persists compatible defaults and favorite order through restart without choosing another provider',async()=>{
 const {app,options}=fixture(),defaultGeneration={provider:'openai-compatible',model:'gpt-image-1',aspectRatio:'3:2',quality:'medium'}
 expect((await request(app).patch('/api/preferences').send({expectedVersion:0,defaultGeneration,favoriteModels:['google:gemini-nano-banana-2.1','openai-compatible:gpt-image-1'],gallery:{density:'compact',fit:'contain'}})).status).toBe(200)
 const restarted=createApp(options),models=(await request(restarted).get('/api/generation/models')).body
 expect(models.defaultSettings).toEqual({...defaultGeneration,model:'gpt-image-1'});expect(models.defaultModel).toEqual({provider:'openai-compatible',model:'gpt-image-1'});expect(models.models.slice(0,2).map((model:{model:string})=>model.model)).toEqual(['gemini-nano-banana-2.1','gpt-image-1'])
 expect((await request(restarted).patch('/api/preferences').send({expectedVersion:0,favoriteModels:[]})).status).toBe(409)
 expect((await request(restarted).patch('/api/preferences').send({expectedVersion:1,defaultGeneration:{...defaultGeneration,quality:'invalid'}})).status).toBe(400)
})
it('counts shared physical files once and clears only rebuildable thumbnail cache',async()=>{
 const {app,options,root}=fixture();fs.writeFileSync(path.join(root,'images','a.png'),'main');fs.writeFileSync(path.join(root,'references','ref.png'),'ref');fs.writeFileSync(path.join(root,'images','legacy.png'),'unknown')
 const image={id:'a',filename:'a.png',referenceImages:['ref.png'],prompt:'x',assetType:'work',tags:[],favorited:false,width:1,height:1,createdAt:'2026-09-11'}
 fs.writeFileSync(options.dataFile,JSON.stringify({images:[image,{...image,id:'b',deletedAt:'2026-09-11'},{...image,id:'recipe',assetType:'recipe'}],resources:{referenceAssets:[{id:'material',versions:[{filename:'ref.png'}]}]}}))
 fs.mkdirSync(path.join(root,'cache','thumbnails'),{recursive:true});fs.writeFileSync(path.join(root,'cache','thumbnails','cached.webp'),'cache')
 const summary=(await request(app).get('/api/personal/storage')).body
 expect(summary.originals).toEqual({files:2,bytes:11});expect(summary.references).toEqual({files:1,bytes:3});expect(summary.unreferenced.images.files).toBe(1);expect(summary.galleryEntries).toBe(2);expect(summary.workEntries).toBe(1)
 expect((await request(app).post('/api/personal/storage/clear-cache').send({confirm:true})).status).toBe(200)
 expect(fs.existsSync(path.join(root,'images','a.png'))).toBe(true);expect(fs.existsSync(path.join(root,'references','ref.png'))).toBe(true)
 expect((await request(app).get('/api/personal/storage')).body.cache.bytes).toBe(0)
})

it('reads old Lite defaults as 5.5 without changing historical data or writing the preferences file', async () => {
 const {app,options}=fixture()
 const legacy={version:3,defaultGeneration:{provider:'seedream',model:'doubao-seedream-5-0-260128',aspectRatio:'16:9',imageSize:'4K'},favoriteModels:['seedream:doubao-seedream-5-0-260128']}
 const stored=JSON.stringify({images:[],resources:{preferences:legacy}})
 fs.writeFileSync(options.dataFile,stored)
 const prefs=(await request(app).get('/api/preferences')).body
 expect(prefs.defaultGeneration).toEqual({...legacy.defaultGeneration,model:'doubao-seedream-5-5-261028',imageSize:'2K'})
 expect(prefs.favoriteModels).toEqual(['seedream:doubao-seedream-5-5-261028'])
 const models=(await request(app).get('/api/generation/models')).body
 expect(models.defaultModel.model).toBe('doubao-seedream-5-5-261028')
 expect(models.defaultSettings).toEqual(prefs.defaultGeneration)
 expect(models.models[0].model).toBe('doubao-seedream-5-5-261028')
 expect(fs.readFileSync(options.dataFile,'utf8')).toBe(stored)
})

it('merges concurrent gallery appearance changes without overwriting other preferences', async () => {
 const {app,options} = fixture()
 const api = request(app)
 const defaultGeneration = {provider:'openai-compatible',model:'gpt-image-1',aspectRatio:'3:2',quality:'medium'}
 await api.patch('/api/preferences').send({expectedVersion:0,defaultGeneration}).expect(200)
 await Promise.all([
  api.patch('/api/preferences').send({gallery:{density:'roomy'}}).expect(200),
  api.patch('/api/preferences').send({gallery:{fit:'contain'}}).expect(200),
 ])
 const {body} = await request(createApp(options)).get('/api/preferences').expect(200)
 expect(body).toMatchObject({version:3,defaultGeneration,gallery:{density:'roomy',fit:'contain'}})
 await api.patch('/api/preferences').send({gallery:{density:'compact'},favoriteModels:[]}).expect(409)
 await api.patch('/api/preferences').send({gallery:{fit:'invalid'}}).expect(400)
})
