import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── Heuristic fallback (used when AI is unavailable or confidence < 60) ──────
function heuristicDetection(columns, rows) {
  const colStr = columns.join(' ').toLowerCase()

  const MONETARY = [
    'revenue','sales','amount','total','price','value','cost','salary','pay','wage',
    'income','profit','budget','expense','fee','charge','invoice','payment','net','gross',
    'ingresos','ventas','monto','precio','valor','costo','salario','sueldo','importe',
    'ingreso','venta','flete','gasto','presupuesto','factura','pago','fob','cif',
    'receita','despesa','custo','preco','lucro',
  ]
  const DATES = [
    'date','month','period','year','week','day','time','quarter','timestamp',
    'fecha','mes','periodo','ano','semana','dia','trimestre',
    'data','datum',
  ]
  const CATEGORIES = [
    'product','category','supplier','vendor','employee','staff','student',
    'department','region','city','country','name','type','class','item','brand',
    'channel','campaign','client','customer','account','sector',
    'producto','categoria','proveedor','empleado','alumno','departamento',
    'ciudad','pais','nombre','tipo','clase','marca','canal','cliente','cuenta',
  ]

  const findCol = (list) =>
    columns.find(c => list.some(k => c.toLowerCase().includes(k))) || null

  const dateCol = findCol(DATES)
  const categoryCol = findCol(CATEGORIES)
  const monetaryCol = findCol(MONETARY)

  // First numeric column as ultimate fallback
  const numericCol = monetaryCol || columns.find(col =>
    rows.slice(0, 5).some(r => {
      const v = r[col]
      return v !== null && v !== '' && typeof v === 'number' && !isNaN(v) && v !== 0
    })
  ) || null

  let dataType = 'generic'
  let dataLabel = 'Data Analysis'
  let primaryMetricName = 'Value'
  let categoryLabel = 'Categories'
  let isMonetary = false

  if (colStr.match(/proveedor|supplier|import|export|flete|freight|aduan|customs|shipm/)) {
    dataType = 'import_export'; dataLabel = 'Import/Export'; primaryMetricName = 'Cost'; categoryLabel = 'Suppliers'; isMonetary = true
  } else if (colStr.match(/salary|salario|sueldo|employ|empleado|payroll|nomina|hr\b|staff|wage/)) {
    dataType = 'hr'; dataLabel = 'HR Data'; primaryMetricName = 'Salary'; categoryLabel = 'Departments'; isMonetary = true
  } else if (colStr.match(/stock|inventory|inventario|almacen|warehouse|sku/)) {
    dataType = 'inventory'; dataLabel = 'Inventory'; primaryMetricName = 'Quantity'; categoryLabel = 'Products'; isMonetary = false
  } else if (colStr.match(/grade|nota|calificacion|score|student|alumno|course|curso|gpa/)) {
    dataType = 'academic'; dataLabel = 'Academic Data'; primaryMetricName = 'Score'; categoryLabel = 'Students'; isMonetary = false
  } else if (colStr.match(/campaign|lead|conversion|click|impression|cpc|ctr|marketing/)) {
    dataType = 'marketing'; dataLabel = 'Marketing'; primaryMetricName = 'Value'; categoryLabel = 'Campaigns'; isMonetary = false
  } else if (colStr.match(/budget|presupuesto|cashflow|profit|loss|balance|ebitda/)) {
    dataType = 'financial'; dataLabel = 'Financial Data'; primaryMetricName = 'Amount'; categoryLabel = 'Accounts'; isMonetary = true
  } else if (monetaryCol || colStr.match(/revenue|sales|ventas|ingresos|invoice|factura|order|pedido/)) {
    dataType = 'sales'; dataLabel = 'Sales Data'; primaryMetricName = 'Revenue'; categoryLabel = 'Products'; isMonetary = true
  }

  return {
    dataType, dataLabel, primaryMetricName, categoryLabel, isMonetary,
    primaryMetricCol: numericCol,
    dateCol,
    categoryCol,
    secondaryMetricCol: null,
    secondaryMetricName: null,
    currencySymbol: isMonetary ? '$' : null,
    analysisNotes: `${dataLabel} — analyzing ${primaryMetricName} by period and category.`,
    confidence: 40,
    source: 'heuristic',
  }
}

// ── AI-powered detection ──────────────────────────────────────────────────────
export async function detectDataSchema(columns, rows, originalName = '') {
  const sample = rows.slice(0, 5).map(row => {
    const r = {}
    columns.slice(0, 16).forEach(col => { r[col] = row[col] })
    return r
  })

  const prompt = `Analyze these spreadsheet column names and sample data. Identify the most important columns for business analysis.

Filename: "${originalName}"
Column names: ${JSON.stringify(columns)}
Sample data (first 5 rows): ${JSON.stringify(sample, null, 2)}

Return ONLY a JSON object, no explanation, no markdown:
{
  "mainValueColumn": "exact column name with primary monetary/numeric value to sum/analyze",
  "dateColumn": "exact column name with dates/periods, or null",
  "categoryColumn": "exact column name with main categories (supplier/product/country/etc), or null",
  "secondaryValueColumn": "second most important numeric column, or null",
  "dataType": "Import-Export|Sales|Inventory|HR|Academic|Engineering|Financial|Marketing|Other",
  "dataLabel": "short human-readable dataset description",
  "primaryMetricName": "what the main numeric value represents (Revenue/Cost/Quantity/Score/Salary)",
  "categoryLabel": "what the category column represents (Products/Suppliers/Employees/Countries)",
  "currency": "USD|EUR|UYU|ARS|BRL|GBP|other|unknown",
  "isMonetary": true,
  "confidence": 85,
  "reasoning": "one sentence explaining column choices"
}

Critical rules:
- mainValueColumn MUST exactly match one of the column names provided, or null
- dateColumn MUST exactly match one of the column names, or null
- categoryColumn MUST exactly match one of the column names, or null
- Understand column names in ANY language (Spanish, Portuguese, French, Chinese, Arabic, etc.)
- Spanish: fecha=date, monto/costo/precio/valor/importe=monetary, proveedor=supplier, producto=product
- Portuguese: data=date, valor/custo/preco=monetary, fornecedor=supplier, produto=product
- If column name contains $, €, £, U$S, FOB, CIF, or any currency symbol → it's monetary
- For import/export data: prefer FOB, CIF, total cost, freight value columns
- For HR: prefer salary, wage, compensation columns
- For sales: prefer revenue, total, amount, net columns
- confidence: 90+ if column names are very clear, 60-89 if reasonably clear, below 60 if ambiguous`

  try {
    const res = await openai.chat.completions.create({
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = res.choices[0].message.content.trim()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in AI response')

    const ai = JSON.parse(jsonMatch[0])
    console.log(`[Schema AI] "${originalName}" → col: "${ai.mainValueColumn}", type: ${ai.dataType}, confidence: ${ai.confidence}%, reason: ${ai.reasoning}`)

    // Validate all column references exist
    const validate = col => (col && columns.includes(col)) ? col : null
    const mainValueCol = validate(ai.mainValueColumn)
    const dateCol = validate(ai.dateColumn)
    const categoryCol = validate(ai.categoryColumn)
    const secondaryCol = validate(ai.secondaryValueColumn)

    // Fall back to heuristics if AI is not confident enough
    if ((ai.confidence ?? 0) < 60 || !mainValueCol) {
      console.warn(`[Schema AI] Low confidence (${ai.confidence}%) or no column found, running heuristic backup`)
      const heuristic = heuristicDetection(columns, rows)
      return {
        ...heuristic,
        // Use AI's context info even if column detection was uncertain
        dataType: mapDataType(ai.dataType) || heuristic.dataType,
        dataLabel: ai.dataLabel || heuristic.dataLabel,
        primaryMetricName: ai.primaryMetricName || heuristic.primaryMetricName,
        categoryLabel: ai.categoryLabel || heuristic.categoryLabel,
        // Prefer heuristic column if AI didn't find one
        primaryMetricCol: mainValueCol || heuristic.primaryMetricCol,
        dateCol: dateCol || heuristic.dateCol,
        categoryCol: categoryCol || heuristic.categoryCol,
        aiReasoning: ai.reasoning,
        confidence: ai.confidence,
        source: 'ai+heuristic',
      }
    }

    return {
      dataType: mapDataType(ai.dataType) || 'generic',
      dataLabel: ai.dataLabel || 'Data Analysis',
      primaryMetricName: ai.primaryMetricName || 'Value',
      categoryLabel: ai.categoryLabel || 'Categories',
      isMonetary: Boolean(ai.isMonetary),
      currencySymbol: mapCurrency(ai.currency),
      primaryMetricCol: mainValueCol,
      dateCol,
      categoryCol,
      secondaryMetricCol: secondaryCol,
      secondaryMetricName: ai.secondaryValueColumn || null,
      analysisNotes: ai.reasoning || '',
      confidence: ai.confidence ?? 80,
      source: 'ai',
    }
  } catch (err) {
    console.warn('[Schema AI] Detection failed, using heuristics:', err.message)
    return heuristicDetection(columns, rows)
  }
}

function mapDataType(aiType) {
  const map = {
    'Import-Export': 'import_export',
    'Sales': 'sales',
    'Inventory': 'inventory',
    'HR': 'hr',
    'Academic': 'academic',
    'Engineering': 'technical',
    'Financial': 'financial',
    'Marketing': 'marketing',
    'Other': 'generic',
  }
  return map[aiType] || 'generic'
}

function mapCurrency(c) {
  if (!c || c === 'unknown') return null
  if (c === 'USD') return '$'
  if (c === 'EUR') return '€'
  if (c === 'GBP') return '£'
  if (c === 'BRL') return 'R$'
  if (c === 'ARS') return '$'
  if (c === 'UYU') return '$U'
  return '$'
}
