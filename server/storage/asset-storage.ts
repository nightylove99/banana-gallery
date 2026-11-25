export interface AssetStorage {
  ensureDirectories(): Promise<void> | void
  getImagesDir(): string
  getReferencesDir(): string
  getImagePath(filename: string): string
  getReferencePath(filename: string): string
  copyImageFrom(sourcePath: string): Promise<string> | string
  finalizeImage(filename: string): Promise<void> | void
  finalizeReferences(filenames: string[]): Promise<void> | void
  deleteImage(filename: string): Promise<void> | void
  deleteReferences(filenames: string[]): Promise<void> | void
}
