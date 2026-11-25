import { useState, useCallback, useMemo, useSyncExternalStore } from 'react'
import type { GalleryAssetType, GalleryImage, ViewFilter } from '../types'
import { useGalleryStore } from './GalleryProvider'
import { filterGalleryImages, type GalleryQuery } from '../lib/gallery-query'
import { deleteImage, patchImage } from '../api'
import {
  getAssetCount,
  getTagsForAssetType,
} from '../lib/gallery-view'

export function useGallery(initialQuery: GalleryQuery = {}) {
  const [query, setQuery] = useState<GalleryQuery>(initialQuery)
  const store = useGalleryStore()
  const { trashCount, groups, groupsLoading, groupsError, allImages, loading, loadingMore, total, stats, error, pendingImages, pendingCount } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [assetType, setAssetTypeState] = useState<GalleryAssetType>(initialQuery.assetType || 'recipe')
  const [filter, setFilter] = useState<ViewFilter>(initialQuery.favorites ? 'favorites' : 'all')
  const images = useMemo(
    () => filterGalleryImages(allImages, { ...query, assetType, favorites: filter === 'favorites', tags: [...new Set([...(query.tags || []), ...(filter.startsWith('tag:') ? [filter.slice(4)] : [])])] }, { includeWorkCode: true }),
    [allImages, assetType, filter, query],
  )

  const tags = useMemo(
    () => getTagsForAssetType(allImages, assetType),
    [allImages, assetType],
  )

  const workCount = useMemo(
    () => loadingMore && stats ? stats.works : getAssetCount(allImages, 'work'),
    [allImages, loadingMore, stats],
  )

  const recipeCount = useMemo(
    () => loadingMore && stats ? stats.recipes : getAssetCount(allImages, 'recipe'),
    [allImages, loadingMore, stats],
  )

  const favoriteCount = useMemo(
    () => loadingMore && stats ? (assetType === 'work' ? stats.favoriteWorks : stats.favoriteRecipes) : allImages.filter(image => image.assetType === assetType && image.favorited).length,
    [allImages, assetType, loadingMore, stats],
  )

  const setAssetType = useCallback((nextAssetType: GalleryAssetType) => {
    setAssetTypeState(nextAssetType)
  }, [])

  const toggleFavorite = useCallback(async (id: string) => {
    const image = allImages.find(item => item.id === id)
    if (!image) return
    const updated = await patchImage(id, { favorited: !image.favorited }, image.version || 0)
    store.replace(updated)
    return updated
  }, [allImages, store])

  const updateImage = useCallback(async (id: string, updates: Partial<GalleryImage>, expectedVersion?: number) => {
    const updated = await patchImage(id, updates, expectedVersion ?? allImages.find(image => image.id === id)?.version ?? 0)
    store.replace(updated)
    return updated
  }, [allImages, store])

  const removeImage = useCallback(async (id: string) => {
    const result = await deleteImage(id)
    store.remove(id)
    void store.refreshTrashCount()
    return result
  }, [store])
  const loadImages = useCallback(() => store.reload(), [store])
  const replaceImage = useCallback((image: GalleryImage) => {
    if (image.deletedAt) {
      store.remove(image.id)
      void store.refreshTrashCount()
    } else store.replace(image)
  }, [store])
  const addImage = store.add

  return {
    trashCount, refreshTrashCount: store.refreshTrashCount,
    groups, groupsLoading, groupsError, reloadGroups: store.reloadGroups, setGroups: store.setGroups,
    loadingMore, total, query, setQuery, error, pendingImages, pendingCount, applyPending: store.applyPending,
    images,
    allImages,
    tags,
    assetType,
    setAssetType,
    filter,
    setFilter,
    loading,
    workCount,
    recipeCount,
    favoriteCount,
    reload: loadImages,
    toggleFavorite,
    updateImage,
    removeImage,
    addImage,
    replaceImage,
  }
}
