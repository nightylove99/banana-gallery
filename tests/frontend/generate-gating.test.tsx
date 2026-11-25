// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const generateImageMock = vi.fn()
const saveGeneratedToGalleryMock = vi.fn()
const uploadGenerateRefsMock = vi.fn(async () => ({ filenames: [] }))
const fetchGenerationModelsMock = vi.fn(async () => ({
  defaultModel: {
    provider: 'seedream' as const,
    model: 'doubao-seedream-5-5-261028',
  },
  models: [
    {
      provider: 'google' as const,
      model: 'gemini-nano-banana-2.1',
      label: 'Google · Nano Banana 2.1',
      parameterMode: 'resolution' as const,
      available: true,
      maxReferenceImages: 14,
      supportedResolutions: ['1K', '2K', '4K'],
      supportedQualities: [],
      supportedAspectRatios: ['1:1', '16:9'],
    },
    {
      provider: 'seedream' as const,
      model: 'doubao-seedream-5-5-261028',
      label: 'Seedream · 5.5',
      parameterMode: 'resolution' as const,
      available: true,
      maxReferenceImages: 10,
      supportedResolutions: ['1K', '2K'],
      supportedQualities: [],
      supportedAspectRatios: ['1:1', '16:9'],
    },
  ],
}))

let sourceLinks = false
const historyTasks: unknown[] = []
const readReceiptMock = vi.fn()
vi.mock('@/lib/generation-tasks', async (importOriginal) => {
 const actual = await importOriginal<typeof import('../../src/lib/generation-tasks')>()
 let bulkTargets: import('../../src/types').GenerationTask[] = []
 return {...actual,
 readSubmission: (key: string, signal?: AbortSignal) => readReceiptMock(key, signal),
 readGenerationHistory: async () => ({tasks:sourceLinks?historyTasks.flatMap((value)=>{const job=value as import('../../src/types').GenerationTask;return [job,{...job,id:`child-${job.id}`,result:undefined,status:'cancelled',input:{...job.input,prompt:`后续草稿 ${job.input.prompt}`,sourceTaskId:job.id}}]}):[...historyTasks],error:null}),
 taskRequest: async (path: string, body?: Record<string,unknown>) => {
   if (!body) return {tasks:[...historyTasks],error:null}
   const [id, action] = path.slice(1).split('/')
   if (path === '/bulk/preview') {
    bulkTargets = (historyTasks as import('../../src/types').GenerationTask[]).filter(job=>!job.deletedAt && job.status==='completed')
    return {...body,token:'bulk-token',eligibleCount:bulkTargets.length,matchedCount:bulkTargets.length,skippedCount:0,retryPurgeCount:0}
   }
   if (path === '/bulk/commit') {
    for (const job of bulkTargets) job.deletedAt = new Date().toISOString()
    return {moved:bulkTargets.length,skipped:0}
   }
   if (action === 'trash' || action === 'restore') {
    let moved = 0
    for (const job of historyTasks as import('../../src/types').GenerationTask[]) {
     if (job.id !== id) continue
     job.deletedAt = action === 'restore' ? undefined : new Date().toISOString()
     moved++
    }
    return {moved, skipped:0}
   }
   const result = await generateImageMock(body)
   const job = {id:String(historyTasks.length+1),key:body.key,input:body,status:'completed',createdAt:new Date().toISOString(),result}
   historyTasks.push(job);return job
 }}
})
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api')>()
  return {
    ...actual,
    fetchImages: vi.fn(async () => []),
    fetchGenerationModels: () => fetchGenerationModelsMock(),
    uploadGenerateRefs: (...args: unknown[]) => uploadGenerateRefsMock(...args),
    generateImage: (...args: unknown[]) => generateImageMock(...args),
    saveGeneratedToGallery: (...args: unknown[]) => saveGeneratedToGalleryMock(...args),
  }
})

vi.mock('@/auth/useSession', () => ({
  useSession: () => ({
    session: {
      user: { id: 'local-user', email: 'local-user@banana.gallery' },
      workspace: { id: 'local-workspace', name: 'Local Workspace' },
    },
    loading: false,
    refresh: async () => {},
    signOut: async () => {},
  }),
}))

import { IDBObjectStore } from 'fake-indexeddb'
import GeneratePage from '../../src/pages/GeneratePage'
import { ApiConnectionError, ApiHttpError } from '../../src/api'

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(()=>{})
  historyTasks.length = 0
  sourceLinks = false
  readReceiptMock.mockReset().mockResolvedValue(null)
  window.localStorage.clear()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  generateImageMock.mockReset()
  saveGeneratedToGalleryMock.mockReset()
  uploadGenerateRefsMock.mockClear()
  fetchGenerationModelsMock.mockClear()
})

async function renderPage(withSources = false) {
  sourceLinks = withSources
  const user = userEvent.setup()
  render(
    <MemoryRouter initialEntries={['/generate']}>
      <Routes>
        <Route path="/generate" element={<GeneratePage />} />
      </Routes>
    </MemoryRouter>,
  )

  const textarea = await screen.findByPlaceholderText('描述你想生成的图片…')
  await waitFor(() => expect(textarea).toHaveProperty('readOnly', false))
  return { user, textarea }
}

describe('GeneratePage 错误横幅', () => {
  it('4K 不可用时会展示 403 标题与说明', async () => {
    generateImageMock.mockRejectedValue(
      new ApiHttpError(403, '上游拒绝了 4K 生成请求'),
    )
    const page = await renderPage()

    await page.user.type(page.textarea, 'banana prompt')
    await page.user.selectOptions(
      screen.getByLabelText('模型'),
      'google:gemini-nano-banana-2.1',
    )
    await page.user.selectOptions(screen.getByLabelText('分辨率'), '4K')
    await page.user.click(screen.getByRole('button', { name: '提交生成' }))

    expect(await screen.findByText('无法完成操作')).toBeTruthy()
    expect(screen.getByText('上游拒绝了 4K 生成请求')).toBeTruthy()
  })

  it('429 时展示频率限制标题与服务器说明', async () => {
    generateImageMock.mockRejectedValue(
      new ApiHttpError(429, '请求过于频繁，请稍后再试'),
    )
    const page = await renderPage()

    await page.user.type(page.textarea, 'x')
    await page.user.click(screen.getByRole('button', { name: '提交生成' }))

    expect(await screen.findByText('请求过于频繁')).toBeTruthy()
    expect(screen.getByText('请求过于频繁，请稍后再试')).toBeTruthy()
  })

  it('保存作品失败时会展示服务端提示', async () => {
    generateImageMock.mockResolvedValue({
      filename: 'generated.png',
      width: 1024,
      height: 1024,
      prompt: 'banana prompt',
      provider: 'seedream',
      model: 'doubao-seedream-5-5-261028',
      aspectRatio: '1:1',
      imageSize: '2K',
    })
    saveGeneratedToGalleryMock.mockRejectedValue(
      new ApiHttpError(403, '生成结果已不可访问'),
    )

    const page = await renderPage(true)
    await page.user.type(page.textarea, 'banana prompt')
    await page.user.click(screen.getByRole('button', { name: '提交生成' }))
    await page.user.click(screen.getByRole('button', {name:'任务记录'}))
    await page.user.click(await screen.findByRole('button', {name:'查看来源结果'}))
    await screen.findByRole('button', { name: '保存作品' })

    await page.user.click(screen.getByRole('button', { name: '保存作品' }))

    expect(await screen.findByText('生成结果已不可访问')).toBeTruthy()
  })

  it('保存时使用服务端返回的实际模型和参数', async () => {
    generateImageMock.mockResolvedValue({
      filename: 'generated.png',
      width: 1536,
      height: 1024,
      prompt: 'banana prompt',
      provider: 'openai-compatible',
      model: 'gpt-image-1',
      aspectRatio: '3:2',
      quality: 'high',
    })
    saveGeneratedToGalleryMock.mockResolvedValue({})

    const page = await renderPage(true)
    await page.user.type(page.textarea, 'banana prompt')
    await page.user.click(screen.getByRole('button', { name: '提交生成' }))
    await page.user.click(screen.getByRole('button', {name:'任务记录'}))
    await page.user.click(await screen.findByRole('button', {name:'查看来源结果'}))
    await page.user.click(await screen.findByRole('button', { name: '保存作品' }))

    expect(saveGeneratedToGalleryMock).toHaveBeenCalledWith(expect.objectContaining({
      generation: {
        aspectRatio: '3:2',
        provider: 'openai-compatible',
        model: 'gpt-image-1',
        quality: 'high',
      },
    }))
  })
})

it('a lost submission reply retries the original key and frozen prompt while preserving the next draft',async()=>{
 generateImageMock.mockRejectedValueOnce(new ApiHttpError(500,'lost reply')).mockResolvedValueOnce({filename:'recovered.png',width:1,height:1,prompt:'first',provider:'seedream',model:'doubao-seedream-5-5-261028',aspectRatio:'1:1',imageSize:'2K'})
 const page=await renderPage();await page.user.type(page.textarea,'first');await page.user.click(screen.getByRole('button',{name:'提交生成'}))
 const retry=await screen.findByRole('button',{name:'核对／重试原提交（保留相同标识）'})
 await page.user.clear(page.textarea);await page.user.type(page.textarea,'next draft');await page.user.click(retry)
 expect(generateImageMock).toHaveBeenCalledTimes(2)
 expect(generateImageMock.mock.calls[1][0]).toEqual(generateImageMock.mock.calls[0][0])
 expect((page.textarea as HTMLTextAreaElement).value).toBe('next draft')
})

it('automatic works need only a recipe decision when opening their result',async()=>{
 const input={prompt:'automatically filed',provider:'google',model:'gemini-nano-banana-2.1',aspectRatio:'2:3',imageSize:'2K',referenceFilenames:['a.png']}
 historyTasks.push({id:'auto-work',key:'auto-work',input,status:'completed',createdAt:'2026-10-12',workSavePending:false,workAssetId:'work-id',result:{...input,filename:'auto.png',width:1024,height:1536}})
 saveGeneratedToGalleryMock.mockResolvedValue({})
 const page=await renderPage()
 await page.user.click(screen.getByRole('button',{name:'任务记录'}))
 const drawer=within(await screen.findByRole('dialog',{name:'任务记录'}))
 expect(drawer.queryByRole('button',{name:'保存作品'})).toBeNull()
 await page.user.click(await drawer.findByRole('button',{name:'存为配方'}))
 expect(saveGeneratedToGalleryMock).toHaveBeenCalledWith(expect.objectContaining({taskId:'auto-work',assetType:'recipe'}))
})


it('does not mark result B saved when result A finishes saving after a history switch',async()=>{
  const result=(name:string)=>({filename:`${name}.png`,width:1024,height:1024,prompt:name,provider:'seedream',model:'doubao-seedream-5-5-261028',aspectRatio:'1:1',imageSize:'2K'})
  for(const name of ['A','B'])historyTasks.push({id:name,key:name,scope:{workspaceId:'local-workspace',ownerUserId:'local-user',userId:'local-user'},input:{prompt:name,provider:'seedream',model:'doubao-seedream-5-5-261028',referenceFilenames:[]},status:'completed',createdAt:'2026-11-04',updatedAt:'2026-11-04',result:result(name)})
  let finish!:(value:unknown)=>void
  saveGeneratedToGalleryMock.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValue({})
  const {user}=await renderPage(true)
  const openSource=async (id:string)=>{
    await user.click(screen.getByRole('button',{name:'任务记录'}))
    const drawer=within(await screen.findByRole('dialog',{name:'任务记录'}))
    const source=(await drawer.findAllByRole('article')).find(card=>card.dataset.taskId===`child-${id}`)!
    await user.click(within(source).getByRole('button',{name:'查看来源结果'}))
    expect(screen.queryByRole('dialog',{name:'任务记录'})).toBeNull()
  }
  await openSource('A')
  await user.click(within(screen.getByRole('region',{name:'生成结果'})).getByRole('button',{name:'存为配方',exact:true}))
  await waitFor(()=>expect(finish).toBeTypeOf('function'))
  await openSource('B')
  await act(async()=>{finish({})})
  const saveB=within(screen.getByRole('region',{name:'生成结果'})).getByRole('button',{name:'存为配方',exact:true}) as HTMLButtonElement
  expect(saveB.disabled).toBe(false)
  await user.click(saveB)
  expect(saveGeneratedToGalleryMock.mock.calls.map(([input])=>input.filename)).toEqual(['A.png','B.png'])
  await openSource('A')
  expect(within(screen.getByRole('region',{name:'生成结果'})).getByRole('button',{name:'已存为配方',exact:true})).toHaveProperty('disabled',true)
})

const historyJob = (id='history-action') => ({id,key:id,scope:{workspaceId:'local-workspace',ownerUserId:'local-user',userId:'local-user'},input:{prompt:'历史输入全文\n第二段',provider:'poe',model:'nano-banana-2',referenceFilenames:['ref-one.png','ref-two.png'],referenceNotes:['面容','姿态'],aspectRatio:'16:9',imageSize:'2K'},status:'completed',createdAt:'2026-11-04T10:00:00Z',updatedAt:'2026-11-04T10:01:00Z',result:{filename:'history.png',prompt:'历史输入全文\n第二段',width:1536,height:1024,provider:'poe',model:'gpt-image-2',aspectRatio:'3:2',quality:'high'}})
const retryableHistoryJob = (id: string) => {
 const job = historyJob(id)
 return { ...job, input: { ...job.input, provider: 'google', model: 'gemini-nano-banana-2.1' } }
}

it('另开历史草稿实际带入原参考图并滚回原输入框，不打开弹窗',async()=>{
 const job=historyJob();historyTasks.push(job)
 const {user,textarea}=await renderPage()
 const scroll=document.querySelector('main')!;scroll.scrollTop=720
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await user.click(await screen.findByRole('button',{name:'另开草稿',exact:true}))
 await waitFor(()=>expect((textarea as HTMLTextAreaElement).value).toBe(job.input.prompt))
 await waitFor(()=>expect(scroll.scrollTop).toBe(0))
 expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('google:gemini-nano-banana-2.1')
 expect(screen.queryByRole('dialog')).toBeNull()
 expect(screen.getByAltText('参考图 1').getAttribute('src')).toBe('/api/assets/references/ref-one.png')
 expect(screen.getByAltText('参考图 2').getAttribute('src')).toBe('/api/assets/references/ref-two.png')
})

it('lets a draft with intact references detach its missing history and resubmit', async () => {
 const job=historyJob()
 historyTasks.push({...job,input:{...job.input,sourceTaskId:'purged-parent'}})
 generateImageMock.mockRejectedValueOnce(new ApiHttpError(404,'来源历史不存在','SOURCE_TASK_UNAVAILABLE'))
  .mockResolvedValueOnce(job.result)
 const {user}=await renderPage()
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await user.click(await screen.findByRole('button',{name:'另开草稿',exact:true}))
 await user.click(screen.getByRole('button',{name:'提交生成'}))
 expect(generateImageMock.mock.calls[0][0].sourceTaskId).toBe('purged-parent')
 await user.click(await screen.findByRole('button',{name:'解除来源绑定并提交'}))
 const [first,second]=generateImageMock.mock.calls.map(([body])=>body)
 expect(second.key).not.toBe(first.key)
 expect(second.sourceTaskId).toBeUndefined()
 expect(second.prompt).toBe(first.prompt)
 expect(second.referenceFilenames).toEqual(job.input.referenceFilenames)
})

it('历史存为配方使用该任务快照和实际生成参数，不使用当前编辑内容',async()=>{
 const job=historyJob();historyTasks.push(job);saveGeneratedToGalleryMock.mockResolvedValue({})
 const {user,textarea}=await renderPage();await user.type(textarea,'下一份草稿')
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await user.click(await screen.findByRole('button',{name:'存为配方',exact:true}))
 expect(saveGeneratedToGalleryMock).toHaveBeenCalledWith(expect.objectContaining({taskId:job.id,filename:'history.png',prompt:job.input.prompt,referenceFilenames:['ref-one.png','ref-two.png'],assetType:'recipe',generation:expect.objectContaining({provider:'poe',model:'gpt-image-2',aspectRatio:'3:2',quality:'high'})}))
 expect((textarea as HTMLTextAreaElement).value).toBe('下一份草稿')
})

it('新提交任务成功自动使用原下载地址与文件名，旧完成历史不下载',async()=>{
 historyTasks.push(historyJob('old-history'))
 vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => url === '/api/assets/images/new.png' && init?.method === 'HEAD'
   ? new Response(null, { headers: { 'Content-Type': 'image/png' } })
   : Response.json({}, { status: 404 }))
 const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
 generateImageMock.mockResolvedValue({filename:'new.png',prompt:'new',width:1024,height:1024,provider:'seedream',model:'doubao-seedream-5-5-261028',aspectRatio:'1:1',imageSize:'2K'})
 const {user,textarea}=await renderPage()
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await screen.findByRole('article')
 await user.keyboard('{Escape}')
 expect(click).not.toHaveBeenCalled()
 await user.type(textarea,'new');await user.click(screen.getByRole('button',{name:'提交生成'}))
 await waitFor(()=>expect(click).toHaveBeenCalledOnce())
 const anchor=click.mock.instances[0] as HTMLAnchorElement
 expect(anchor.getAttribute('href')).toBe('/api/assets/images/new.png')
 expect(anchor.download).toBe('new.png')
 await user.click(screen.getByRole('button',{name:'刷新'}))
 await new Promise(resolve=>setTimeout(resolve,20))
 expect(click).toHaveBeenCalledOnce()
 click.mockRestore()
})

it('继续修改将结果作为新参考并回输入区，另开草稿仍保留原输入能力',async()=>{
 historyTasks.push(historyJob())
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input)==='/api/reference-library/assets'&&init?.method==='POST')return Response.json({asset:{id:'reference',versions:[{id:'version',filename:'result-reference.png'}],currentVersionId:'version'},duplicates:[]})
  return Response.json({}, {status:404})
 })
 const {user,textarea}=await renderPage();const scroll=document.querySelector('main')!;scroll.scrollTop=720
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await user.click(await screen.findByRole('button',{name:'继续修改',exact:true}))
 await waitFor(()=>expect((textarea as HTMLTextAreaElement).value).toBe(historyJob().input.prompt))
 await waitFor(()=>expect(scroll.scrollTop).toBe(0))
 expect(screen.getByAltText('参考图 1').getAttribute('src')).toBe('/api/assets/references/result-reference.png')
 expect(screen.queryByAltText('参考图 2')).toBeNull()
 expect(screen.queryByRole('dialog')).toBeNull()
})
it('保存当前草稿失败时保留内容和滚动位置，不切到历史草稿',async()=>{
 historyTasks.push(historyJob())
 const {user,textarea}=await renderPage();await user.type(textarea,'不能丢的新输入')
 await waitFor(()=>expect(screen.getByText('草稿已保存到此浏览器')).toBeTruthy())
 const scroll=document.querySelector('main')!;scroll.scrollTop=720
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 const write=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new Error('无法保存当前草稿')})
 try{
  await user.click(screen.getByRole('button',{name:'另开草稿',exact:true}))
  await screen.findByText('无法保存当前草稿')
  expect((textarea as HTMLTextAreaElement).value).toBe('不能丢的新输入')
  expect(scroll.scrollTop).toBe(720)
 }finally{write.mockRestore()}
})

it.each(['failed','uncertain'] as const)('%s 后从页外提示重新生成使用历史输入，不覆盖当前草稿',async(status)=>{
 const old=retryableHistoryJob('failed-old')
 historyTasks.push({...old,status,result:undefined,failure:{category:'network',message:'网络临时错误',retryable:status==='failed',uncertain:status==='uncertain'}})
 generateImageMock.mockResolvedValue({...old.result,filename:'retried.png'})
 const {user,textarea}=await renderPage();await user.clear(textarea);await user.type(textarea,'正在编辑的新内容')
 const retry=await screen.findByRole('button',{name:'重新生成',exact:true})
 expect(retry.closest('[role="status"]')).not.toBeNull()
 await user.click(retry)
 await waitFor(()=>expect(generateImageMock).toHaveBeenCalledOnce())
 expect(generateImageMock.mock.calls[0][0]).toEqual(expect.objectContaining({...old.input,key:expect.any(String)}))
 expect((textarea as HTMLTextAreaElement).value).toBe('正在编辑的新内容')
})
it('直接再试丢回执后核对同一key，不能复制出第二次生成',async()=>{
 const old=retryableHistoryJob('lost-retry');historyTasks.push({...old,status:'failed',result:undefined,failure:{category:'network',message:'断线',retryable:true,uncertain:false}})
 generateImageMock.mockRejectedValueOnce(new ApiHttpError(500,'回执丢失')).mockResolvedValueOnce(old.result)
 const {user}=await renderPage()
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await user.click(await screen.findByRole('button',{name:'重新生成',exact:true}))
 await user.click(await screen.findByRole('button',{name:'核对原提交',exact:true}))
 expect(generateImageMock.mock.calls[1][0]).toEqual(generateImageMock.mock.calls[0][0])
})
it('历史大图可以直接补下载原图，下载按钮不会关闭大图',async()=>{
 const old=historyJob();historyTasks.push(old)
 const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
 const {user}=await renderPage()
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await user.click(await screen.findByRole('button',{name:'查看大图',exact:true}))
 await user.click(within(screen.getByRole('dialog',{name:'大图预览'})).getByRole('button',{name:'下载原图'}))
 expect(click).toHaveBeenCalledOnce();expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe(old.result.filename)
 expect(screen.getByRole('dialog',{name:'大图预览'})).toBeTruthy()
})
it('继续修改取参考图期间另开了其它草稿，迟到响应不覆盖新草稿',async()=>{
 const a=historyJob('A'),b={...historyJob('B'),input:{...historyJob('B').input,prompt:'B输入'}};historyTasks.push(a,b)
 let finish!:(value:Response)=>void
 vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>String(input)==='/api/reference-library/assets'?await new Promise<Response>(resolve=>{finish=resolve}):Response.json({}, {status:404}))
 const {user,textarea}=await renderPage()
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 const findCard=async (id:string)=> (await screen.findAllByRole('article')).find(card=>card.dataset.taskId===id)!
 await user.click(within(await findCard(a.id)).getByRole('button',{name:'继续修改'}))
 await waitFor(()=>expect(finish).toBeTypeOf('function'))
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await user.click(within(await findCard(b.id)).getByRole('button',{name:'另开草稿'}))
 await waitFor(()=>expect((textarea as HTMLTextAreaElement).value).toBe('B输入'))
 await act(async()=>{finish(Response.json({asset:{id:'ref',versions:[{id:'v',filename:'late.png'}],currentVersionId:'v'}}))})
 expect((textarea as HTMLTextAreaElement).value).toBe('B输入')
})
it('同一失败记录提交成功后显示已重新提交，避免快速连点再生成一份',async()=>{
 const old=retryableHistoryJob('one-retry-only');historyTasks.push({...old,status:'failed',result:undefined,failure:{category:'network',message:'断线',retryable:true,uncertain:false}})
 generateImageMock.mockResolvedValue(old.result)
 const {user}=await renderPage()
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await user.click(await screen.findByRole('button',{name:'重新生成',exact:true}))
 const done=await screen.findByRole('button',{name:'已重新提交',exact:true})
 expect(done).toHaveProperty('disabled',true)
 await user.click(done);expect(generateImageMock).toHaveBeenCalledOnce()
 expect(generateImageMock.mock.calls[0][0].key).toBe('history-retry-one-retry-only')
})

it('最近作品接近底部时续载下一批', async () => {
 const jobs = Array.from({length: 31}, (_, index) => {
  const job = historyJob(String(index))
  return {...job, result: {...job.result, filename: `recent-${index}.png`}}
 })
 historyTasks.push(...jobs)
 const images = jobs.map(job => ({
  id: job.id, assetType: 'work' as const, filename: job.result.filename,
  createdAt: job.createdAt, prompt: job.input.prompt, tags: [], favorited: false, referenceImages: [],
 }))
 const { GalleryStore } = await import('../../src/lib/gallery-store')
 const reload = vi.spyOn(GalleryStore.prototype, 'reload').mockImplementation(async function (this: InstanceType<typeof GalleryStore>) {
  images.forEach(image => this.add(image))
 })
 let enterViewport: (() => void) | undefined
 vi.stubGlobal('IntersectionObserver', class {
  constructor(callback: IntersectionObserverCallback) {
   enterViewport = () => callback([{isIntersecting:true} as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
  observe() {}
  disconnect() {}
 })
 await renderPage()
 const gallery = within(screen.getByRole('region', {name:'生成记录'}))
 await waitFor(() => expect(gallery.getAllByRole('button', {name:'打开作品大图'})).toHaveLength(30))
 expect(reload).toHaveBeenCalled()
 await act(async () => enterViewport?.())
 expect(gallery.getAllByRole('button', {name:'打开作品大图'})).toHaveLength(31)
 expect(gallery.getByText('已显示全部生成作品')).toBeTruthy()
})

it.each(['单条', '批量'])('%s回收隐藏作品卡片，刷新后仍隐藏，恢复后按原顺序显示', async mode => {
 const jobs = [historyJob('first'), historyJob('second')].map((job, index) => ({
  ...job, createdAt: `2026-11-0${index + 4}T10:00:00Z`,
  result: {...job.result, filename: `${job.id}.png`},
 }))
 historyTasks.push(...jobs)
 const { GalleryStore } = await import('../../src/lib/gallery-store')
 vi.spyOn(GalleryStore.prototype, 'reload').mockImplementation(async function (this: InstanceType<typeof GalleryStore>) {
  jobs.forEach(job => this.add({
   id:job.id, workCode:`#${job.id}`, assetType:'work', filename:job.result.filename,
   createdAt:job.createdAt, prompt:job.input.prompt, tags:[], favorited:false, referenceImages:[],
  }))
 })
 const first = {name:'打开作品 #first'}
 const second = {name:'打开作品 #second'}
 const {user} = await renderPage()
 await screen.findByRole('button', second)
 if (mode === '单条') {
  await user.click(screen.getByRole('button', first))
  await user.click(within(await screen.findByRole('dialog', {name:'大图预览'})).getByRole('button', {name:'详情'}))
  const historyDetail = within(await screen.findByRole('dialog'))
  expect(historyDetail.getByRole('button', {name:'另开草稿'})).toBeTruthy()
  expect(historyDetail.queryByRole('button', {name:'转入生成'})).toBeNull()
  const params = historyDetail.getByRole('region', {name:'生成参数与来源'})
  expect(within(params).getByText('生成来源：')).toBeTruthy()
  expect(params.compareDocumentPosition(historyDetail.getByRole('heading', {name:'提示词'})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(within(params).getByText('1536 × 1024')).toBeTruthy()
  await user.click(historyDetail.getByRole('button', {name:'移入历史回收站'}))
  await user.click(historyDetail.getByRole('button', {name:'移入回收站', exact:true}))
 } else {
  await user.click(screen.getByRole('button', {name:'任务记录'}))
  await user.click(await screen.findByRole('button', {name:'移入历史回收站：已结束任务 2 条'}))
  await user.click(await screen.findByRole('button', {name:'移入历史回收站（2 条）'}))
  await user.click(screen.getByRole('button', {name:'关闭任务记录'}))
 }
 await waitFor(() => expect(screen.queryByRole('button', first)).toBeNull())
 expect(screen.queryByRole('button', second) !== null).toBe(mode === '单条')
 expect(saveGeneratedToGalleryMock).not.toHaveBeenCalled()

 cleanup()
 const {user: reloadedUser} = await renderPage()
 await reloadedUser.click(screen.getByRole('button', {name:'任务记录'}))
 await reloadedUser.click(screen.getByRole('tab', {name:/^历史回收站 ·/}))
 const restored = await screen.findAllByRole('button', {name:'恢复', exact:true})
 expect(document.querySelector('button[aria-label="打开作品 #first"]')).toBeNull()
 expect(restored).toHaveLength(mode === '单条' ? 1 : 2)
 while (screen.queryAllByRole('button', {name:'恢复', exact:true}).length) {
  const before = screen.getAllByRole('button', {name:'恢复', exact:true})
  await reloadedUser.click(before[0])
  await waitFor(() => expect(screen.queryAllByRole('button', {name:'恢复', exact:true})).toHaveLength(before.length - 1))
 }
 await reloadedUser.click(screen.getByRole('button', {name:'关闭任务记录'}))
 expect(screen.getAllByRole('button', {name:/打开作品 #/}).map(button => button.getAttribute('aria-label')))
  .toEqual(['打开作品 #second', '打开作品 #first'])
})

it('历史收到新入库作品 ID 后单独读取作品，早于图库刷新', async () => {
 const job = historyJob('just-generated')
 historyTasks.push({...job, status:'running', result:undefined})
 const fetch = vi.fn(async (input: RequestInfo | URL) => {
  if (String(input) === '/api/images/new-work') return Response.json({
   id:'new-work', workCode:'#NEWWORK001', assetType:'work', filename:job.result.filename,
   createdAt:job.createdAt, prompt:job.input.prompt, tags:[], favorited:false, referenceImages:[],
  })
  return Response.json({}, {status:404})
 })
 vi.stubGlobal('fetch', fetch)
 const {user} = await renderPage()
 await screen.findByText(/执行中|准备请求|生成中/)
 historyTasks.splice(0, 1, {...job, workAssetId:'new-work'})
 await user.click(screen.getByRole('button', {name:'刷新',exact:true}))
 const recent = within(screen.getByRole('region', {name:'生成记录'}))
 expect(await recent.findByRole('button', {name:'打开作品 #NEWWORK001'})).toBeTruthy()
 await user.click(screen.getByRole('button', {name:'刷新',exact:true}))
 expect(recent.getAllByRole('button', {name:'打开作品 #NEWWORK001'})).toHaveLength(1)
 expect(fetch.mock.calls.filter(([url]) => url === '/api/images/new-work')).toHaveLength(1)
})

it('抽屉参考图打开原图并可下载，Escape 只关闭大图预览', async () => {
 historyTasks.push(historyJob())
 const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
 const {user}=await renderPage()
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 const history=within(await screen.findByRole('dialog',{name:'任务记录'}))
 await user.click(await history.findByRole('button',{name:'查看参考图 1'}))
 const lightbox=within(await screen.findByRole('dialog',{name:'大图预览'}))
 expect(lightbox.getByRole('img',{name:'参考图 1'}).getAttribute('src')).toBe('/api/assets/references/ref-one.png')
 await user.click(lightbox.getByRole('button',{name:'下载原图'}))
 const anchor=click.mock.instances[0] as HTMLAnchorElement
 expect(anchor.getAttribute('href')).toBe('/api/assets/references/ref-one.png')
 expect(anchor.download).toBe('ref-one.png')
 await user.keyboard('{Escape}')
 expect(screen.queryByRole('dialog',{name:'大图预览'})).toBeNull()
 expect(screen.getByRole('dialog',{name:'任务记录'})).toBeTruthy()
})


it('clears only the acknowledged tab receipt and reads the legacy slot', async () => {
  const { clearSubmission, persistSubmission, readPendingSubmissions } = await import('../../src/lib/generation-tasks')
  const scope = 'two-tabs'
  const legacy = { key: 'legacy', input: { prompt: 'legacy', provider: 'google' as const, model: 'test', aspectRatio: '1:1', referenceFilenames: [] } }
  localStorage.setItem(`banana-pending-generation:v1:${scope}`, JSON.stringify(legacy))
  expect(readPendingSubmissions(scope)).toContainEqual(legacy)
  const tabA = { ...legacy, key: 'tab-a' }
  const tabB = { ...legacy, key: 'tab-b' }
  persistSubmission(scope, tabA)
  persistSubmission(scope, tabB)
  clearSubmission(scope, tabA.key)
  expect(readPendingSubmissions(scope)).toEqual([legacy, tabB])
  clearSubmission(scope, legacy.key)
  expect(readPendingSubmissions(scope)).toEqual([tabB])
})

it('re-uploads a local reference after a definitive rejection, then retries an unknown reply unchanged', async () => {
  uploadGenerateRefsMock.mockResolvedValueOnce({ filenames: ['expired.png'] }).mockResolvedValueOnce({ filenames: ['fresh.png'] })
  generateImageMock
    .mockRejectedValueOnce(new ApiHttpError(404, '参考图已过期', 'REFERENCE_UNAVAILABLE'))
    .mockRejectedValueOnce(new ApiConnectionError('没有收到回执'))
    .mockResolvedValueOnce(undefined)
  const { user, textarea } = await renderPage()
  await user.type(textarea, 'retry local reference')
  const file = new File(['reference'], 'source.png', { type: 'image/png' })
  await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, file)
  await user.click(screen.getByRole('button', { name: '提交生成', exact: true }))
  await user.click(await screen.findByRole('button', { name: '核对／重试原提交（保留相同标识）' }))
  await waitFor(() => expect(generateImageMock).toHaveBeenCalledTimes(3))
  expect(uploadGenerateRefsMock.mock.calls).toEqual([
    [[file], expect.objectContaining({ uploadKey: expect.any(String) })],
    [[file], expect.objectContaining({ uploadKey: expect.stringContaining(':expired.png') })],
  ])
  const [original, repaired, retry] = generateImageMock.mock.calls.map(([input]) => input)
  expect(original.referenceFilenames).toEqual(['expired.png'])
  expect(repaired.referenceFilenames).toEqual(['fresh.png'])
  expect(repaired.key).toBe(original.key)
  expect(retry).toEqual(repaired)
})

it.each([408, 409])('claims an authoritative receipt and unlocks submission after status %i', async status => {
  generateImageMock.mockImplementationOnce(async ({ key }) => {
    readReceiptMock.mockResolvedValue({ id: 'accepted', key })
    throw new ApiHttpError(status, '未收到回执', status === 409 ? 'TASK_KEY_CONFLICT' : undefined)
  })
  const { user, textarea } = await renderPage()
  await user.type(textarea, '请只接单一次')
  const submit = screen.getByRole('button', { name: '提交生成', exact: true })
  await user.click(submit)
  await waitFor(() => expect(readReceiptMock).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByRole('button', { name: '提交生成', exact: true })).toHaveProperty('disabled', false))
  expect(generateImageMock).toHaveBeenCalledOnce()
  expect(screen.queryByText(/上一次提交回执尚未确认/)).toBeNull()
})

it('shows the completed work even if reading the saved gallery entry fails, with retry for the original', async () => {
  historyTasks.push({ ...historyJob('missing-from-gallery'), workAssetId: 'not-loaded-yet' })
  const { user } = await renderPage()
  await user.click(await screen.findByRole('button', { name: '打开作品大图' }))
  const preview = within(screen.getByRole('dialog', { name: '大图预览' }))
  fireEvent.error(preview.getByRole('img', { name: '生成作品' }))
  await user.click(preview.getByRole('button', { name: '重新加载图片' }))
  expect(preview.getByRole('img', { name: '生成作品' }).getAttribute('src')).toMatch(/history\.png\?retry=/)

})

it('claims a pending key from polling while its by-key request is still hanging', async () => {
  const lost = historyJob('polled-receipt')
  // Honor cancellation like the browser when history finds the receipt first.
  readReceiptMock.mockImplementation((_key, signal?: AbortSignal) => new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  generateImageMock.mockImplementationOnce(async ({ key }) => {
    historyTasks.push({ ...lost, key })
    throw new ApiConnectionError('网络连接失败')
  })
  const { user, textarea } = await renderPage()
  await user.type(textarea, '从历史认领')
  await user.click(screen.getByRole('button', { name: '提交生成', exact: true }))
  await waitFor(() => expect(readReceiptMock).toHaveBeenCalledOnce())
  await user.click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '提交生成', exact: true })).toHaveProperty('disabled', false))
  expect(generateImageMock).toHaveBeenCalledOnce()
})

it('persists each upload and resumes from the failed file after reopening the editor', async () => {
  const { File: NativeFile } = await import('node:buffer')
  vi.stubGlobal('File', NativeFile)
  const { loadGenerationDraft, readDraftCatalog } = await import('../../src/lib/generation-drafts')
  const scope = JSON.stringify(['local-user', 'local-workspace'])
  uploadGenerateRefsMock.mockReset()
    .mockResolvedValueOnce({ filenames: ['one.png'] })
    .mockResolvedValueOnce({ filenames: ['two.png'] })
    .mockRejectedValueOnce(new ApiConnectionError('网络连接失败'))
    .mockResolvedValueOnce({ filenames: ['three.png'] })
    .mockResolvedValueOnce({ filenames: ['four.png'] })
  generateImageMock.mockResolvedValueOnce(undefined)

  const first = await renderPage()
  await first.user.type(first.textarea, '必须断点续传')
  const files = ['a', 'b', 'c', 'd'].map(name => new NativeFile(['file'], `${name}.png`, { type: 'image/png' }))
  await first.user.upload(document.querySelector('input[type=file]') as HTMLInputElement, files as File[])
  await first.user.click(screen.getByRole('button', { name: '提交生成', exact: true }))
  await screen.findByText('网络连接失败')
  expect(generateImageMock).not.toHaveBeenCalled()
  const catalog = await readDraftCatalog(scope)
  const draft = await loadGenerationDraft(scope, catalog.activeId)
  expect(draft?.refs.map(ref => [ref.file?.name, ref.serverFilename])).toEqual([
    ['a.png', 'one.png'], ['b.png', 'two.png'], ['c.png', undefined], ['d.png', undefined],
  ])
  cleanup()
  const reopened = await renderPage()
  expect((reopened.textarea as HTMLTextAreaElement).value).toBe('必须断点续传')
  await reopened.user.click(screen.getByRole('button', { name: '提交生成', exact: true }))
  await waitFor(() => expect(generateImageMock).toHaveBeenCalledOnce())
  const uploads = uploadGenerateRefsMock.mock.calls as unknown as [File[], { uploadKey: string }][]
  expect(uploads.map(([files]) => files.map(file => file.name))).toEqual([['a.png'], ['b.png'], ['c.png'], ['c.png'], ['d.png']])
  expect(uploads[2][1].uploadKey).toBe(uploads[3][1].uploadKey)
  expect(generateImageMock).toHaveBeenCalledWith(expect.objectContaining({ referenceFilenames: ['one.png', 'two.png', 'three.png', 'four.png'] }))
})

it('does not advertise a model as available until its real status has loaded', async () => {
  fetchGenerationModelsMock.mockRejectedValueOnce(new Error('offline'))
  const { user, textarea } = await renderPage()
  await user.type(textarea, '模型尚不可用')
  const retry = await screen.findByRole('button', { name: '模型状态获取失败，点击重试' })
  expect(screen.getByRole('button', { name: '提交生成', exact: true })).toHaveProperty('disabled', true)
  await user.click(retry)
  await waitFor(() => expect(screen.getByRole('button', { name: '提交生成', exact: true })).toHaveProperty('disabled', false))
})

it('rejects an oversized reference at selection before uploading', async () => {
  const { toast } = await import('sonner')
  const { user } = await renderPage()
  const file = new File(['jpeg'], 'large.jpg', { type: 'image/jpeg' })
  Object.defineProperty(file, 'size', { value: 25 * 1024 * 1024 + 1 })
  await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, file)
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('JPG / WebP 最多 25 MiB'))
  expect(screen.queryByAltText('参考图 1')).toBeNull()
  expect(uploadGenerateRefsMock).not.toHaveBeenCalled()
})
