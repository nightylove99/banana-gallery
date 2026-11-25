// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { GalleryImage } from '../../src/types'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))
const uploadImageMock = vi.fn()
const saveImageReferencesMock = vi.fn()
const fetchImageMock = vi.fn()

vi.mock('@/api', () => ({
  uploadImage: (...args: unknown[]) => uploadImageMock(...args),
  fetchImage: (...args: unknown[]) => fetchImageMock(...args),
  saveImageReferences: (...args: unknown[]) => saveImageReferencesMock(...args),
}))

vi.mock('sonner', () => ({
  toast: toastMocks,
}))

import { UploadModal } from '../../src/components/UploadModal'

const baseImage: GalleryImage = {
  id: 'image-1',
  filename: 'image-1.png',
  prompt: 'banana prompt',
  referenceImages: [],
  tags: [],
  favorited: false,
  createdAt: '2026-03-20T00:00:00.000Z',
  width: 1024,
  height: 1024,
  assetType: 'work',
}

beforeEach(() => {
  uploadImageMock.mockResolvedValue({ ...baseImage })
  fetchImageMock.mockResolvedValue({ ...baseImage })
  saveImageReferencesMock.mockResolvedValue({
    ...baseImage,
    referenceImages: ['ref_server_1.png'],
  })
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  })
  toastMocks.success.mockClear()
  toastMocks.error.mockClear()
})

afterEach(() => {
  cleanup()
  uploadImageMock.mockReset()
  fetchImageMock.mockReset()
  saveImageReferencesMock.mockReset()
  vi.unstubAllGlobals()
})

describe('UploadModal', () => {
  function createImageFile(name: string, type = 'image/png') {
    return new File([name], name, { type })
  }

  function dispatchPaste(files: File[]) {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: files.map((file) => ({
          kind: 'file',
          type: file.type,
          getAsFile: () => file,
        })),
        files,
      },
    })
    window.dispatchEvent(event)
    return event
  }

  function dispatchTextPaste() {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
        ],
        files: [],
      },
    })
    window.dispatchEvent(event)
    return event
  }

  it('上传含参考图的作品后，会把服务端参考图文件名回传给画廊', async () => {
    const onUploaded = vi.fn()
    const user = userEvent.setup()

    render(<UploadModal open onClose={() => undefined} onUploaded={onUploaded} />)

    const mainInput = document.querySelector('input[type="file"]:not([multiple])')
    const refInput = document.querySelector('input[type="file"][multiple]')

    expect(mainInput).toBeTruthy()
    expect(refInput).toBeTruthy()

    const mainFile = new File(['main'], 'main.png', { type: 'image/png' })
    const refFile = new File(['ref'], 'local-reference.png', { type: 'image/png' })

    await user.upload(mainInput as HTMLInputElement, mainFile)
    await user.upload(refInput as HTMLInputElement, refFile)
    await user.click(screen.getByRole('button', { name: '上传' }))

    await waitFor(() => {
      expect(saveImageReferencesMock).toHaveBeenCalledWith('image-1', [refFile], [], undefined, 0)
    })

    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceImages: ['ref_server_1.png'],
        }),
      )
    })
  })

  it('鼠标在主图区时粘贴图片会设置主图，多图只取第一张', async () => {
    const user = userEvent.setup()
    render(<UploadModal open onClose={() => undefined} onUploaded={() => undefined} />)

    const mainDropzone = screen.getByTestId('main-image-dropzone')
    const firstMainFile = createImageFile('first-main.png')
    const secondMainFile = createImageFile('second-main.png')

    fireEvent.pointerEnter(mainDropzone)
    dispatchPaste([firstMainFile, secondMainFile])
    await user.click(screen.getByRole('button', { name: '上传' }))

    await waitFor(() => {
      expect(uploadImageMock).toHaveBeenCalledWith(
        expect.objectContaining({ image: firstMainFile }),
      )
    })
  })

  it('鼠标在参考图区时粘贴图片会追加为参考图', async () => {
    const user = userEvent.setup()
    render(<UploadModal open onClose={() => undefined} onUploaded={() => undefined} />)

    const mainInput = document.querySelector('input[type="file"]:not([multiple])')
    const refDropzone = screen.getByTestId('reference-image-dropzone')
    const mainFile = createImageFile('main.png')
    const refFile = createImageFile('pasted-reference.webp', 'image/webp')

    await user.upload(mainInput as HTMLInputElement, mainFile)
    fireEvent.pointerEnter(refDropzone)
    dispatchPaste([refFile])
    await user.click(screen.getByRole('button', { name: '上传' }))

    await waitFor(() => {
      expect(saveImageReferencesMock).toHaveBeenCalledWith('image-1', [refFile], [], undefined, 0)
    })
  })

  it('鼠标不在上传区时粘贴图片不会设置主图或参考图', () => {
    render(<UploadModal open onClose={() => undefined} onUploaded={() => undefined} />)

    dispatchPaste([createImageFile('ignored.png')])

    expect(screen.queryByAltText('preview')).toBeNull()
    expect(screen.getByRole('button', { name: '上传' }).hasAttribute('disabled')).toBe(true)
  })

  it('文本粘贴不会被图片粘贴逻辑拦截', () => {
    render(<UploadModal open onClose={() => undefined} onUploaded={() => undefined} />)

    fireEvent.pointerEnter(screen.getByTestId('main-image-dropzone'))
    const event = dispatchTextPaste()

    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByAltText('preview')).toBeNull()
  })

  it('参考图粘贴最多追加到 10 张', async () => {
    const user = userEvent.setup()
    render(<UploadModal open onClose={() => undefined} onUploaded={() => undefined} />)

    const mainInput = document.querySelector('input[type="file"]:not([multiple])')
    const refInput = document.querySelector('input[type="file"][multiple]')
    const refDropzone = screen.getByTestId('reference-image-dropzone')
    const mainFile = createImageFile('main.png')
    const initialRefs = Array.from({ length: 9 }, (_, index) => createImageFile(`ref-${index}.png`))
    const acceptedPastedRef = createImageFile('accepted-ref.png')
    const overflowPastedRef = createImageFile('overflow-ref.png')

    await user.upload(mainInput as HTMLInputElement, mainFile)
    await user.upload(refInput as HTMLInputElement, initialRefs)
    fireEvent.pointerEnter(refDropzone)
    dispatchPaste([acceptedPastedRef, overflowPastedRef])
    await user.click(screen.getByRole('button', { name: '上传' }))

    await waitFor(() => {
      expect(saveImageReferencesMock).toHaveBeenCalledWith(
        'image-1',
        [...initialRefs, acceptedPastedRef], [], undefined, 0,
      )
    })
    expect(toastMocks.error).toHaveBeenCalledWith('最多支持 10 张参考图')
  })
})

it('keeps the created main image and retries only references after a partial upload failure', async () => {
  const onUploaded=vi.fn(),user=userEvent.setup()
  saveImageReferencesMock.mockRejectedValueOnce(new Error('参考图暂时不可用'))
  render(<UploadModal open onClose={()=>{}} onUploaded={onUploaded}/>)
  await user.upload(document.querySelector('input[type=file]:not([multiple])') as HTMLInputElement,new File(['main'],'main.png',{type:'image/png'}))
  await user.upload(document.querySelector('input[type=file][multiple]') as HTMLInputElement,new File(['ref'],'ref.png',{type:'image/png'}))
  await user.click(screen.getByRole('button',{name:'上传',exact:true}))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('参考图暂时不可用'))
  await user.click(screen.getByRole('button',{name:'重试参考图'}))
  await waitFor(()=>expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({referenceImages:['ref_server_1.png']})))
  expect(uploadImageMock).toHaveBeenCalledTimes(1)
  expect(saveImageReferencesMock).toHaveBeenCalledTimes(2)
})


it('recovers a committed reference batch after a lost reply without appending it twice', async () => {
  const onUploaded = vi.fn(), user = userEvent.setup()
  uploadImageMock.mockResolvedValueOnce({ ...baseImage, version: 1 })
  saveImageReferencesMock.mockRejectedValueOnce(new Error('连接中断'))
  fetchImageMock.mockResolvedValueOnce({ ...baseImage, version: 2, referenceImages: ['already-saved.png'] })
  render(<UploadModal open onClose={() => {}} onUploaded={onUploaded} />)
  await user.upload(document.querySelector('input[type=file]:not([multiple])') as HTMLInputElement, new File(['main'], 'main.png', { type: 'image/png' }))
  await user.upload(document.querySelector('input[type=file][multiple]') as HTMLInputElement, new File(['ref'], 'ref.png', { type: 'image/png' }))
  await user.click(screen.getByRole('button', { name: '上传', exact: true }))
  await user.click(await screen.findByRole('button', { name: '重试参考图' }))
  await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: ['already-saved.png'] })))
  expect(saveImageReferencesMock).toHaveBeenCalledOnce()
})

it('revokes replaced and remaining preview URLs even when unmounted without closing', async () => {
  const user = userEvent.setup()
  vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:old-main').mockReturnValueOnce('blob:new-main').mockReturnValueOnce('blob:ref')
  const view = render(<UploadModal open onClose={() => {}} onUploaded={() => {}} />)
  const main = document.querySelector('input[type=file]:not([multiple])') as HTMLInputElement
  const ref = document.querySelector('input[type=file][multiple]') as HTMLInputElement
  await user.upload(main, new File(['old'], 'old.png', { type: 'image/png' }))
  await user.upload(main, new File(['new'], 'new.png', { type: 'image/png' }))
  await user.upload(ref, new File(['ref'], 'ref.png', { type: 'image/png' }))
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-main')
  view.unmount()
  expect(vi.mocked(URL.revokeObjectURL).mock.calls.flat().sort()).toEqual(['blob:new-main', 'blob:old-main', 'blob:ref'])
})
