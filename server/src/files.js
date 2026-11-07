import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { config } from './config.js';
import { HttpError } from './errors.js';

const OFFICE_EXT = new Set(['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.odp', '.ods', '.rtf']);
const A4 = [595.28, 841.89];

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
const isPdf = (b) => b.subarray(0, 1024).toString('latin1').includes('%PDF-');
const isPng = (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]);
const isJpeg = (b) => startsWith(b, [0xff, 0xd8, 0xff]);
const isZip = (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
const isOle = (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]);
const isRtf = (b) => b.subarray(0, 5).toString('latin1') === '{\\rtf';

async function imageToPdf(buffer, png) {
  const doc = await PDFDocument.create();
  const img = png ? await doc.embedPng(buffer) : await doc.embedJpg(buffer);
  const page = doc.addPage(A4);
  const margin = 24;
  const scale = Math.min((A4[0] - margin * 2) / img.width, (A4[1] - margin * 2) / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
  return Buffer.from(await doc.save());
}

function sofficeConvert(inputPath, outDir, profileDir) {
  return new Promise((resolve, reject) => {
    execFile(
      config.sofficePath,
      [`-env:UserInstallation=file://${profileDir}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, inputPath],
      { timeout: 90_000 },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function officeToPdf(buffer, ext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'printsaas-'));
  try {
    const input = path.join(dir, `input${ext}`);
    await fs.writeFile(input, buffer);
    try {
      await sofficeConvert(input, dir, path.join(dir, 'profile'));
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new HttpError(415, 'This server can only print PDF and image files right now');
      }
      throw new HttpError(422, 'We could not convert this document. Please upload it as a PDF');
    }
    return await fs.readFile(path.join(dir, 'input.pdf'));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, 'We could not convert this document. Please upload it as a PDF');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Returns { pdf: Buffer, pageCount } or throws HttpError. Never trusts the client's mime type. */
export async function normalizeUpload(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  let pdf;

  if (isPdf(buffer)) pdf = buffer;
  else if (isPng(buffer)) pdf = await imageToPdf(buffer, true);
  else if (isJpeg(buffer)) pdf = await imageToPdf(buffer, false);
  else if (OFFICE_EXT.has(ext) && (isZip(buffer) || isOle(buffer) || isRtf(buffer))) pdf = await officeToPdf(buffer, ext);
  else throw new HttpError(415, 'Unsupported file. Upload a PDF, image (JPG/PNG), Word, PowerPoint or Excel file');

  let pageCount;
  try {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: false });
    pageCount = doc.getPageCount();
  } catch (e) {
    if (/encrypted/i.test(String(e.message))) {
      throw new HttpError(422, 'This PDF is password protected. Remove the password and upload again');
    }
    throw new HttpError(422, 'This file looks damaged. Please upload it again');
  }
  if (pageCount < 1) throw new HttpError(422, 'This file has no pages');
  if (pageCount > config.maxPages) throw new HttpError(422, `This file has ${pageCount} pages. The limit is ${config.maxPages}`);
  return { pdf: Buffer.from(pdf), pageCount };
}

export const randomId = () => crypto.randomUUID();
