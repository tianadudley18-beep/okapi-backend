// ── Safe math helpers ────────────────────────────────────────────────────────
function safeNum(v, fallback = 0) {
  if (v === null || v === undefined) return fallback
  const n = typeof v === 'number' ? v : parseFloat(v)
  return isFinite(n) ? n : fallback
}

function safeDiv(a, b, fallback = 0) {
  const bn = safeNum(b)
  if (bn === 0) return fallback
  const result = safeNum(a) / bn
  return isFinite(result) ? result : fallback
}

function safePct(part, whole) {
  return parseFloat(safeDiv(part * 100, whole, 0).toFixed(2))
}

// ── Universal numeric parser ─────────────────────────────────────────────────
// Returns null for unparseable values (distinguishes "no data" from true zero)
// Works with ANY currency symbol or code from any country.
export function parseUniversalNumber(value) {
  // Already a JS float from ExcelJS — use directly, never re-parse
  if (typeof value === 'number') return isNaN(value) ? null : value

  if (value instanceof Date) return null
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0

  if (typeof value === 'string') {
    let s = value.trim()
    if (!s || s === '-' || s.toLowerCase() === 'n/a') return null

    // Parentheses for negatives: (1,234) → -1234
    if (s.startsWith('(') && s.endsWith(')')) s = '-' + s.slice(1, -1).trim()

    // Strip any non-numeric prefix (handles $, €, £, U$S, ARS, R$, ¥, ₹, etc.)
    s = s.replace(/^[^0-9\-\.]+/, '')
    // Strip any non-numeric suffix (handles trailing symbols, codes, spaces)
    s = s.replace(/[^0-9\.,\-]+$/, '').trim()

    if (!s || s === '-') return null

    if (s.includes(',') && s.includes('.')) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        s = s.replace(/\./g, '').replace(',', '.') // European: 1.234,56
      } else {
        s = s.replace(/,/g, '')                    // American: 1,234.56
      }
    } else if (s.includes(',')) {
      const parts = s.split(',')
      if (parts[parts.length - 1].length <= 2) {
        s = s.replace(',', '.')  // Decimal comma: 1234,56 → 1234.56
      } else {
        s = s.replace(/,/g, '')  // Thousands: 1,234 → 1234
      }
    }

    const n = parseFloat(s)
    return isNaN(n) ? null : n
  }

  return null
}

// ── Monetary keyword priority ────────────────────────────────────────────────
const MONETARY_KEYWORDS = [
  // Spanish
  'monto', 'valor', 'costo', 'precio', 'total', 'importe', 'factura', 'ingreso',
  'egreso', 'venta', 'compra', 'fob', 'cif', 'flete', 'arancel', 'impuesto',
  'subtotal', 'neto', 'bruto', 'sueldo', 'salario', 'pago', 'cobro', 'deuda',
  'inversion', 'ganancia', 'utilidad', 'margen', 'descuento', 'cargo',
  // English
  'amount', 'value', 'cost', 'price', 'total', 'revenue', 'sales', 'income',
  'expense', 'invoice', 'freight', 'tax', 'net', 'gross', 'subtotal', 'salary',
  'wage', 'pay', 'budget', 'profit', 'loss', 'discount', 'charge', 'fee',
  // Portuguese
  'valor', 'custo', 'preco', 'receita', 'despesa', 'salario', 'lucro', 'desconto',
]

// ── Column detection ─────────────────────────────────────────────────────────
function selectBestValueColumn(rows, columns) {
  const stats = {}

  columns.forEach(col => {
    const values = rows.map(r => parseUniversalNumber(r[col])).filter(v => v !== null)
    const nonZero = values.filter(v => v !== 0)
    stats[col] = {
      count: values.length,
      nonZeroCount: nonZero.length,
      sum: values.reduce((a, b) => a + b, 0),
      absSum: values.reduce((a, b) => a + Math.abs(b), 0),
    }
  })

  // Priority 1: column name matches monetary keywords
  for (const keyword of MONETARY_KEYWORDS) {
    const match = columns.find(col =>
      col.toLowerCase().includes(keyword) &&
      stats[col].nonZeroCount > 0 &&
      stats[col].absSum > 0
    )
    if (match) {
      console.log(`OKAPI: Selected column by keyword "${keyword}": "${match}", sum: ${stats[match].sum.toFixed(2)}`)
      return match
    }
  }

  // Priority 2: highest non-zero absSum with at least 30% coverage
  const best = columns
    .filter(col => stats[col].nonZeroCount > rows.length * 0.3)
    .sort((a, b) => stats[b].absSum - stats[a].absSum)[0]

  if (best && stats[best].absSum > 0) {
    console.log(`OKAPI: Selected column by highest sum: "${best}", sum: ${stats[best].sum.toFixed(2)}`)
    return best
  }

  // Priority 3: any column with any non-zero values
  const anyNonZero = columns.find(col => stats[col].nonZeroCount > 0)
  if (anyNonZero) {
    console.log(`OKAPI: Selected column as last resort: "${anyNonZero}"`)
    return anyNonZero
  }

  console.log('OKAPI: WARNING - No numeric column found. Stats:', JSON.stringify(stats, null, 2))
  return null
}

// ── Universal date parser ─────────────────────────────────────────────────────
// Returns ISO "YYYY-MM" string or null. Handles any date format from any locale.
const MONTH_NAMES_MAP = {
  // English
  january:0, february:1, march:2, april:3, may:4, june:5,
  july:6, august:7, september:8, october:9, november:10, december:11,
  jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11,
  // Spanish
  enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5,
  julio:6, agosto:7, septiembre:8, octubre:9, noviembre:10, diciembre:11,
  ene:0, abr:3, ago:7, dic:11,
  // Portuguese
  janeiro:0, fevereiro:1, marco:2, maio:4, junho:5,
  julho:6, setembro:8, outubro:9, novembro:10, dezembro:11,
  // French
  janvier:0, fevrier:1, mars:2, avril:3, mai:4, juin:5,
  juillet:6, aout:7, septembre:8, octobre:9, novembre:10, decembre:11,
  // Italian
  gennaio:0, febbraio:1, aprile:3, maggio:4, giugno:5,
  luglio:6, settembre:8, ottobre:9, novembre:10, dicembre:11,
  // German
  januar:0, februar:1, marz:2, april:3, juni:5,
  juli:6, september:8, oktober:9, november:10, dezember:11,
  // Dutch abbrevs
  mrt:2, mei:4, okt:9,
}

export function parseUniversalDate(value) {
  if (!value) return null

  // ExcelJS Date object
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null
    const y = value.getFullYear(), m = value.getMonth() + 1
    return `${y}-${String(m).padStart(2, '0')}`
  }

  // Excel serial number (e.g. 45678 → ~2025)
  if (typeof value === 'number' && value > 40000 && value < 60000) {
    const d = new Date((value - 25569) * 86400 * 1000)
    if (!isNaN(d.getTime())) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    }
  }

  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s || s === 'null' || s === 'undefined') return null

  // Unix timestamp (seconds)
  if (/^\d{9,10}$/.test(s)) {
    const d = new Date(parseInt(s) * 1000)
    if (!isNaN(d.getTime()) && d.getFullYear() > 1990)
      return d.toISOString().slice(0, 7)
  }
  // Unix timestamp (milliseconds)
  if (/^\d{13}$/.test(s)) {
    const d = new Date(parseInt(s))
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 7)
  }

  // ISO-like: 2025-01-15, 2025/01/15, 2025-01
  const iso = s.match(/^(\d{4})[-\/](\d{1,2})(?:[-\/]\d{1,2})?/)
  if (iso) {
    const m = parseInt(iso[2])
    if (m >= 1 && m <= 12) return `${iso[1]}-${String(m).padStart(2, '0')}`
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/)
  if (dmy) {
    const day = parseInt(dmy[1]), month = parseInt(dmy[2])
    const yr = parseInt(dmy[3]) < 100 ? 2000 + parseInt(dmy[3]) : parseInt(dmy[3])
    // If day > 12 it must be DD/MM; otherwise assume DD/MM (most of the world)
    if (month >= 1 && month <= 12) return `${yr}-${String(month).padStart(2, '0')}`
    if (day >= 1 && day <= 12) return `${yr}-${String(day).padStart(2, '0')}` // MM/DD fallback
  }

  // YYYY-MM or YYYY/MM
  const ym = s.match(/^(\d{4})[\/\-](\d{1,2})$/)
  if (ym) {
    const m = parseInt(ym[2])
    if (m >= 1 && m <= 12) return `${ym[1]}-${String(m).padStart(2, '0')}`
  }

  // Compact YYYYMM
  const compact = s.match(/^(\d{4})(\d{2})$/)
  if (compact) {
    const m = parseInt(compact[2])
    if (m >= 1 && m <= 12) return `${compact[1]}-${String(m).padStart(2, '0')}`
  }

  // "Jan 2024", "enero 2024", "Jan-25", "ene-25"
  const nameYear = s.match(/^([A-Za-záéíóúüñãõçäöüàèìòùâêîôûœæøå]+)[,\s\-\/]+(\d{2,4})$/i)
  if (nameYear) {
    const ml = nameYear[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const yr = parseInt(nameYear[2]) < 100 ? 2000 + parseInt(nameYear[2]) : parseInt(nameYear[2])
    if (MONTH_NAMES_MAP[ml] !== undefined)
      return `${yr}-${String(MONTH_NAMES_MAP[ml] + 1).padStart(2, '0')}`
    // Let Date constructor try (handles "January 2024" etc.)
    const attempt = new Date(`${nameYear[1]} 1, ${yr}`)
    if (!isNaN(attempt.getTime())) return attempt.toISOString().slice(0, 7)
  }

  // JS Date parse as last resort
  const fallback = new Date(s)
  if (!isNaN(fallback.getTime()) && fallback.getFullYear() > 1970)
    return fallback.toISOString().slice(0, 7)

  return null
}

// ── Period display formatter ──────────────────────────────────────────────────
// Converts any date value to "Jan 2025" display format using parseUniversalDate.

function parsePeriod(val) {
  if (!val) return null

  const str = String(val).trim()
  if (!str || str === 'null' || str === 'undefined') return null

  // Quarters (Q1 2025 / 2025 Q1) — not a standard date, keep as-is
  const quarter = str.match(/[QqTt]([1-4])[\s\-\/](\d{4})|(\d{4})[\s\-\/][QqTt]([1-4])/i)
  if (quarter) {
    return `Q${parseInt(quarter[1] || quarter[4])} ${parseInt(quarter[2] || quarter[3])}`
  }

  // Use parseUniversalDate for everything else → format for display
  const iso = parseUniversalDate(val)
  if (iso) {
    const [yr, mn] = iso.split('-')
    return new Date(parseInt(yr), parseInt(mn) - 1, 1)
      .toLocaleString('en-US', { month: 'short', year: 'numeric' })
  }

  // Return raw text as a fallback period label (e.g. "Week 3", "FY25 H1")
  return str.length <= 40 ? str : str.slice(0, 40)
}

function periodSortKey(period) {
  if (!period) return 0
  const d = new Date(period)
  if (!isNaN(d.getTime())) return d.getTime()
  const q = period.match(/Q([1-4])\s*(\d{4})/)
  if (q) return parseInt(q[2]) * 10 + parseInt(q[1])
  return 0
}

// ── Main processor ───────────────────────────────────────────────────────────
export function processKPIs(rows, columns, schema = {}) {
  const warnings = []

  // ── Debug logging ──────────────────────────────────────────────────────────
  console.log('=== OKAPI FILE DEBUG ===')
  console.log('Total rows:', rows.length)
  console.log('Columns found:', columns)
  rows.slice(0, 3).forEach((row, i) => {
    console.log(`Row ${i} raw values:`)
    Object.entries(row).forEach(([col, val]) => {
      console.log(`   ${col} -> ${val} (type: ${typeof val})`)
    })
  })

  try {
    const {
      primaryMetricCol: schemaMetricCol,
      dateCol: schemaDateCol,
      categoryCol: schemaCatCol,
      dataType = 'generic',
      dataLabel = 'Data Analysis',
      primaryMetricName = 'Value',
      categoryLabel = 'Categories',
      isMonetary = true,
      currencySymbol = null,
      analysisNotes = '',
      secondaryMetricCol = null,
      secondaryMetricName = null,
    } = schema

    // ── Resolve columns ──────────────────────────────────────────────────────
    const primaryMetricCol = schemaMetricCol || selectBestValueColumn(rows, columns)
    const dateCol = schemaDateCol || null
    const categoryCol = schemaCatCol || null

    if (!primaryMetricCol) {
      const anyNumeric = columns.find(col =>
        rows.slice(0, 10).some(r => parseUniversalNumber(r[col]) !== null)
      )
      if (!anyNumeric) {
        return {
          error: 'no_numeric_column',
          errorMessage: 'No numeric column found. Please ensure your file has at least one column with numbers.',
        }
      }
    }

    const metricCol = primaryMetricCol || columns[columns.length - 1]

    if (!dateCol) warnings.push('no_date_column')
    if (!categoryCol) warnings.push('no_category_column')

    // ── Core aggregation ─────────────────────────────────────────────────────
    let validRows = 0
    let skippedRows = 0
    const periodMap = {}
    const catMap = {}
    let rawTotal = 0
    let totalSecondary = secondaryMetricCol ? 0 : null

    for (const row of rows) {
      try {
        const val = parseUniversalNumber(row[metricCol])
        if (val === null) { skippedRows++; continue }
        if (!isFinite(val)) { skippedRows++; continue }

        rawTotal += val
        validRows++

        const period = dateCol ? (parsePeriod(row[dateCol]) || 'Unknown') : 'All Data'
        periodMap[period] = safeNum(periodMap[period]) + val

        const cat = categoryCol
          ? String(row[categoryCol] ?? '').trim() || 'Unknown'
          : 'All'
        catMap[cat] = safeNum(catMap[cat]) + val

        if (secondaryMetricCol) {
          const secVal = parseUniversalNumber(row[secondaryMetricCol])
          if (secVal !== null) totalSecondary = safeNum(totalSecondary) + secVal
        }
      } catch {
        skippedRows++
      }
    }

    if (skippedRows > 0) warnings.push(`${skippedRows}_rows_skipped`)

    const totalRevenue = safeNum(rawTotal)
    const totalTransactions = validRows || rows.length
    const avgTransactionValue = safeDiv(totalRevenue, totalTransactions)

    if (totalRevenue === 0 && totalTransactions > 0) {
      warnings.push('all_values_zero')
    }

    // ── Period series ────────────────────────────────────────────────────────
    let monthlySales = Object.entries(periodMap)
      .map(([month, revenue]) => ({ month, revenue: safeNum(revenue) }))
      .sort((a, b) => periodSortKey(a.month) - periodSortKey(b.month))

    if (monthlySales.length === 0) {
      monthlySales = [{ month: 'All Data', revenue: totalRevenue }]
    }

    if (monthlySales.length === 1) warnings.push('single_period')

    const monthlyAverage = safeDiv(totalRevenue, monthlySales.length)

    // ── MoM growth ───────────────────────────────────────────────────────────
    const momGrowthRates = monthlySales.map((m, i) => {
      if (i === 0) return { ...m, momGrowth: null }
      const prev = monthlySales[i - 1].revenue
      const growth = safeDiv((m.revenue - prev) * 100, prev)
      return { ...m, momGrowth: parseFloat(growth.toFixed(2)) }
    })

    const latestMomGrowth = momGrowthRates.length >= 2
      ? momGrowthRates[momGrowthRates.length - 1].momGrowth
      : null

    // ── Overall trend ────────────────────────────────────────────────────────
    let revenueTrend = 0
    if (monthlySales.length >= 2) {
      const half = Math.floor(monthlySales.length / 2)
      const first = monthlySales.slice(0, half).reduce((s, m) => s + m.revenue, 0)
      const second = monthlySales.slice(half).reduce((s, m) => s + m.revenue, 0)
      revenueTrend = parseFloat(safeDiv((second - first) * 100, first).toFixed(2))
    }

    const bestMonth = monthlySales.reduce((b, m) => (!b || m.revenue > b.revenue ? m : b), null)
    const worstMonth = monthlySales.reduce((w, m) => (!w || m.revenue < w.revenue ? m : w), null)

    // ── Category breakdown ───────────────────────────────────────────────────
    const topProducts = Object.entries(catMap)
      .map(([name, revenue]) => ({
        name: name || 'Unknown',
        revenue: safeNum(revenue),
        share: safePct(revenue, totalRevenue),
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)

    const topCategoryShare = topProducts.length > 0 ? safeNum(topProducts[0].share) : 0

    // ── Consecutive declines ─────────────────────────────────────────────────
    let consecutiveDeclines = 0
    for (let i = momGrowthRates.length - 1; i >= 1; i--) {
      if (momGrowthRates[i].momGrowth !== null && momGrowthRates[i].momGrowth < 0) consecutiveDeclines++
      else break
    }

    const uniqueCategories = Object.keys(catMap).length
    const uniquePeriods = monthlySales.length
    const dateRange = uniquePeriods > 1
      ? { start: monthlySales[0].month, end: monthlySales[monthlySales.length - 1].month }
      : null

    const additionalMetrics = []
    if (uniqueCategories > 1) {
      additionalMetrics.push({ key: 'unique_categories', label: `Unique ${categoryLabel}`, value: uniqueCategories, format: 'number' })
    }
    if (totalSecondary !== null && totalSecondary > 0) {
      additionalMetrics.push({ key: 'total_secondary', label: `Total ${secondaryMetricName || 'Units'}`, value: totalSecondary, format: 'number' })
    }

    return {
      meta: {
        dataType, dataLabel, primaryMetricName, categoryLabel, isMonetary, currencySymbol,
        analysisNotes, uniqueCategories, dateRange, additionalMetrics,
        warnings, validRows, skippedRows, totalRows: rows.length,
      },
      summary: {
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        totalTransactions,
        monthlyAverage: parseFloat(monthlyAverage.toFixed(2)),
        avgTransactionValue: parseFloat(avgTransactionValue.toFixed(2)),
        revenueTrend,
        latestMomGrowth,
        bestMonth: bestMonth ? { month: bestMonth.month, revenue: safeNum(bestMonth.revenue) } : null,
        worstMonth: worstMonth ? { month: worstMonth.month, revenue: safeNum(worstMonth.revenue) } : null,
        totalSecondary,
        topCategoryShare,
        consecutiveDeclines,
      },
      monthlySales: momGrowthRates,
      topProducts,
      topLabel: categoryLabel,
      detectedColumns: { dateCol, revenueCol: metricCol, categoryCol, secondaryMetricCol },
    }
  } catch (err) {
    console.error('processKPIs failed:', err)
    return {
      meta: {
        dataType: 'generic', dataLabel: 'Data Analysis', primaryMetricName: 'Value',
        categoryLabel: 'Categories', isMonetary: false, currencySymbol: null,
        analysisNotes: '', uniqueCategories: 0, dateRange: null,
        additionalMetrics: [], warnings: ['processing_error'], validRows: 0, skippedRows: 0, totalRows: rows.length,
      },
      summary: {
        totalRevenue: 0, totalTransactions: rows.length, monthlyAverage: 0,
        avgTransactionValue: 0, revenueTrend: 0, latestMomGrowth: null,
        bestMonth: null, worstMonth: null, totalSecondary: null,
        topCategoryShare: 0, consecutiveDeclines: 0,
      },
      monthlySales: [], topProducts: [], topLabel: 'Categories',
      detectedColumns: { dateCol: null, revenueCol: null, categoryCol: null },
    }
  }
}
