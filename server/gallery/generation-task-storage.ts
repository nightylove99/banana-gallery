import fs from 'node:fs'
import path from 'node:path'
import type { ReadOnlyGalleryResources } from './gallery-repository.js'
import { resourceFiles } from './resource-files.js'

export const generationTasksFilename = 'generation-tasks.json'

export function generationTasksFileFor(dataFile: string): string {
  return path.basename(dataFile) === 'gallery-data.json'
    ? path.join(path.dirname(dataFile), generationTasksFilename)
    : `${dataFile}.tasks.json`
}

export function splitGenerationResources<T extends ReadOnlyGalleryResources>(
  { generationTasks, generationProviderStates, ...gallery }: T,
) {
  return {
    gallery,
    tasks: {
      ...(generationTasks === undefined ? {} : { generationTasks }),
      ...(generationProviderStates === undefined ? {} : { generationProviderStates }),
    },
  }
}

export function readGenerationTaskIndex(dataFile: string): Buffer | undefined {
  const file = generationTasksFileFor(dataFile)
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (!stat.isFile()) throw new Error('任务索引必须是普通文件')
  return fs.readFileSync(file)
}

export function parseGenerationTaskIndex(raw: string | Buffer) {
  const parsed: unknown = JSON.parse(raw.toString())
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('任务索引损坏')
  const { gallery, tasks } = splitGenerationResources(parsed as ReadOnlyGalleryResources)
  const { generationTasks, generationProviderStates } = tasks
  if (Object.keys(gallery).length ||
      (generationTasks !== undefined && (!Array.isArray(generationTasks) || generationTasks.some(task =>
        !task || !Array.isArray(task.input?.referenceFilenames) ||
        task.input.referenceFilenames.some((filename: unknown) => typeof filename !== 'string') ||
        (task.result != null && typeof task.result.filename !== 'string')))) ||
      (generationProviderStates !== undefined && (!generationProviderStates || typeof generationProviderStates !== 'object' || Array.isArray(generationProviderStates)))) {
    throw new Error('任务索引损坏')
  }
  return { tasks, permissions: resourceFiles(tasks) }
}
