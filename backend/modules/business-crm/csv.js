'use strict';

function encode(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function toCsv(rows, columns) {
  return [columns.map(encode).join(','), ...rows.map((row) => columns.map((column) => encode(row[column])).join(','))].join('\r\n');
}
function parseCsv(source, options = {}) {
  const maxRows = options.maxRows || 2000;
  const rows = []; let row = []; let field = ''; let quoted = false;
  const input = String(source || '').replace(/^\uFEFF/, '');
  for (let index = 0; index <= input.length; index += 1) {
    const char = input[index] ?? '\n';
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') {
      row.push(field.replace(/\r$/, '')); field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) throw Object.assign(new Error(`CSV exceeds ${maxRows} data rows`), { status: 400 });
    } else field += char;
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => header.trim());
  if (!headers.every(Boolean) || new Set(headers).size !== headers.length) throw Object.assign(new Error('CSV headers must be unique and non-empty'), { status: 400 });
  return rows.map((values, index) => Object.fromEntries([...headers.map((header, position) => [header, values[position] ?? '']), ['__row', index + 2]]));
}
module.exports = { encode, toCsv, parseCsv };
