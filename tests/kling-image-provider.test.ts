import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KlingImageGenerationProvider,
  resolveKlingResolution,
} from '../server/ai/kling-image-provider.ts'

test('Kling V3 Omni 提交异步任务、轮询并下载单图', async () => {
  const calls: string[] = []
  let polls = 0
  const provider = new KlingImageGenerationProvider({
    apiKey: 'test-dashscope-key',
    sleep: async () => {},
    pollIntervalMs: 0,
    fetch: async (input, init) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/image-generation/generation')) {
        const body = JSON.parse(String(init?.body))
        assert.equal(init?.headers && (init.headers as Record<string, string>)['X-DashScope-Async'], 'enable')
        assert.equal(body.model, 'kling/kling-v3-omni-image-generation')
        assert.deepEqual(body.parameters, {
          n: 1,
          result_type: 'single',
          aspect_ratio: '1:1',
          resolution: '4k',
          watermark: false,
        })
        return new Response(JSON.stringify({
          output: { task_status: 'PENDING', task_id: 'task-1' },
        }), { status: 200 })
      }
      if (url.endsWith('/tasks/task-1')) {
        polls += 1
        return new Response(JSON.stringify({
          output: polls === 1
            ? { task_status: 'RUNNING' }
            : {
                task_status: 'SUCCEEDED',
                choices: [{
                  message: {
                    content: [{ type: 'image', image: 'https://result.oss-cn-beijing.aliyuncs.com/kling.png' }],
                  },
                }],
              },
        }), { status: 200 })
      }
      return new Response(Buffer.from([7, 8, 9]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    },
  })

  const result = await provider.generateImage({
    prompt: '电影感场景',
    referenceImages: [],
    aspectRatio: '1:1',
    imageSize: '4K',
  })

  assert.equal(polls, 2)
  assert.ok(calls.some((url) => url.endsWith('/tasks/task-1')))
  assert.deepEqual(result.buffer, Buffer.from([7, 8, 9]))
})

test('Kling 参考图先上传临时 OSS，再以 oss URL 创建任务', async () => {
  let submitHeaders: HeadersInit | undefined
  let submitBody: {
    input: {
      messages: Array<{
        content: Array<{ image?: string }>
      }>
    }
  } | undefined
  const provider = new KlingImageGenerationProvider({
    apiKey: 'test-key',
    sleep: async () => {},
    pollIntervalMs: 0,
    fetch: async (input, init) => {
      const url = String(input)
      if (url.includes('/uploads?')) {
        return new Response(JSON.stringify({
          data: {
            upload_host: 'https://upload.example.com',
            upload_dir: 'dashscope-instant/test',
            oss_access_key_id: 'access-id',
            policy: 'policy',
            signature: 'signature',
            x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true',
          },
        }), { status: 200 })
      }
      if (url === 'https://upload.example.com') {
        assert.ok(init?.body instanceof FormData)
        return new Response('', { status: 200 })
      }
      if (url.includes('/image-generation/generation')) {
        submitHeaders = init?.headers
        submitBody = JSON.parse(String(init?.body)) as typeof submitBody
        return new Response(JSON.stringify({
          output: { task_status: 'PENDING', task_id: 'task-ref' },
        }), { status: 200 })
      }
      if (url.endsWith('/tasks/task-ref')) {
        return new Response(JSON.stringify({
          output: {
            task_status: 'SUCCEEDED',
            choices: [{
              message: {
                content: [{ image: 'https://result.oss-cn-beijing.aliyuncs.com/result.png' }],
              },
            }],
          },
        }), { status: 200 })
      }
      return new Response(Buffer.from([1]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    },
  })

  await provider.generateImage({
    prompt: '保留人物',
    referenceImages: [{
      mimeType: 'image/jpeg',
      data: Buffer.from([1, 2]),
    }],
    aspectRatio: '16:9',
    imageSize: '2K',
  })

  assert.equal(
    (submitHeaders as Record<string, string>)['X-DashScope-OssResourceResolve'],
    'enable',
  )
  assert.match(
    submitBody?.input.messages[0].content[1].image,
    /^oss:\/\/dashscope-instant\/test\//,
  )
})

test('Kling 仅接受官方三种比例与 1K/2K/4K', async () => {
  assert.equal(resolveKlingResolution('4K'), '4k')
  assert.throws(() => resolveKlingResolution('8K'), /仅支持 1K、2K 或 4K/)
})

test('Kling 轮询返回顶层失败码时立即终止', async () => {
  let polls = 0
  const provider = new KlingImageGenerationProvider({
    apiKey: 'test-key',
    sleep: async () => {},
    pollIntervalMs: 0,
    fetch: async (input) => {
      const url = String(input)
      if (url.includes('/image-generation/generation')) {
        return new Response(JSON.stringify({
          output: { task_status: 'PENDING', task_id: 'failed-task' },
        }), { status: 200 })
      }
      polls += 1
      return new Response(JSON.stringify({
        request_id: 'request-1',
        code: 'InvalidParameter',
        message: 'invalid prompt',
      }), { status: 200 })
    },
  })

  await assert.rejects(
    provider.generateImage({
      prompt: 'test',
      referenceImages: [],
      aspectRatio: '1:1',
      imageSize: '1K',
    }),
    /DASHSCOPE_KLING_REQUEST_FAILED:200:InvalidParameter/,
  )
  assert.equal(polls, 1)
})

test('Kling 恢复已有 task ID 只查询原任务，不重新上传或提交',async()=>{
 const calls:string[]=[]
 const provider=new KlingImageGenerationProvider({apiKey:'test',fetch:async(input,init)=>{
  assert.notEqual(init?.method,'POST');const url=String(input);calls.push(url)
  if(url.endsWith('/tasks/original'))return Response.json({output:{task_status:'SUCCEEDED',choices:[{message:{content:[{image:'https://result.oss-cn-beijing.aliyuncs.com/resume.png'}]}}]}})
  return new Response(Buffer.from('image'),{headers:{'content-type':'image/png'}})
 }})
 await provider.generateImage({resumeTaskId:'original',prompt:'unused',referenceImages:[],aspectRatio:'1:1'})
 assert.equal(calls.length,2);assert.ok(calls[0].endsWith('/tasks/original'))
})
