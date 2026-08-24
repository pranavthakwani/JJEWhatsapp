import xlsx from 'xlsx';

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
