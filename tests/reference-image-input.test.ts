import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractReferenceImagesFromClipboard,
  hasDraggedFiles,
  isEditablePasteTarget,
  splitReferenceImageFiles,
  SUPPORTED_UPLOAD_IMAGE_TYPES,
} from '../src/lib/reference-image-input.ts'

function createFile(name: string, type: string) {
  return { name, type } as File
}

test('splitReferenceImageFiles 只接受 JPG 和 PNG', () => {
  const files = [
    createFile('a.png', 'image/png'),
    createFile('b.jpg', 'image/jpeg'),
    createFile('c.webp', 'image/webp'),
    createFile('d.txt', 'text/plain'),
  ]

  const { accepted, rejected } = splitReferenceImageFiles(files)

  assert.deepEqual(accepted.map((file) => file.name), ['a.png', 'b.jpg'])
  assert.deepEqual(rejected.map((file) => file.name), ['c.webp', 'd.txt'])
})

test('hasDraggedFiles 只识别包含本地文件的拖拽', () => {
  assert.equal(hasDraggedFiles({ types: ['text/plain', 'Files'] }), true)
  assert.equal(hasDraggedFiles({ types: ['text/plain'] }), false)
  assert.equal(hasDraggedFiles(null), false)
})

test('splitReferenceImageFiles 可配置为接受上传弹窗支持的 WebP', () => {
  const files = [
    createFile('a.png', 'image/png'),
    createFile('b.webp', 'image/webp'),
    createFile('c.gif', 'image/gif'),
  ]

  const { accepted, rejected } = splitReferenceImageFiles(files, SUPPORTED_UPLOAD_IMAGE_TYPES)

  assert.deepEqual(accepted.map((file) => file.name), ['a.png', 'b.webp'])
  assert.deepEqual(rejected.map((file) => file.name), ['c.gif'])
})

test('extractReferenceImagesFromClipboard 优先读取剪贴板图片项', () => {
  const pngFile = createFile('clipboard.png', 'image/png')
  const jpegFile = createFile('clipboard.jpg', 'image/jpeg')

  const files = extractReferenceImagesFromClipboard({
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => pngFile },
      { kind: 'file', type: 'image/jpeg', getAsFile: () => jpegFile },
    ],
    files: [createFile('fallback.webp', 'image/webp')],
  })

  assert.deepEqual(files.map((file) => file.name), ['clipboard.png', 'clipboard.jpg'])
})

test('extractReferenceImagesFromClipboard 在没有图片项时回退到 files', () => {
  const files = extractReferenceImagesFromClipboard({
    files: [
      createFile('fallback.png', 'image/png'),
      createFile('fallback.webp', 'image/webp'),
    ],
  })

  assert.deepEqual(files.map((file) => file.name), ['fallback.png'])
})

test('extractReferenceImagesFromClipboard 支持配置上传弹窗图片类型', () => {
  const webpFile = createFile('clipboard.webp', 'image/webp')

  const files = extractReferenceImagesFromClipboard({
    items: [
      { kind: 'file', type: 'image/webp', getAsFile: () => webpFile },
    ],
  }, SUPPORTED_UPLOAD_IMAGE_TYPES)

  assert.deepEqual(files.map((file) => file.name), ['clipboard.webp'])
})

test('isEditablePasteTarget 能识别输入框和可编辑容器', () => {
  assert.equal(isEditablePasteTarget({ tagName: 'textarea' } as EventTarget), true)
  assert.equal(
    isEditablePasteTarget({
      tagName: 'span',
      parentElement: { isContentEditable: true },
    } as EventTarget),
    true,
  )
  assert.equal(isEditablePasteTarget({ tagName: 'div' } as EventTarget), false)
})
