import type { GalleryAssetType, GalleryImage, ViewFilter } from '@/types'

export function filterImagesByView(
  images: GalleryImage[],
  assetType: GalleryAssetType,
  filter: ViewFilter,
) {
  const scopedImages = images.filter((image) => image.assetType === assetType)

  if (filter === 'favorites') {
    return scopedImages.filter((image) => image.favorited)
  }

  if (filter.startsWith('tag:')) {
    const tag = filter.replace('tag:', '')
    return scopedImages.filter((image) => image.tags.includes(tag))
  }

  return scopedImages
}

export function getTagsForAssetType(images: GalleryImage[], assetType: GalleryAssetType) {
  const tags = new Set<string>()
  for (const image of images) {
    if (image.assetType !== assetType) continue
    for (const tag of image.tags) tags.add(tag)
  }
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export function getAssetCount(images: GalleryImage[], assetType: GalleryAssetType) {
  return images.filter((image) => image.assetType === assetType).length
}

export function getFavoriteCountForWorks(images: GalleryImage[]) {
  return images.filter((image) => image.assetType === 'work' && image.favorited).length
}

export function getHeaderTitle(assetType: GalleryAssetType, filter: ViewFilter) {
  if (filter.startsWith('tag:')) return `# ${filter.replace('tag:', '')}`
  if (assetType === 'recipe') return filter === 'favorites' ? '喜欢的配方' : '配方库'
  if (filter === 'favorites') return '喜欢的作品'
  return '作品库'
}

export function getEmptyState(assetType: GalleryAssetType, filter: ViewFilter) {
  if (assetType === 'recipe') {
    return {
      title: filter.startsWith('tag:') ? '这个标签下还没有配方' : '还没有配方',
      description: '去设置里导入 Markdown，或把生成结果保存为配方。',
    }
  }

  if (filter === 'favorites') {
    return {
      title: '还没有喜欢的作品',
      description: '先给几张作品点个喜欢。',
    }
  }

  if (filter.startsWith('tag:')) {
    return {
      title: '这个标签下还没有作品',
      description: '试试切换标签，或先上传图片、生成并保存作品。',
    }
  }

  return {
    title: '还没有作品',
    description: '点击左下角上传图片，或先去生成页保存作品。',
  }
}
