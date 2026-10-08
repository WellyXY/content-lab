import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import readExcelFile from 'read-excel-file/node';
import { extractTikTokUrls, linksFromSheets } from '../lib/import-links.ts';

const csv = readFileSync(new URL('../../docs/source-imports/framelab-vn.csv', import.meta.url), 'utf8');
const urls = csv.trim().split('\n').slice(1).map((row) => row.split(',')[0]);
assert.equal(urls.length, 13);
assert.deepEqual(extractTikTokUrls(csv), urls);
assert.equal(extractTikTokUrls('https://eviltiktok.com/@x/video/123').length, 0);
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const files = {
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Videos" sheetId="1" r:id="rId1"/><sheet name="More" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
};
for (const [index, rows] of [urls.slice(0, 6), urls.slice(6)].entries()) {
  files[`xl/worksheets/sheet${index + 1}.xml`] = `<worksheet xmlns="${ns}"><sheetData>${rows.map((url, i) => `<row r="${i+1}"><c r="A${i+1}" t="inlineStr"><is><t>${url}</t></is></c></row>`).join('')}</sheetData></worksheet>`;
}
const workbook = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, xml]) => [path, strToU8(xml)]))));
const sheets = await readExcelFile(workbook);
assert.equal(sheets.length, 2);
assert.deepEqual(linksFromSheets(sheets), urls);
assert.equal(extractTikTokUrls(Array.from({ length: 51 }, (_, i) => `https://www.tiktok.com/@a/video/${i+1}`).join('\n')).length, 51);
console.log('CSV and two-sheet XLSX: all 13 source URLs preserved; invalid domains rejected; no silent truncation.');
