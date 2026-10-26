import { createFileRoute } from '@tanstack/react-router'
import { useAction } from 'convex/react'
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { api } from '@/convex/_generated/api'
import { canonicalUrl } from '../lib/canonical-url'
import siteMetadata from '../metadata.json'
import { fileToJpegBase64, fileToJpegDataUrl, pdfToJpegPages, type PdfPage } from '../lib/ocr-image'
import { anonymizeDataUrl, type AnonymizeResult } from '../lib/anonymize'
import { ocrOfflineDataUrl } from '../lib/offline-ocr'

const homepageMeta = siteMetadata['/']

export const Route = createFileRoute('/')({
  head: () => {
    const canonical = canonicalUrl('/')

    return {
      meta: [
        { title: homepageMeta.title },
        { name: 'description', content: homepageMeta.description },
      ],
      links: canonical ? [{ rel: 'canonical', href: canonical }] : [],
    }
  },
  component: App,
})

interface OcrField {
  label: string
  value: string
  part: string
  certainty: string
}

interface OcrResult {
  documentType: string
  fields: OcrField[]
  notes: string
  rawText: string
}

type Status = 'idle' | 'loading' | 'ready' | 'error'

const CERTAINTY_LABEL: Record<string, string> = {
  'výborná': 'text-palm',
  'dobrá': 'text-lagoon-deep',
  'nízka': 'text-stamp',
}

function certaintyClass(certainty: string) {
  return CERTAINTY_LABEL[certainty] ?? 'text-sea-ink-soft'
}

const PART_ORDER = ['časť I', 'časť II', 'neuvedené'] as const

function groupFields(fields: OcrField[]) {
  const groups = new Map<string, OcrField[]>()
  for (const field of fields) {
    const part = (PART_ORDER as readonly string[]).includes(field.part)
      ? field.part
      : 'neuvedené'
    const list = groups.get(part) ?? []
    list.push(field)
    groups.set(part, list)
  }
  return PART_ORDER.filter((part) => groups.has(part)).map((part) => ({
    part,
    fields: groups.get(part)!,
  }))
}

function MagnifierIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-6" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" strokeLinecap="round" />
      <path d="m15.5 15.5 4.5 4.5" strokeLinecap="round" />
      <path d="M7.5 10.5h6M10.5 7.5v6" strokeLinecap="round" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-10" aria-hidden="true">
      <path d="M6 3.5h8.5L19 8v12.5H6z" strokeLinejoin="round" />
      <path d="M14 3.5V8h5" strokeLinejoin="round" />
      <path d="M9 12h7M9 15.5h7M9 8h2" strokeLinecap="round" />
    </svg>
  )
}

function App() {
  const ocrDocument = useAction(api.ocr.ocrDocument)
  const inputRef = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [isPdf, setIsPdf] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [pdfPages, setPdfPages] = useState<PdfPage[]>([])
  const [dragging, setDragging] = useState(false)
  const [engine, setEngine] = useState<'online' | 'offline'>('online')
  const [anonymizeOn, setAnonymizeOn] = useState(false)
  const [anonymizing, setAnonymizing] = useState(false)
  const [maskedZones, setMaskedZones] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [result, setResult] = useState<OcrResult | null>(null)
  const [copied, setCopied] = useState(false)

  function acceptFile(selected: File | null | undefined) {
    if (!selected) return
    const isPdfFile = selected.type === 'application/pdf'
    if (!selected.type.startsWith('image/') && !isPdfFile) {
      setStatus('error')
      setErrorMessage('Podporované sú fotografie, skeny (JPG, PNG) a súbory PDF.')
      return
    }
    if (imagePreview) URL.revokeObjectURL(imagePreview)
    setFile(selected)
    setPdfPages([])
    setIsPdf(isPdfFile)
    setResult(null)
    setCopied(false)
    setStatus('idle')
    setErrorMessage('')

    if (isPdfFile) {
      setImagePreview(null)
      setPreparing(true)
      pdfToJpegPages(selected)
        .then(({ pages }) => {
          if (pages.length === 0) {
            setStatus('error')
            setErrorMessage('PDF neobsahuje žiadne stránky.')
          }
          setPdfPages(pages)
        })
        .catch((error) => {
          console.error('Spracovanie PDF zlyhalo:', error)
          setStatus('error')
          setErrorMessage('PDF sa nepodarilo spracovať. Skúste ho nahrať ako fotografiu.')
        })
        .finally(() => setPreparing(false))
    } else {
      setImagePreview(URL.createObjectURL(selected))
    }
  }

  function onSelectFile(event: ChangeEvent<HTMLInputElement>) {
    acceptFile(event.target.files?.[0])
    event.target.value = ''
  }

  function onDropFile(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setDragging(false)
    acceptFile(event.dataTransfer.files?.[0])
  }

  async function handleRead() {
    if (!file) return
    setStatus('loading')
    setErrorMessage('')
    try {
      let sendPages: { imageBase64: string; mediaType: string }[]
      if (isPdf) {
        let pageUrls = pdfPages.map((page) => page.preview)
        if (anonymizeOn) {
          setAnonymizing(true)
          const anonymized: AnonymizeResult[] = []
          for (const url of pageUrls) anonymized.push(await anonymizeDataUrl(url))
          pageUrls = anonymized.map((item) => item.dataUrl)
          setPdfPages((pages) =>
            pages.map((page, index) => ({
              ...page,
              preview: pageUrls[index] ?? page.preview,
            })),
          )
          setMaskedZones(anonymized.flatMap((item) => item.maskedZones))
          setAnonymizing(false)
        }
        sendPages = pageUrls.map((url) => ({
          imageBase64: url.slice(url.indexOf(',') + 1),
          mediaType: 'image/jpeg',
        }))
      } else {
        let dataUrl = await fileToJpegDataUrl(file)
        if (anonymizeOn) {
          setAnonymizing(true)
          const anonymized = await anonymizeDataUrl(dataUrl)
          dataUrl = anonymized.dataUrl
          setMaskedZones(anonymized.maskedZones)
          setAnonymizing(false)
          setImagePreview(dataUrl)
        }
        sendPages = [
          {
            imageBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
            mediaType: 'image/jpeg',
          },
        ]
      }

      const outputs: OcrResult[] = []
      if (engine === 'offline') {
        for (const page of sendPages) {
          const fields = await ocrOfflineDataUrl(
            `data:${page.mediaType};base64,${page.imageBase64}`,
            anonymizeOn,
          )
          outputs.push({
            documentType: 'Osvedčenie o evidencii vozidla (lokálne OCR)',
            fields,
            notes: 'Čítané lokálne v prehliadači, bez odoslania do AI.',
            rawText: '',
          })
        }
      } else {
        for (const page of sendPages) {
          outputs.push((await ocrDocument(page)) as OcrResult)
        }
      }

      const first = outputs[0]
      const mergedNotes = outputs
        .map((output, index) =>
          output.notes
            ? outputs.length > 1
              ? `Str. ${pdfPages[index]?.pageNumber ?? index + 1}: ${output.notes}`
              : output.notes
            : '',
        )
        .filter(Boolean)
        .join(' | ')

      setResult({
        documentType: first.documentType,
        fields: outputs.flatMap((output) => output.fields),
        notes: mergedNotes,
        rawText: outputs
          .map((output) => output.rawText)
          .filter(Boolean)
          .join('\n\n'),
      })
      setStatus('ready')
    } catch (error) {
      console.error('OCR zlyhal:', error)
      setStatus('error')
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Doklad sa nepodarilo prečítať. Skúste to znova.',
      )
    }
  }

  function handleReset() {
    if (imagePreview) URL.revokeObjectURL(imagePreview)
    setFile(null)
    setIsPdf(false)
    setImagePreview(null)
    setPdfPages([])
    setMaskedZones([])
    setResult(null)
    setStatus('idle')
    setErrorMessage('')
    setCopied(false)
  }

  async function copyJson() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(false)
    }
  }

  function csvEscape(value: string) {
    return `"${value.replaceAll('"', '""')}"`
  }

  function downloadCsv() {
    if (!result) return
    const rows = [
      ['Pozícia', 'Hodnota', 'Časť', 'Istota'],
      ...result.fields.map((field) => [
        field.label,
        field.value,
        field.part,
        field.certainty,
      ]),
    ]
    // UTF-8 BOM so Excel/Windows software reads Slovak diacritics correctly.
    const csv =
      '\ufeff' + rows.map((row) => row.map(csvEscape).join(';')).join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'osvedcenie-ocr.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  function copyAsText() {
    if (!result) return
    const text = result.fields
      .map((field) => `${field.label}: ${field.value}`)
      .join('\n')
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2500)
      })
      .catch(() => setCopied(false))
  }

  const busy = status === 'loading' || anonymizing

  return (
    <div className="min-h-screen text-sea-ink font-body">
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-16">
        <header className="mb-8 sm:mb-12">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-stamp">
            Slovenské doklady · OCR
          </p>
          <h1 className="font-display text-4xl leading-tight font-semibold sm:text-5xl">
            Osvedčenie o evidencii vozidla
          </h1>
          <p className="mt-3 max-w-xl text-sea-ink-soft">
            Nahrajte fotografiu alebo sken osvedčenia (časť I aj časť II) a
            aplikácia prečíta text na doklade a vypíše z neho všetky údaje.
          </p>
        </header>

        <main data-testid="ocr-app" data-state={busy ? 'loading' : status}>
          <div
            className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3"
            role="radiogroup"
            aria-label="Spôsob čítania"
          >
            <span className="text-sm font-medium text-sea-ink">Spôsob čítania:</span>
            <button
              type="button"
              data-testid="mode-online"
              onClick={() => setEngine('online')}
              aria-pressed={engine === 'online'}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                engine === 'online'
                  ? 'bg-sea-ink text-foam'
                  : 'border border-line text-sea-ink-soft hover:bg-foam'
              }`}
            >
              AI (online)
            </button>
            <button
              type="button"
              data-testid="mode-offline"
              onClick={() => setEngine('offline')}
              aria-pressed={engine === 'offline'}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                engine === 'offline'
                  ? 'bg-sea-ink text-foam'
                  : 'border border-line text-sea-ink-soft hover:bg-foam'
              }`}
            >
              Lokálne (offline)
            </button>
            {engine === 'offline' && (
              <span className="text-xs text-sea-ink-soft">
                Beží v prehliadači, žiadne dáta sa neodosielajú. Prvé čítanie
                stiahne jazykové dáta, potom funguje aj bez internetu.
              </span>
            )}
          </div>
          <label className="mb-4 flex items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
            <input
              type="checkbox"
              data-testid="anonymize-toggle"
              checked={anonymizeOn}
              onChange={(event) => setAnonymizeOn(event.target.checked)}
              className="mt-0.5 size-4 accent-[hsl(189_47%_17%)]"
            />
            <span>
              <span className="font-medium text-sea-ink">
                Anonymizovať osobné údaje pred odoslaním
              </span>
              <span className="block text-xs text-sea-ink-soft">
                Mená, adresy, rodné čísla a pečiatky sa zatienia priamo vo vašom
                prehliadači, ešte pred odoslaním do AI. Obrázok sa spracúva
                lokálne.
              </span>
            </span>
          </label>
          <section className="rounded-xl border border-line bg-surface p-5 shadow-sm backdrop-blur sm:p-7">
            {!file ? (
              <label
                htmlFor="document-input"
                data-testid="upload-zone"
                className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors ${
                  dragging
                    ? 'border-stamp bg-foam'
                    : 'border-line hover:border-lagoon-deep hover:bg-foam'
                }`}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDropFile}
              >
                <span className="text-lagoon-deep">
                  <MagnifierIcon />
                </span>
                <span className="font-display text-xl font-medium">
                  Pretiahnite sem fotografiu dokladu
                </span>
                <span className="text-sm text-sea-ink-soft">
                  alebo kliknite pre výber zo zariadenia (JPG, PNG, PDF)
                </span>
                <input
                  ref={inputRef}
                  id="document-input"
                  data-testid="upload-input"
                  type="file"
                  accept="image/*,application/pdf"
                  className="sr-only"
                  onChange={onSelectFile}
                />
              </label>
            ) : (
              <div className="flex flex-col gap-5">
                {isPdf ? (
                  <div
                    className={`relative overflow-hidden rounded-lg border border-line bg-foam p-4 ${
                      busy ? 'scanline' : ''
                    }`}
                  >
                    {preparing ? (
                      <p className="py-10 text-center text-sm text-sea-ink-soft">
                        Spracúvam PDF…
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                        {pdfPages.map((page) => (
                          <figure
                            key={page.pageNumber}
                            className="overflow-hidden rounded-md border border-line"
                          >
                            <img
                              src={page.preview}
                              alt={`Strana ${page.pageNumber} dokladu`}
                              className="block w-full"
                            />
                            <figcaption className="px-2 py-1 text-center text-xs text-sea-ink-soft">
                              Strana {page.pageNumber}
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    )}
                    {busy && (
                      <span className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full bg-sea-ink px-4 py-1.5 text-sm font-medium text-foam">
                        Čítam doklad…
                      </span>
                    )}
                  </div>
                ) : (
                  <div
                    className={`relative overflow-hidden rounded-lg border border-line bg-foam ${
                      busy ? 'scanline' : ''
                    }`}
                  >
                    <img
                      src={imagePreview ?? undefined}
                      alt="Nahraný doklad"
                      className="mx-auto block max-h-[420px] w-auto"
                    />
                    {busy && (
                      <span className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full bg-sea-ink px-4 py-1.5 text-sm font-medium text-foam">
                        Čítam doklad…
                      </span>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="truncate text-sm text-sea-ink-soft">
                    <span className="inline-flex items-center gap-1.5 align-middle text-lagoon-deep">
                      <DocIcon />
                    </span>
                    <span className="ml-1.5 align-middle">{file?.name}</span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleReset}
                      disabled={busy}
                      className="rounded-md border border-line px-4 py-2 text-sm font-medium text-sea-ink-soft transition-colors hover:bg-foam disabled:opacity-50"
                    >
                      Zmeniť doklad
                    </button>
                    <button
                      type="button"
                      data-testid="read-button"
                      onClick={handleRead}
                      disabled={busy || preparing || (isPdf && pdfPages.length === 0)}
                      className="rounded-md bg-sea-ink px-5 py-2 text-sm font-semibold text-foam transition-colors hover:bg-lagoon-deep disabled:opacity-60"
                    >
                      {busy ? 'Čítam…' : result ? 'Čítať znova' : 'Prečítať údaje'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {status === 'error' && (
            <p
              data-testid="error-message"
              className="rise-in mt-5 rounded-lg border border-stamp/40 bg-stamp/10 px-4 py-3 text-sm font-medium text-stamp"
              role="alert"
            >
              {errorMessage}
            </p>
          )}

          {maskedZones.length > 0 && (
            <p
              data-testid="anonymize-info"
              className="rise-in mt-5 rounded-lg border border-palm/40 bg-foam px-4 py-3 text-sm text-palm"
            >
              Anonymizované lokálne v prehliadači: {maskedZones.length}{' '}
              {maskedZones.length === 1 ? 'oblasť' : 'oblastí'} osobných údajov
              ({[...new Set(maskedZones)].slice(0, 6).join(', ')}). Zamazané
              časti sa vo výsledku vypíšu ako (anonymizované).
            </p>
          )}

          {result && (
            <section
              data-testid="ocr-result"
              data-state={status === 'error' ? 'error' : status}
              className="rise-in mt-6 rounded-xl border border-line bg-surface-strong p-5 shadow-sm sm:p-7"
            >
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-[0.28em] text-stamp">
                    Výsledok čítania
                  </p>
                  <h2 className="font-display text-2xl font-semibold">
                    {result.documentType}
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="copy-text"
                    onClick={copyAsText}
                    className="rounded-md border border-line px-4 py-2 text-sm font-medium text-sea-ink transition-colors hover:bg-foam"
                  >
                    {copied ? 'Skopírované ✓' : 'Kopírovať zoznam'}
                  </button>
                  <button
                    type="button"
                    data-testid="download-csv"
                    onClick={downloadCsv}
                    className="rounded-md border border-line px-4 py-2 text-sm font-medium text-sea-ink transition-colors hover:bg-foam"
                  >
                    Stiahnuť CSV
                  </button>
                  <button
                    type="button"
                    onClick={copyJson}
                    className="rounded-md border border-line px-4 py-2 text-sm font-medium text-sea-ink transition-colors hover:bg-foam"
                  >
                    Kopírovať JSON
                  </button>
                </div>
              </div>

              {result.notes && (
                <p className="mb-5 rounded-lg bg-foam px-4 py-3 text-sm text-sea-ink-soft italic">
                  {result.notes}
                </p>
              )}

              {groupFields(result.fields).map(({ part, fields }) => (
                <div key={part} className="mb-5 last:mb-0">
                  {part !== 'neuvedené' && (
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.28em] text-lagoon-deep">
                      {part}
                    </p>
                  )}
                  <dl className="overflow-hidden rounded-lg border border-line">
                    {fields.map((field, index) => (
                      <div
                        key={`${field.label}-${index}`}
                        className={`grid gap-1 px-4 py-3 sm:grid-cols-[1fr_1.4fr] sm:gap-4 ${
                          index !== fields.length - 1
                            ? 'border-b border-dashed border-line'
                            : ''
                        }`}
                      >
                        <dt className="text-sm text-sea-ink-soft">
                          {field.label}
                        </dt>
                        <dd className="text-sm font-medium break-words text-sea-ink sm:text-right">
                          {field.value}
                          <span
                            className={`ml-2 align-middle text-xs font-normal italic ${certaintyClass(field.certainty)}`}
                          >
                            ({field.certainty})
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
              {result.fields.length === 0 && (
                <p className="text-sm text-sea-ink-soft">
                  Z dokladu sa nepodarilo vyčleniť žiadne konkrétne údaje.
                </p>
              )}

              {result.rawText && (
                <details className="mt-5 rounded-lg border border-line bg-foam px-4 py-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Zobraziť nespracovaný text
                  </summary>
                  <pre className="mt-3 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap text-sea-ink-soft">
                    {result.rawText}
                  </pre>
                </details>
              )}
            </section>
          )}

          <footer className="mt-10 text-center text-xs text-sea-ink-soft">
            Údaje sú čítané automaticky (OCR). Pred použitím ich vždy skontrolujte
            s pôvodným dokladom.
          </footer>
        </main>
      </div>
    </div>
  )
}
