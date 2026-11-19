/* Text recognition for "Edit text". Tesseract.js is loaded only when first used; its worker, core and
 * English + Hindi language data come from its CDN (needs internet the first time). */
import type { Worker } from 'tesseract.js'

let worker: Promise<Worker> | null = null

function getWorker(): Promise<Worker> {
  if (!worker) {
    worker = import('tesseract.js').then((T) => T.createWorker(['eng', 'hin'], 1))
    worker.catch(() => { worker = null })
  }
  return worker
}

/** Recognises the text in a canvas. Rejects after `ms` milliseconds. */
export async function recognise(c: HTMLCanvasElement, ms = 60000): Promise<string> {
  const timeout = new Promise<never>((_, bad) => setTimeout(() => bad(new Error('timeout')), ms))
  const w = await Promise.race([getWorker(), timeout])
  const { data } = await Promise.race([w.recognize(c), timeout])
  return (data.text || '').replace(/\n{3,}/g, '\n\n').trim()
}
