import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import request from 'supertest'
import { expect, vi } from 'vitest'
import type { GenerationTask } from '../../src/types'

export function submitGeneration(app: Express, input: Record<string, unknown>, cookie = '') {
  return request(app).post('/api/generation-tasks').set('Cookie', cookie).send({
    key: randomUUID(), provider: 'google', model: 'gemini-nano-banana-2.1', ...input,
  })
}

export async function waitForGeneration(app: Express, id: string, cookie = '') {
  return vi.waitFor(async () => {
    const response = await request(app).get('/api/generation-tasks').set('Cookie', cookie).expect(200)
    const job = (response.body.tasks as GenerationTask[]).find(task => task.id === id)
    expect(job).toBeDefined()
    expect(['completed', 'failed']).toContain(job!.status)
    return job!
  })
}
