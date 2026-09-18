/* Сборка .docx для инструкций: общие стили, картинки, таблицы, нумерация. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { here } from './lib.mjs';

const require = createRequire(import.meta.url);
export const docx = require('docx');
const { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, LevelFormat, Packer, PageBreak,
  PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType, VerticalAlign } = docx;

export const SHOTS = join(here, 'shots');
const CM = 567;                    // DXA в сантиметре
const PAGE_W = 11906, MARGIN = 1134;   // A4, поля 2 см
export const TEXT_W = PAGE_W - 2 * MARGIN;   // 9638 DXA ≈ 17 см
const FONT = 'Calibri';
const INK = '1F1F1F', MUTED = '5A5A5A', LINE = 'C9C9C9', WASH = 'F3F3F1', WARN = 'FFF4E0', OK = 'EAF5EC';

/* ---------- текст: **жирный** и `код` внутри строки ---------- */
export function runs(text, base = {}) {
  if (Array.isArray(text)) return text;
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const t = m[0];
    if (t.startsWith('**')) out.push(new TextRun({ text: t.slice(2, -2), bold: true, ...base }));
    else out.push(new TextRun({ text: t.slice(1, -1), font: 'Consolas', ...base }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out;
}

export const p = (text, o = {}) => new Paragraph({ children: runs(text, o.run || {}), spacing: { after: 120, line: 276 }, ...o.para });
export const note = (text) => new Paragraph({ children: runs(text, { color: MUTED, size: 20 }), spacing: { after: 120 } });
export const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)], spacing: { before: 360, after: 160 } });
export const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)], spacing: { before: 240, after: 120 } });
export const h3 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(text)], spacing: { before: 200, after: 80 } });
export const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

let listInstance = 0;
/** Нумерованные шаги — каждый список начинается с единицы. */
export function steps(items) {
  const instance = ++listInstance;
  return items.map((t) => new Paragraph({
    children: runs(t), numbering: { reference: 'steps', level: 0, instance },
    spacing: { after: 80, line: 276 },
  }));
}
export const bullets = (items) => items.map((t) => new Paragraph({
  children: runs(t), numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60, line: 276 },
}));

/* ---------- картинки ---------- */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('не PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
/** Скриншот из shots/: ширина в сантиметрах (по умолчанию — на всю строку,
 *  но не крупнее натурального размера при масштабе 1.25 / 2). */
export function img(name, { width, scale } = {}) {
  const file = join(SHOTS, name + '.png');
  if (!existsSync(file)) throw new Error(`Нет скриншота ${name}.png — запустите shots.mjs`);
  const buf = readFileSync(file);
  const { w, h } = pngSize(buf);
  const dpr = scale || (name.startsWith('vf-') ? 2 : 1.25);
  const naturalCm = w / dpr / 96 * 2.54;
  const cm = Math.min(width || 17, naturalCm, 17);
  const px = Math.round(cm / 2.54 * 96);
  return new Paragraph({
    children: [new ImageRun({ type: 'png', data: buf, transformation: { width: px, height: Math.round(px * h / w) } })],
    spacing: { before: 60, after: 60 }, keepNext: true,
  });
}
export const caption = (text) => new Paragraph({
  children: runs(text, { color: MUTED, size: 18, italics: true }), spacing: { after: 200 },
});
/** Картинка с подписью. */
export const figure = (name, text, o) => [img(name, o), caption(text)];

/* ---------- таблицы ---------- */
const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const borders = { top: border, bottom: border, left: border, right: border };
function cell(content, width, o = {}) {
  const children = (Array.isArray(content) ? content : [content]).map((c) =>
    typeof c === 'string' ? new Paragraph({ children: runs(c, o.run || {}), spacing: { after: 60, line: 264 } }) : c);
  return new TableCell({
    children, width: { size: width, type: WidthType.DXA }, borders,
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    margins: { top: 80, bottom: 80, left: 110, right: 110 }, verticalAlign: VerticalAlign.TOP,
  });
}
/** Таблица: заголовок и строки; ширины — доли от ширины текста. */
export function table(header, rows, fractions) {
  const widths = fractions.map((f) => Math.round(TEXT_W * f));
  const sum = widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] += TEXT_W - sum;
  return new Table({
    width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: header.map((t, i) => cell(t, widths[i], { fill: WASH, run: { bold: true } })) }),
      ...rows.map((r) => new TableRow({ children: r.map((t, i) => cell(t, widths[i])) })),
    ],
  });
}
/** Раздел «Что делать, если»: ситуация → что делать. */
export const ifTable = (rows) => table(['Ситуация', 'Что делать'], rows, [0.36, 0.64]);

/** Плашка на всю ширину: адрес системы, предупреждение, важное. */
export function box(lines, { fill = WASH } = {}) {
  const children = lines.map((l) => typeof l === 'string'
    ? new Paragraph({ children: runs(l), spacing: { after: 60, line: 276 } }) : l);
  return new Table({
    width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: [TEXT_W],
    rows: [new TableRow({ children: [new TableCell({
      children, width: { size: TEXT_W, type: WidthType.DXA }, borders,
      shading: { type: ShadingType.CLEAR, fill, color: 'auto' }, margins: { top: 140, bottom: 120, left: 200, right: 200 },
    })] })],
  });
}
export const warn = (lines) => box(lines, { fill: WARN });
export const good = (lines) => box(lines, { fill: OK });
export const gap = (after = 160) => new Paragraph({ children: [], spacing: { after } });

/* ---------- документ ---------- */
/** Титульный блок: название, кому, адрес системы (единственное место с адресом). */
export function titleBlock({ title, who, address, support, version }) {
  return [
    new Paragraph({ children: [new TextRun({ text: 'CRM «Учёткин»', color: MUTED, size: 22, characterSpacing: 40 })], spacing: { before: 600, after: 60 } }),
    new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 52 })], spacing: { after: 120 } }),
    new Paragraph({ children: [new TextRun({ text: who, size: 24, color: MUTED })], spacing: { after: 360 } }),
    box([
      `**Адрес системы:** ${address}`,
      'Откройте его в браузере на компьютере или телефоне. Логин и пароль выдаёт руководитель.',
      `**Поддержка:** ${support}`,
    ]),
    gap(120),
    note(`Версия инструкции: ${version}. Адрес системы указан только здесь — при переезде на постоянный домен меняется одна эта строка.`),
  ];
}

export function buildDoc({ file, title, children }) {
  const doc = new Document({
    creator: 'CRM «Учёткин»', title, description: 'Инструкция пользователя CRM «Учёткин»',
    styles: {
      default: { document: { run: { font: FONT, size: 22, color: INK } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 32, bold: true, color: INK, font: FONT }, paragraph: { spacing: { before: 360, after: 160 }, keepNext: true, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, color: INK, font: FONT }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 1 } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 23, bold: true, color: INK, font: FONT }, paragraph: { spacing: { before: 200, after: 80 }, keepNext: true, outlineLevel: 2 } },
      ],
    },
    numbering: {
      config: [
        { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 567, hanging: 340 } } } }] },
        { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 567, hanging: 283 } } } }] },
      ],
    },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: `${title} · стр. `, color: MUTED, size: 18 }),
          new TextRun({ children: [PageNumber.CURRENT], color: MUTED, size: 18 }),
          new TextRun({ text: ' из ', color: MUTED, size: 18 }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], color: MUTED, size: 18 })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc).then((buf) => ({ file, buf }));
}
