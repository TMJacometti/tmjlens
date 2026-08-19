import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildClusterReport, reportFileName } from '../lib/report';
import type { ClusterOverview } from '../types/cluster';
import type { EnvironmentId } from '../types/settings';

pdfjs.GlobalWorkerOptions.workerSrc = workerSource;

/**
 * Renders every page of the generated PDF to a canvas.
 *
 * The browser's own PDF viewer ignores fit parameters on a blob URL and crops the
 * page, which makes it useless for reviewing a layout. Rasterising each page with
 * pdf.js shows the whole sheet, deterministically, at a scale review can read.
 * Preview-only: the app writes the same bytes straight to Downloads.
 */
export function ReportPreview({ data, environment }: { data: ClusterOverview; environment: EnvironmentId }) {
  const host = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState('');

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      const pdf = buildClusterReport(data, environment);
      const bytes = pdf.output('arraybuffer');
      setMeta(`${reportFileName(data)}.pdf · ${pdf.getNumberOfPages()} pages · ${(bytes.byteLength / 1024).toFixed(0)} KB`);
      (window as unknown as { __report__: string }).__report__ = pdf.output('datauristring');

      const document_ = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      if (cancelled || !host.current) return;
      host.current.replaceChildren();

      for (let number = 1; number <= document_.numPages; number += 1) {
        const page = await document_.getPage(number);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.cssText = 'width:794px;display:block;margin:0 auto 20px;box-shadow:0 6px 20px #0008';
        host.current.append(canvas);
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      }
      (window as unknown as { __rendered__: boolean }).__rendered__ = true;
    };

    void render();
    return () => {
      cancelled = true;
    };
  }, [data, environment]);

  return (
    <div style={{ minHeight: '100vh', background: '#22252b', padding: 20 }}>
      <div style={{ color: '#aeb7c4', fontSize: 12, marginBottom: 16, textAlign: 'center' }}>{meta}</div>
      <div ref={host} />
    </div>
  );
}
