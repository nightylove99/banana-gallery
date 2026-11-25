import { expect, it } from 'vitest'
import { createGalleryPage, GalleryPaginationCache } from '../../server/gallery/pagination'
import type { GalleryImage } from '../../src/types'
const images: GalleryImage[] = Array.from({length: 125}, (_,i)=>({id:String(i).padStart(3,'0'),filename:'a.png',prompt:`prompt ${i}`,referenceImages:[],tags:[i%2?'odd':'even'],favorited:i%2===0,assetType:'recipe',createdAt:'2026-09-11',width:1,height:1}))
it('pages stable IDs with global filtered counts, and rejects changed snapshots',()=>{
 const first=createGalleryPage(images,new URLSearchParams('limit=60'))
 expect(first.items).toHaveLength(60); expect(first.total).toBe(125);expect(first.stats.tags.even).toBe(63)
 const second=createGalleryPage(images,new URLSearchParams({limit:'60',cursor:first.nextCursor!}))
 expect(new Set([...first.items,...second.items].map(i=>i.id)).size).toBe(120)
 expect(()=>createGalleryPage(images.slice(1),new URLSearchParams({limit:'60',cursor:first.nextCursor!}))).toThrow('图库已变化')
 expect(()=>createGalleryPage(images,new URLSearchParams('limit=0'))).toThrow()
 expect(()=>createGalleryPage(images,new URLSearchParams({limit:'60',tag:'odd',cursor:first.nextCursor!}))).toThrow()
})

it('paginates true chronological order without pins and binds that option to the revision', () => {
 const pinned = {...images[0], id:'pinned', pinned:true, createdAt:'2025-01-01'}
 const rows = [pinned, ...images.slice(1,3)]
 const first = createGalleryPage(rows, new URLSearchParams('limit=1&pinFirst=0'))
 expect(first.items.map(i=>i.id)).toEqual(['001'])
 const second = createGalleryPage(rows, new URLSearchParams({limit:'1',pinFirst:'0',cursor:first.nextCursor!}))
 expect(second.items.map(i=>i.id)).toEqual(['002'])
 expect(createGalleryPage(rows, new URLSearchParams('limit=1')).items[0].id).toBe('pinned')
 expect(()=>createGalleryPage(rows, new URLSearchParams({cursor:first.nextCursor!}))).toThrow('图库已变化')
})

it('reuses a prepared query across pages and invalidates it for a new snapshot', () => {
 const cache = new GalleryPaginationCache()
 let reads = 0
 const rows = () => { reads++; return images }
 const first = cache.page('snapshot-a', 'local', rows, new URLSearchParams('limit=2&tag=odd'))
 const next = cache.page('snapshot-a', 'local', rows, new URLSearchParams({ limit: '3', tag: 'odd', cursor: first.nextCursor! }))
 expect(next.stats).toBe(first.stats)
 expect(next.items).toHaveLength(3)
 expect(reads).toBe(1)
 const changed = cache.page('snapshot-b', 'local', () => [images[0]], new URLSearchParams('limit=2&tag=odd'))
 expect(changed.total).toBe(0)
})
