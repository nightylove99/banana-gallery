import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {expect,it} from 'vitest'
import {galleryExportEntries,zipEntries} from '../../server/gallery/export'
import {DiskAssetStorage} from '../../server/storage/disk-asset-storage'
it('exports original and ordered references with portable Markdown and explicit metadata only',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-export-test-'))
 try{
 const storage=new DiskAssetStorage({imagesDir:path.join(root,'images'),referencesDir:path.join(root,'references')});await storage.ensureDirectories()
 await fs.writeFile(storage.getImagePath('main.png'),'main');await fs.writeFile(storage.getReferencePath('a.png'),'ref a');await fs.writeFile(storage.getReferencePath('b.png'),'ref b')
 const entries=await galleryExportEntries([{id:'one',filename:'main.png',prompt:'prompt ``` literal',notes:'note',sourceFile:'/private/user/path.md',referenceImages:['b.png','a.png'],tags:['tag'],favorited:false,assetType:'recipe',createdAt:'2026-09-11',width:1,height:1}],storage)
 const chunks=[];for await(const chunk of zipEntries(entries))chunks.push(chunk);const zip=Buffer.concat(chunks)
 const files=new Map<string,Buffer>();let offset=0
 while(zip.readUInt32LE(offset)===0x04034b50){const length=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28),name=zip.subarray(offset+30,offset+30+nameLength).toString(),start=offset+30+nameLength+extra;files.set(name,zip.subarray(start,start+length));offset=start+length}
 expect(files.get('001-one/assets/reference-01.png')?.toString()).toBe('ref b')
 expect(files.get('001-one/assets/reference-02.png')?.toString()).toBe('ref a')
 expect(files.get('001-one/README.md')?.toString()).toContain('![](assets/image.png)')
 const manifest=files.get('manifest.json')!.toString();expect(manifest).not.toContain('/private/');expect(JSON.parse(manifest).images[0].referenceImages).toEqual(['assets/reference-01.png','assets/reference-02.png'])
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
