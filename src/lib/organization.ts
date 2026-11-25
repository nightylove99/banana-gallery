import type {GalleryImage,ResultGroup,GalleryAssetType} from '../types'
export type BatchAction={type:'addTags'|'removeTags';tags:string[]}|{type:'favorite';value:boolean}|{type:'assetType';value:'work'|'recipe'}|{type:'trash'}
export interface BatchResult { id:string;ok:boolean;image?:GalleryImage;error?:string }
async function call<T>(url:string,method='GET',body?:unknown):Promise<T>{const response=await fetch('/api'+url,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw new Error(data.error||'操作失败');return data}
export const fetchGroups=()=>call<ResultGroup[]>('/groups')
export const createGroup=(name:string,imageIds:string[],assetType:GalleryAssetType)=>call<ResultGroup>('/groups','POST',{name,imageIds,assetType})
export const updateGroup=(group:ResultGroup,updates:Partial<Omit<ResultGroup,'coverId'|'bestId'>> & {coverId?:string|null;bestId?:string|null})=>call<ResultGroup>(`/groups/${group.id}`,'PATCH',{...updates,expectedVersion:group.version})
export const dissolveGroup=(group:ResultGroup)=>call(`/groups/${group.id}`,'DELETE',{expectedVersion:group.version})
export const batchUpdate=(targets:Array<{id:string;version:number}>,action:BatchAction)=>call<{results:BatchResult[]}>('/organization/batch','POST',{targets,action})

export async function exportImages(imageIds:string[]) {
 const response=await fetch('/api/organization/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageIds})})
 if(!response.ok){const error=await response.json();throw new Error(error.error||'导出失败')}
 const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='banana-gallery-export.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60_000)
}
