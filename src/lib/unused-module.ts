/**
 * Stand-in for jsPDF's optional dependencies.
 *
 * jsPDF references html2canvas, canvg and dompurify to support rasterising HTML and
 * SVG into a document. The report is drawn entirely with vector primitives, so none
 * of those paths ever run — but the bundler cannot know that and was shipping around
 * 360 kB of them. Aliasing them here keeps the report chunk to what it actually uses.
 *
 * If a future report needs `pdf.html()` or SVG embedding, remove the alias in
 * vite.config.ts rather than working around this file.
 */
export default undefined;
