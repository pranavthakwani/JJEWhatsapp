import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';

const SHEET_NAME = 'Sheet2';
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const workbookCandidates = [
  path.resolve(moduleDir, '../../../Phone Contacts Business.xlsx'),
  path.resolve(process.cwd(), '../../Phone Contacts Business.xlsx'),
  path.resolve(process.cwd(), '../Phone Contacts Business.xlsx'),
  path.resolve(process.cwd(), 'Phone Contacts Business.xlsx'),
];

function normalizePhone(value) {
  if (value == null) return null;
  const digitsOnly = String(value).replace(/\D/g, '');
  return digitsOnly || null;
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function resolveWorkbookPath() {
  return workbookCandidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function parseRows(rawRows = []) {
  const deduped = new Map();

  for (const row of rawRows) {
    const name = cleanName(
      row.Name
      || row.name
      || row['Contact Name']
      || row.contact_name
      || row['Company Name']
      || row.company_name,
    );

    const phone = normalizePhone(
      row['Mobile Number']
      || row.mobile
      || row.Mobile
      || row.phone
      || row.Phone
      || row.Number
      || row.number,
    );

    if (!phone) continue;
    deduped.set(phone, {
      waId: phone,
      phoneNumber: phone,
      profileName: name || phone,
      source: 'business-directory',
    });
  }

  return [...deduped.values()];
}

export function parseBusinessDirectoryWorkbook() {
  const workbookPath = resolveWorkbookPath();
  if (!workbookPath) {
    throw new Error(`Phone Contacts Business.xlsx not found. Checked: ${workbookCandidates.join(', ')}`);
  }

  const workbook = xlsx.readFile(workbookPath);
  const worksheet = workbook.Sheets[SHEET_NAME];
  if (!worksheet) {
    throw new Error(`Sheet "${SHEET_NAME}" not found in ${workbookPath}`);
  }

  const rawRows = xlsx.utils.sheet_to_json(worksheet, { defval: null });
  return {
    workbookPath,
    contacts: parseRows(rawRows),
  };
}

export function parseUploadedWorkbook(buffer, options = {}) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = options.sheetName && workbook.Sheets[options.sheetName]
    ? options.sheetName
    : workbook.SheetNames[0];

  if (!sheetName) {
    return {
      sheetNames: [],
      activeSheet: null,
      contacts: [],
    };
  }

  const worksheet = workbook.Sheets[sheetName];
  const rawRows = xlsx.utils.sheet_to_json(worksheet, { defval: null });

  return {
    sheetNames: workbook.SheetNames,
    activeSheet: sheetName,
    contacts: parseRows(rawRows),
  };
}
