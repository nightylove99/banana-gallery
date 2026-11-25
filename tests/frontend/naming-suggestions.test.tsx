// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest'
import {cleanup,render,screen,waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {NamingSuggestionsModal} from '../../src/components/NamingSuggestionsModal'
import type {GalleryImage} from '../../src/types'
const image:GalleryImage={id:'a',filename:'a.png',prompt:'人像摄影，黄昏街头',referenceImages:[],tags:['gemini-web'],favorited:false,createdAt:'2026-09-11',assetType:'recipe',width:1,height:1,version:0}
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('previews, applies, and undoes only its own revision while keeping manual titles',async()=>{
 let current={...image};const requests:Array<Record<string,unknown>>=[]
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));requests.push(body);if(body.expectedVersion!==current.version)return Response.json({error:'条目已修改'},{status:409});current={...current,...body,version:(current.version||0)+1};return Response.json(current)}))
 const user=userEvent.setup(),changed=vi.fn();render(<NamingSuggestionsModal images={[image]} onChanged={changed} onClose={()=>{}}/>)
 expect(requests).toHaveLength(0);await user.click(screen.getByRole('button',{name:'应用勾选建议'}));await waitFor(()=>expect(changed).toHaveBeenCalledTimes(1))
 expect(current.title).toBe('人像摄影，黄昏街头');expect(current.tags).toContain('人像')
 await user.click(screen.getByRole('button',{name:'撤销本次已应用 1 项'}));await waitFor(()=>expect(changed).toHaveBeenCalledTimes(2));expect(current.title).toBe('');expect(current.tags).toEqual(['gemini-web'])
})
it('never overwrites a legacy handwritten title, and a later edit prevents undo',async()=>{
 const manual={...image,generation:{aspectRatio:'1:1',title:'手写标题'}};let version=0
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));if(body.expectedVersion!==version)return Response.json({error:'后来已修改'},{status:409});expect(body.title).toBeUndefined();version++;return Response.json({...manual,...body,version})}))
 const user=userEvent.setup();render(<NamingSuggestionsModal images={[manual]} onChanged={()=>{}} onClose={()=>{}}/>)
 expect((screen.getByLabelText('建议标题 1') as HTMLInputElement).disabled).toBe(true)
 await user.click(screen.getByRole('button',{name:'应用勾选建议'}));await screen.findByText('已应用');expect((screen.getByLabelText('建议标题 1') as HTMLInputElement).disabled).toBe(true);version++
 await user.click(screen.getByRole('button',{name:'撤销本次已应用 1 项'}));expect(await screen.findByText('未撤销：后来已修改')).toBeTruthy()
})
