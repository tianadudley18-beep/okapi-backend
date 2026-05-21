import ExcelJS from 'exceljs'
import { Readable } from 'stream'
import csvParser from 'csv-parser'
import path from 'path'

const MAX_ROWS = 50_000

// ── Encoding ────────────────────────────────────────────────────────────────
function decodeBuffer(buffer) {
  const utf8 = buffer.toString('utf-8')
  // If no replacement characters, UTF-8 is clean
  if (!utf8.includes('\uFFFD')) return utf8
  // Try Windows-1252 (covers most European encodings)
  try {
    return new TextDecoder('windows-1252').decode(buffer)
  } catch {
    return buffer.toString('latin1')
  }
}

// ── CSV delimiter detection ──────────────────────────────────────────────────
function detectDelimiter(sample) {
  const lines = sample.split('\n').filter(l => l.trim()).slice(0, 10)
  if (!lines.length) return ','

  const candidates = [',', ';', '\t', '|']
  const scores = candidates.map(d => {
    const counts = lines.map(l => (l.match(new RegExp('\\' + d === '\\,' ? ',' : d, 'g')) || []).length)
    const avg = counts.reduce((s, c) => s + c, 0) / counts.length
    // Prefer delimiters with consistent counts across lines
    const variance = counts.reduce((s, c) => s + Math.abs(c - avg), 0) / counts.length
    return { d, avg, variance }
  })

  // Pick the one with highest average count and low variance
  const best = scores
    .filter(s => s.avg > 0)
    .sort((a, b) => (b.avg - b.variance * 0.5) - (a.avg - a.variance * 0.5))[0]

  return best?.d || ','
}

// ── Key normalization ────────────────────────────────────────────────────────
function normalizeKey(key) {
  if (!key && key !== 0) return 'col'
  return String(key)
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '')
    || 'col'
}

// ── Header detection ─────────────────────────────────────────────────────────
function detectHasHeader(rows) {
  if (!rows.length) return true
  const firstRowVals = Object.values(rows[0])
  // If all first-row values look like numbers, probably no header
  const numericCount = firstRowVals.filter(v => {
    const s = String(v ?? '').trim().replace(/[$€£,.\s]/g, '')
    return s.length > 0 && !isNaN(parseFloat(s))
  }).length
  return numericCount < firstRowVals.length * 0.7
}

// ── Empty row/column filtering ───────────────────────────────────────────────
function isRowEmpty(obj) {
  return Object.values(obj).every(v => v === null || v === undefined || String(v).trim() === '')
}

function filterEmptyColumns(rows) {
  if (!rows.length) return rows
  const allKeys = Object.keys(rows[0])
  // Keep a column if at least 10% of rows have a non-empty value
  const threshold = Math.max(1, rows.length * 0.1)
  const keepCols = allKeys.filter(k => {
    const nonEmpty = rows.filter(r => r[k] !== null && r[k] !== undefined && String(r[k]).trim() !== '')
    return nonEmpty.length >= threshold
  })
  if (keepCols.length === allKeys.length) return rows
  return rows.map(r => {
    const obj = {}
    keepCols.forEach(k => { obj[k] = r[k] })
    return obj
  })
}

// ── Row normalization ────────────────────────────────────────────────────────
function normalizeRows(rawRows) {
  const warnings = []
  if (!rawRows.length) return { rows: [], columns: [], warnings: ['File has no data rows.'] }

  // Filter empty rows
  const nonEmpty = rawRows.filter(r => !isRowEmpty(r))
  const skipped = rawRows.length - nonEmpty.length
  if (skipped > 0) warnings.push(`${skipped} empty rows were skipped.`)

  if (!nonEmpty.length) return { rows: [], columns: [], warnings: ['File contains only empty rows.'] }

  // Check for header row
  if (!detectHasHeader(nonEmpty)) {
    warnings.push('No column headers detected — synthetic headers were added.')
    const syntheticHeaders = Object.keys(nonEmpty[0]).map((_, i) => `Column_${i + 1}`)
    const reMapped = nonEmpty.map(row => {
      const vals = Object.values(row)
      const obj = {}
      syntheticHeaders.forEach((h, i) => { obj[h] = vals[i] ?? null })
      return obj
    })
    return normalizeRows(reMapped) // recurse with new headers
  }

  // Build deduplicated key map
  const keyCount = {}
  const keyMap = {}
  for (const key of Object.keys(nonEmpty[0])) {
    let clean = normalizeKey(key)
    if (!clean) clean = 'col'
    const base = clean
    let n = keyCount[base] || 0
    if (n > 0) clean = `${base}_${n}`
    keyCount[base] = n + 1
    keyMap[key] = clean
  }

  // Normalize rows with per-row error isolation
  const normalized = []
  let rowErrors = 0
  for (const row of nonEmpty) {
    try {
      const obj = {}
      for (const [key, val] of Object.entries(row)) {
        const nk = keyMap[key] || normalizeKey(key)
        // Unwrap ExcelJS rich text objects
        if (val && typeof val === 'object' && val.richText) {
          obj[nk] = val.richText.map(r => r.text).join('')
        } else if (val && typeof val === 'object' && val.text) {
          obj[nk] = val.text
        } else {
          obj[nk] = val ?? null
        }
      }
      normalized.push(obj)
    } catch {
      rowErrors++
    }
  }

  if (rowErrors > 0) warnings.push(`${rowErrors} rows had formatting issues and were skipped.`)

  // Filter empty columns
  const filtered = filterEmptyColumns(normalized)
  const columns = Object.keys(filtered[0] || {})

  if (columns.length < 2) {
    warnings.push('File has fewer than 2 usable columns — insights may be limited.')
  }

  return { rows: filtered, columns, warnings }
}

// ── Excel parser ──────────────────────────────────────────────────────────────
async function parseExcel(buffer) {
  const workbook = new ExcelJS.Workbook()

  // Try xlsx first, fall back to csv-style read
  try {
    await workbook.xlsx.load(buffer)
  } catch (e) {
    throw new Error('Could not read Excel file. Please re-save it as .xlsx or .csv and try again.')
  }

  if (!workbook.worksheets.length) {
    return { rows: [], columns: [], warnings: ['No worksheets found in file.'] }
  }

  // Pick the sheet with the most data rows
  const sheet = workbook.worksheets.reduce((best, ws) => {
    const rc = ws.actualRowCount || ws.rowCount || 0
    return rc > (best?.actualRowCount || best?.rowCount || 0) ? ws : best
  })

  const raw = []
  let headers = []
  let headerRowNum = -1

  // Scan first 10 rows to find actual header row (skip truly empty rows at top)
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRowNum >= 0) return // already found header
    const values = row.values.slice(1)
    if (values.some(v => v !== null && v !== undefined && String(v).trim() !== '')) {
      headers = values.map(v => {
        if (v && typeof v === 'object' && v.richText) return v.richText.map(r => r.text).join('')
        if (v && typeof v === 'object' && v.text) return v.text
        return String(v ?? '').trim()
      })
      headerRowNum = rowNumber
    }
  })

  if (headers.length === 0) {
    return { rows: [], columns: [], warnings: ['No data found in the Excel file.'] }
  }

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNum) return
    if (raw.length >= MAX_ROWS) return

    const obj = {}
    headers.forEach((h, i) => {
      const cell = row.getCell(i + 1)
      if (cell.type === ExcelJS.ValueType.Date) {
        obj[h] = cell.value
      } else if (cell.type === ExcelJS.ValueType.Formula) {
        obj[h] = cell.result ?? null
      } else if (cell.value && typeof cell.value === 'object' && cell.value.richText) {
        obj[h] = cell.value.richText.map(r => r.text).join('')
      } else {
        obj[h] = row.values[i + 1] ?? null
      }
    })
    raw.push(obj)
  })

  const result = normalizeRows(raw)

  if (raw.length >= MAX_ROWS) {
    result.warnings.push(`File has more than ${MAX_ROWS.toLocaleString()} rows — only the first ${MAX_ROWS.toLocaleString()} were analyzed.`)
  }

  return result
}

// ── CSV parser ───────────────────────────────────────────────────────────────
function parseCsv(buffer) {
  return new Promise((resolve) => {
    const content = decodeBuffer(buffer)
    const delimiter = detectDelimiter(content.slice(0, 2000))

    const rows = []
    const warnings = []

    const stream = Readable.from(content)
    stream
      .pipe(csvParser({ separator: delimiter, skipEmptyLines: true }))
      .on('data', (row) => {
        if (rows.length < MAX_ROWS) rows.push(row)
      })
      .on('end', () => {
        if (rows.length >= MAX_ROWS) {
          warnings.push(`File has more than ${MAX_ROWS.toLocaleString()} rows — only the first ${MAX_ROWS.toLocaleString()} were analyzed.`)
        }
        const result = normalizeRows(rows)
        result.warnings.push(...warnings)
        resolve(result)
      })
      .on('error', (err) => {
        // Retry with comma if original delimiter failed
        if (delimiter !== ',') {
          const fallbackRows = []
          const fallbackStream = Readable.from(content)
          fallbackStream
            .pipe(csvParser({ separator: ',', skipEmptyLines: true }))
            .on('data', r => fallbackRows.push(r))
            .on('end', () => {
              const result = normalizeRows(fallbackRows)
              result.warnings.push('Delimiter was auto-corrected.')
              resolve(result)
            })
            .on('error', () => resolve({ rows: [], columns: [], warnings: ['CSV could not be parsed. Please check file format.'] }))
        } else {
          resolve({ rows: [], columns: [], warnings: [`CSV parse error: ${err.message}`] })
        }
      })
  })
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function parseFile(buffer, originalName) {
  const ext = path.extname(originalName).toLowerCase()

  if (ext === '.xlsx' || ext === '.xls') {
    if (ext === '.xls') {
      // Return helpful error for old format
      return {
        rows: [],
        columns: [],
        warnings: [],
        error: 'Old Excel format (.xls) is not supported. Please open the file in Excel, save it as .xlsx, and upload again.'
      }
    }
    return parseExcel(buffer)
  }

  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    return parseCsv(buffer)
  }

  // Try to detect format from content
  const header = buffer.slice(0, 4).toString('hex')
  if (header.startsWith('504b')) return parseExcel(buffer)  // PK magic = ZIP/XLSX
  if (buffer[0] === 0xD0 && buffer[1] === 0xCF) {
    return {
      rows: [], columns: [], warnings: [],
      error: 'Old Excel format (.xls) is not supported. Please save as .xlsx and try again.'
    }
  }

  return parseCsv(buffer)
}
