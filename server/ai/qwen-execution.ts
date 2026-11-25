import { randomInt } from 'node:crypto'
import type { GenerationExecution } from '../../src/types.ts'
export function createQwenExecution(workflowVersion: GenerationExecution['workflowVersion'] = 'qwen21-v2'): GenerationExecution {
  return { engine: 'comfyui', workflowVersion, seed: randomInt(0, 2 ** 48 - 1), steps: 25, cfg: 1, sampler: 'euler', scheduler: 'simple' }
}
export function createKreaExecution(): GenerationExecution {
  return { engine: 'comfyui', workflowVersion: 'krea2-turbo-v1', seed: randomInt(0, 2 ** 48 - 1), steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' }
}

