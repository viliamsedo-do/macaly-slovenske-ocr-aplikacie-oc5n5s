import { createLocalOcrWorker, extractLines, type TextLine } from './anonymize'

export interface OfflineField {
  label: string
  value: string
  part: string
  certainty: string
}

interface CodeEntry {
  code: string
  part: string
}

/** Official OSV position codes mapped to document parts. */
const CODES: CodeEntry[] = [
  { code: 'C.1.1', part: 'časť I' },
  { code: 'C.1.3', part: 'časť I' },
  { code: 'C.2.1', part: 'časť I' },
  { code: 'C.2.3', part: 'časť I' },
  { code: 'D.1', part: 'časť II' },
  { code: 'D.2', part: 'časť II' },
  { code: 'D.3', part: 'časť II' },
  { code: 'F.1', part: 'časť II' },
  { code: 'F.2', part: 'časť II' },
  { code: 'F.3', part: 'časť II' },
  { code: 'O.1', part: 'časť II' },
  { code: 'O.2', part: 'časť II' },
  { code: 'P.1', part: 'časť II' },
  { code: 'P.2', part: 'časť II' },
  { code: 'P.3', part: 'časť II' },
  { code: 'P.4', part: 'časť II' },
  { code: 'P.5', part: 'časť II' },
  { code: 'S.1', part: 'časť II' },
  { code: 'S.2', part: 'časť II' },
  { code: 'V.1', part: 'časť II' },
  { code: 'V.2', part: 'časť II' },
  { code: 'V.3', part: 'časť II' },
  { code: 'V.4', part: 'časť II' },
  { code: 'V.5', part: 'časť II' },
  { code: 'V.6', part: 'časť II' },
  { code: 'V.7', part: 'časť II' },
  { code: 'V.8', part: 'časť II' },
  { code: 'V.9', part: 'časť II' },
  { code: 'A', part: 'časť I' },
  { code: 'B', part: 'časť I' },
  { code: 'E', part: 'časť I' },
  { code: 'H', part: 'časť I' },
  { code: 'I', part: 'časť I' },
  { code: 'J', part: 'časť II' },
  { code: 'K', part: 'časť II' },
  { code: 'L', part: 'časť II' },
  { code: 'M', part: 'časť II' },
  { code: 'N', part: 'časť II' },
  { code: 'Q', part: 'časť II' },
  { code: 'R', part: 'časť II' },
  { code: 'T', part: 'časť II' },
  { code: 'W', part: 'časť II' },
  { code: 'G', part: 'časť II' },
]

function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9. ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findCode(label: string): CodeEntry | null {
  const normalized = normalize(label)
  for (const entry of CODES) {
    const code = normalize(entry.code)
    const pattern = new RegExp(`(^| )${code.replace(/\./g, '\\.?')}( |$)`)
    if (pattern.test(normalized)) return entry
  }
  return null
}

/** Plain Slovak field names (ASCII, diacritics stripped by normalize). */
const NAME_MATCHERS: { pattern: RegExp; part: string }[] = [
  { pattern: /evidencne cislo|evidencne/, part: 'časť I' },
  { pattern: /vin/, part: 'časť I' },
  { pattern: /znacka/, part: 'časť II' },
  { pattern: /kateg/, part: 'časť II' },
  { pattern: /palivo|zdroj energie/, part: 'časť II' },
  { pattern: /objem|zdvihov/, part: 'časť II' },
  { pattern: /vykon/, part: 'časť II' },
  { pattern: /farba/, part: 'časť II' },
  { pattern: /miest|lozok/, part: 'časť II' },
  { pattern: /nadrze/, part: 'časť II' },
  { pattern: /razvor/, part: 'časť II' },
  { pattern: /hmotnos/, part: 'časť II' },
  { pattern: /rychlos/, part: 'časť II' },
  { pattern: /pneumat|rafik|naprav/, part: 'časť II' },
  { pattern: /spotreba|emisie|dymivos|co2|nox/, part: 'časť II' },
  { pattern: /meno|priezvisko|vlastnik|drzite/, part: 'časť I' },
  { pattern: /pobyt|bydlis|adres/, part: 'časť I' },
  { pattern: /datum (prvej )?registr|prvej evidenc|rok vyroby/, part: 'časť I' },
  { pattern: /platnos/, part: 'časť I' },
  { pattern: /peciatka|podpis/, part: 'časť I' },
  { pattern: /technickeho osved|cislo technick/, part: 'časť I' },
]

function resolvePosition(label: string): { part: string } | null {
  const normalized = normalize(label)
  if (!normalized) return null
  const byCode = findCode(label)
  if (byCode) return byCode
  const byName = NAME_MATCHERS.find((matcher) => matcher.pattern.test(normalized))
  return byName ? { part: byName.part } : null
}

function splitLine(
  line: TextLine & { words?: { text: string; bbox: TextLine['bbox'] }[] },
): { label: string; value: string } | null {
  const words =
    line.words ??
    (line.text ? line.text.split(/\s+/).filter(Boolean).map((text) => ({ text, bbox: line.bbox })) : [])
  if (words.length < 2) return null

  const height = Math.max(1, line.bbox.y1 - line.bbox.y0)
  const threshold = Math.max(22, height * 1.2)

  let splitIndex = -1
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].bbox.x0 - words[i - 1].bbox.x1
    if (gap >= threshold) {
      splitIndex = i
      break
    }
  }
  if (splitIndex === -1) return null

  const label = words.slice(0, splitIndex).map((w) => w.text).join(' ').trim()
  const value = words.slice(splitIndex).map((w) => w.text).join(' ').trim()
  if (!label || !value) return null
  return { label, value }
}

function certaintyOf(confidence: number | undefined) {
  if (typeof confidence !== 'number') return 'dobrá'
  if (confidence >= 85) return 'výborná'
  if (confidence >= 65) return 'dobrá'
  return 'nízka'
}

const OCR_TARGET_EDGE = 2400

/**
 * Upscale and clean the image for Tesseract: higher resolution plus
 * grayscale and a contrast boost dramatically improve recognition of
 * small print on certificates.
 */
function preprocess(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(3, Math.max(1, OCR_TARGET_EDGE / Math.max(img.width, img.height)))
      const width = Math.round(img.width * scale)
      const height = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        reject(new Error('Prehliadač nepodporuje úpravu obrázkov.'))
        return
      }
      ctx.imageSmoothingQuality = 'high'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      const imageData = ctx.getImageData(0, 0, width, height)
      const px = imageData.data
      for (let i = 0; i < px.length; i += 4) {
        const gray = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
        const contrast = Math.max(0, Math.min(255, (gray - 128) * 1.5 + 128))
        px[i] = contrast
        px[i + 1] = contrast
        px[i + 2] = contrast
      }
      ctx.putImageData(imageData, 0, 0)
      resolve(canvas)
    }
    img.onerror = () => reject(new Error('Obrázok sa nepodarilo načítať.'))
    img.src = dataUrl
  })
}

/**
 * Fully offline OCR: recognizes the page locally (Tesseract) and extracts
 * OSV fields from label/value column layout. No network calls beyond the
 * first-time Tesseract language data download (cached afterwards).
 */
export async function ocrOfflineDataUrl(
  dataUrl: string,
  maskedHint: boolean,
): Promise<OfflineField[]> {
  const worker = await createLocalOcrWorker()
  let data: unknown
  try {
    const canvas = await preprocess(dataUrl)
    const result = await worker.recognize(canvas, {}, { blocks: true, text: true })
    data = result.data
  } finally {
    await worker.terminate()
  }

  const lines = extractLines(data).sort((a, b) => a.bbox.y0 - b.bbox.y0)
  const fields: OfflineField[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const split = splitLine(line as TextLine & { words?: { text: string; bbox: TextLine['bbox'] }[] })
    if (!split) continue
    const position = resolvePosition(split.label)
    if (!position) continue
    const key = normalize(split.label)
    if (seen.has(key)) continue
    seen.add(key)
    fields.push({
      label: split.label,
      value: maskedHint && /zamazan|anonym/i.test(line.text) ? '(anonymizované)' : split.value,
      part: position.part,
      certainty: certaintyOf(
        (line as unknown as { confidence?: number }).confidence,
      ),
    })
  }
  return fields
}
