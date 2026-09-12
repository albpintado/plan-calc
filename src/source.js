import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PDF_RENDER_WIDTH = 3200;
const MAX_PDF_RENDER_SCALE = 5;

export function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

async function rasterizePdfPage(pdfDoc, pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(MAX_PDF_RENDER_SCALE, Math.max(1, MAX_PDF_RENDER_WIDTH / base.width));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: context, viewport, canvas }).promise;
  return createImageBitmap(canvas);
}

export async function createPdfSource(file) {
  const data = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  const bitmap = await rasterizePdfPage(pdfDoc, 1);
  return {
    kind: 'pdf',
    name: file.name,
    blob: file,
    pdfDoc,
    page: 1,
    pageCount: pdfDoc.numPages,
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
  };
}

export async function createImageSource(file) {
  const bitmap = await createImageBitmap(file);
  return {
    kind: 'image',
    name: file.name,
    blob: file,
    pdfDoc: null,
    page: 1,
    pageCount: 1,
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
  };
}

export async function createSource(file) {
  return isPdfFile(file) ? createPdfSource(file) : createImageSource(file);
}

export async function goToPage(source, pageNumber) {
  if (!source.pdfDoc) return source;
  const page = Math.max(1, Math.min(source.pageCount, pageNumber));
  const bitmap = await rasterizePdfPage(source.pdfDoc, page);
  if (source.bitmap && source.bitmap.close) source.bitmap.close();
  return { ...source, page, bitmap, width: bitmap.width, height: bitmap.height };
}

export async function releaseSource(source) {
  if (!source) return;
  if (source.bitmap && source.bitmap.close) source.bitmap.close();
  if (source.pdfDoc) await source.pdfDoc.destroy();
}
