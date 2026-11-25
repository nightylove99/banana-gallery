import type {ReferenceAsset,ReferenceCombination,ReferenceCombinationItem} from '@/types'
import {requestApiJson} from '@/api'
export interface ReferenceLibrary {assets:ReferenceAsset[];combinations:ReferenceCombination[]}
export interface ChosenReference {filename:string;note:string}
export function libraryRequest<T>(url = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
 return requestApiJson<T>(`/api/reference-library${url}`, '素材操作失败', {
  method, signal,
  ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
 })
}
export const createReferenceAsset=(kind:'images'|'references',filename:string,name:string)=>libraryRequest<{asset:ReferenceAsset;duplicates:string[];reusedFile:boolean}>('/assets','POST',{kind,filename,name})
export function resolveCombination(items:ReferenceCombinationItem[],assets:ReferenceAsset[]):ChosenReference[]{
 return items.map(item=>{const version=assets.find(asset=>asset.id===item.assetId)?.versions.find(version=>version.id===item.versionId);if(!version)throw new Error('组合中有不可用的素材版本，请刷新后检查');return {filename:version.filename,note:item.note}})
}
