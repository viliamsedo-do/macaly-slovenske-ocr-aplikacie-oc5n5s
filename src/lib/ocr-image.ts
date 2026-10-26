import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const MAX_EDGE = 1600

function loadBitmap(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Obrázok sa nepodarilo načítať.'))
    }
    img.src = url
    img.dataset.objectUrl = url
  })
}

export function canvasToJpeg(canvas: HTMLCanvasElement): { base64: string; dataUrl: string } {
  let quality = 0.85
  let dataUrl = canvas.toDataURL('image/jpeg', quality)
  // Keep the payload safely under Convex action argument limits.
  while (dataUrl.length > 900_000 && quality > 0.4) {
    quality -= 0.15
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  }
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl }
}

export function drawToCanvas(source: CanvasImageSource, srcW: number, srcH: number) {
  const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH))
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Prehliadač nepodporuje prácu s obrázkami.')
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  return canvas
}

/** Downscale an uploaded photo to a single JPEG base64 (no data: prefix). */
export async function fileToJpegBase64(
  file: File,
): Promise<{ base64: string; mediaType: string }> {
  const img = await loadBitmap(file)
  const objectUrl = img.dataset.objectUrl
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  const canvas = drawToCanvas(img, img.width, img.height)
  return { base64: canvasToJpeg(canvas).base64, mediaType: 'image/jpeg' }
}

/** Render an uploaded photo to a JPEG data URL (for local anonymization). */
export async function fileToJpegDataUrl(file: File): Promise<string> {
  const img = await loadBitmap(file)
  const objectUrl = img.dataset.objectUrl
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  const canvas = drawToCanvas(img, img.width, img.height)
  return canvasToJpeg(canvas).dataUrl
}

export interface PdfPage {
  base64: string
  preview: string
  mediaType: string
  pageNumber: number
}

/**
 * Render each page of an uploaded PDF (up to maxPages) to JPEG base64
 * images, in page order.
 */
export async function pdfToJpegPages(
  file: File,
  maxPages = 4,
): Promise<{ pages: PdfPage[] }> {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const total = Math.min(pdf.numPages, maxPages)
  const pages: PdfPage[] = []

  for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 2 })
    const width = Math.max(1, Math.round(viewport.width))
    const height = Math.max(1, Math.round(viewport.height))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Prehliadač nepodporuje prácu s PDF súbormi.')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    await page.render({ canvasContext: ctx, canvas, viewport } as never).promise
    const jpeg = canvasToJpeg(canvas)
    pages.push({
      base64: jpeg.base64,
      preview: jpeg.dataUrl,
      mediaType: 'image/jpeg',
      pageNumber,
    })
  }

  await pdf.cleanup()
  return { pages }
}
