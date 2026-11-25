import type { GalleryImage, ResultGroup } from '../../src/types'

// Read-only compatibility projection; persist only with a coordinated group mutation.
export function normalizeCollections(groups: readonly ResultGroup[], images: readonly GalleryImage[]): ResultGroup[] {
  const types = new Map(images.map(image => [image.id, image.assetType]))
  const usedIds = new Set(groups.map(group => group.id))
  return groups.flatMap(group => {
    if (group.assetType === 'recipe' || group.assetType === 'work') return [group]
    const recipeIds = group.imageIds.filter(id => types.get(id) !== 'work')
    const workIds = group.imageIds.filter(id => types.get(id) === 'work')
    const split = (assetType: 'recipe' | 'work', imageIds: string[], id: string): ResultGroup => ({
      ...group, id, assetType, imageIds, version: group.version + 1,
      coverId: imageIds.includes(group.coverId || '') ? group.coverId : imageIds[0],
      bestId: imageIds.includes(group.bestId || '') ? group.bestId : undefined,
    })
    if (!workIds.length) return [split('recipe', recipeIds, group.id)]
    if (!recipeIds.length) return [split('work', workIds, group.id)]
    let id = `${group.id}:work`
    for (let suffix = 2; usedIds.has(id); suffix++) id = `${group.id}:work:${suffix}`
    usedIds.add(id)
    return [split('recipe', recipeIds, group.id), split('work', workIds, id)]
  })
}

// Call inside the existing write coordinator before a classification change or purge.
// Persisting ownership first is safe even if the subsequent image edit fails.
export async function preserveCollectionOwnership(
  repository: import('./gallery-repository').GalleryRepository,
  images: GalleryImage[],
  scope: import('./gallery-repository').GalleryScope,
): Promise<void> {
  const resources = await repository.readResources?.(scope)
  if (!resources?.groups?.some(group => !group.assetType)) return
  if (!repository.saveResources) throw new Error('当前存储不支持固定收藏夹归属')
  await repository.saveResources({ ...resources, groups: normalizeCollections(resources.groups, images) }, scope)
}
