import { drawToCanvas, canvasToJpeg } from './ocr-image'

const PERSONAL_PATTERNS = [
  'c.1.1',
  'c.1.3',
  'c.2.1',
  'c.2.3',
  'meno',
  'priezvisko',
  'bydlisko',
  'pobyt',
  'vlastník',
  'držiteľ',
  'rodné č',
  'rodné c',
  'dátum narodenia',
  'datum narodenia',
  'pečiatka',
  'peciatka',
  'podpis',
  'adresa',
  'ičo',
  'ico ',
]

export interface AnonymizeResult {
  dataUrl: string
  maskedZones: string[]
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Obrázok sa nepodarilo načítať.'))
    img.src = dataUrl
  })
}

export interface TextLine {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

export function extractLines(data: unknown): TextLine[] {
  if (!data || typeof data !== 'object') return []
  const page = data as {
    blocks?: unknown
    lines?: unknown
  }
  if (Array.isArray(page.lines)) {
    return page.lines.filter(isTextLine)
  }
  const blocks = Array.isArray(page.blocks) ? page.blocks : []
  const lines: TextLine[] = []
  for (const block of blocks) {
    const paragraphs =
      (block as { paragraphs?: unknown } | undefined)?.paragraphs ?? []
    for (const paragraph of Array.isArray(paragraphs) ? paragraphs : []) {
      const paragraphLines =
        (paragraph as { lines?: unknown } | undefined)?.lines ?? []
      for (const line of Array.isArray(paragraphLines) ? paragraphLines : []) {
        if (isTextLine(line)) lines.push(line as TextLine)
      }
    }
  }
  return lines
}

function isTextLine(line: unknown): line is TextLine {
  const candidate = line as { text?: unknown; bbox?: TextLine['bbox'] }
  return (
    typeof candidate.text === 'string' &&
    !!candidate.bbox &&
    typeof candidate.bbox.x0 === 'number'
  )
}

export async function createLocalOcrWorker() {
  const { createWorker } = await import('tesseract.js')
  return createWorker(['slv', 'eng'])
}

/**
 * Runs a local OCR pass (in the browser) to find personal-data labels and
 * paints over those areas, so the image sent to the AI API contains no
 * personal data. Nothing about the original image ever leaves the device
 * except the anonymized JPEG.
 */
export async function anonymizeDataUrl(dataUrl: string): Promise<AnonymizeResult> {
  const worker = await createLocalOcrWorker()
  let ocrText: { data: unknown }
  try {
    ocrText = await worker.recognize(dataUrl, {}, { blocks: true, text: true })
  } finally {
    await worker.terminate()
  }

  const img = await loadImage(dataUrl)
  const canvas = drawToCanvas(img, img.width, img.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Prehliadač nepodporuje úpravu obrázkov.')
  ctx.fillStyle = 'hsl(189 47% 17%)'

  const maskedZones: string[] = []
  for (const line of extractLines(ocrText.data)) {
    const text = line.text.toLowerCase()
    const match = PERSONAL_PATTERNS.find((pattern) => text.includes(pattern))
    if (!match) continue
    const x0 = Math.max(0, line.bbox.x0 - 4)
    const y0 = Math.max(0, line.bbox.y0 - 4)
    const y1 = Math.min(canvas.height, line.bbox.y1 + 4)
    ctx.fillRect(x0, y0, canvas.width - x0, y1 - y0)
    maskedZones.push(match)
  }

  return { dataUrl: canvasToJpeg(canvas).dataUrl, maskedZones }
}
