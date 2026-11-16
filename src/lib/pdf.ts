/** Counts pages of a PDF in the browser. pdf.js is loaded only when needed. */
export async function countPdfPages(file: File): Promise<number> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjs.getDocument({ data }).promise
  const n = doc.numPages
  await doc.destroy()
  return n
}
