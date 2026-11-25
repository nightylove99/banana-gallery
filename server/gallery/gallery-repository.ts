import type { GalleryImage, GalleryResources } from '../../src/types'

type BorrowedResource<T> = T extends Array<infer Entry> ? readonly Readonly<Entry>[] : Readonly<T>
export type ReadOnlyGalleryResources = { readonly [Key in keyof GalleryResources]: BorrowedResource<GalleryResources[Key]> }

export interface GalleryScope {
  workspaceId: string
  ownerUserId?: string
}

export interface GalleryRepository {
  hasAssetAccess?(scope: GalleryScope | undefined, kind: 'images' | 'references', filename: string): Promise<boolean>
  listResourceScopes?(): Promise<GalleryScope[]>
  readResources?(scope?: GalleryScope): Promise<GalleryResources>
  saveResources?(resources: GalleryResources, scope?: GalleryScope): Promise<void>
  listImages(scope?: GalleryScope): Promise<GalleryImage[]>
  saveImages(images: GalleryImage[], scope?: GalleryScope): Promise<void>
}
