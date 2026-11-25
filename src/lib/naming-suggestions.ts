import {assetTitle} from './gallery-query'
import type {GalleryImage} from '@/types'
export function localNamingSuggestion(image:Pick<GalleryImage,'prompt'|'tags'> & Partial<Pick<GalleryImage,'title'|'generation'>>){
 const existing=assetTitle(image as GalleryImage).trim()
 const first=image.prompt.normalize('NFC').split(/[\r\n。！？!?]/).map(line=>line.replace(/^[\s#*>\-\d.]+/,'').trim()).find(Boolean)||''
 const title=existing||Array.from(first).slice(0,28).join('')
 const tags=new Set<string>()
 for(const match of image.prompt.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,20})/gu))tags.add(match[1])
 for(const [label,pattern] of [['人像',/人像|portrait/i],['风景',/风景|landscape/i],['摄影',/摄影|photograph/i],['动漫',/动漫|anime/i],['写实',/写实|realistic/i],['水彩',/水彩|watercolou?r/i],['赛博朋克',/赛博朋克|cyberpunk/i],['角色',/角色|character/i],['室内',/室内|interior/i],['建筑',/建筑|architecture/i]] as const)if(pattern.test(image.prompt))tags.add(label)
 return {title,tags:[...tags].slice(0,8),existingTitle:!!existing}
}
