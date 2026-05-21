import OpenAI from 'openai'
import { parseUniversalNumber } from './kpiProcessor.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const ANALYSIS_MODEL = process.env.AI_ANALYSIS_MODEL || 'gpt-4o-mini'

// ── Column statistics ────────────────────────────────────────────────────────
function computeColumnStats(rows, columns) {
  return columns.map(col => {
    const rawValues = rows.map(r => r[col])
    const nonNull = rawValues.filter(v => v !== null && v !== undefined && String(v).trim() !== '')
    const nums = nonNull.map(v => parseUniversalNumber(v)).filter(n => n !== null)
    const isNumeric = nums.length > nonNull.length * 0.4

    const stat = {
      column: col,
      nullCount: rawValues.length - nonNull.length,
      type: isNumeric ? 'numeric' : 'text',
    }

    if (isNumeric && nums.length > 0) {
      stat.min = Math.min(...nums)
      stat.max = Math.max(...nums)
      stat.avg = parseFloat((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2))
      stat.sum = parseFloat(nums.reduce((a, b) => a + b, 0).toFixed(2))
    } else {
      const uniqueVals = [...new Set(nonNull.map(v => String(v).trim()))].slice(0, 8)
      stat.uniqueValues = uniqueVals
      stat.uniqueCount = uniqueVals.length
    }

    return stat
  })
}

// ── Rule-based fallback analysis ─────────────────────────────────────────────
function generateFallbackAnalysis(kpiData) {
  const { summary, monthlySales, topProducts, meta, topLabel } = kpiData
  const s = summary || {}
  const m = meta || {}
  const fmt = (v) => v?.toLocaleString('en-US', { maximumFractionDigits: 2 }) || 'N/A'

  const trendDir = s.revenueTrend >= 0 ? 'positiva' : 'negativa'
  const executiveSummary = `El dataset de ${m.dataLabel || 'negocios'} registra un total de ${fmt(s.totalRevenue)} ${m.primaryMetricName || 'en el período'}, con un promedio de ${fmt(s.monthlyAverage)} por período y ${s.totalTransactions?.toLocaleString() || 0} registros. La tendencia general es ${trendDir} con ${Math.abs(s.revenueTrend || 0).toFixed(1)}% de variación. ${s.bestMonth ? `El mejor período fue ${s.bestMonth.month} con ${fmt(s.bestMonth.revenue)}.` : ''}`

  const rootCauses = []
  if (s.consecutiveDeclines >= 2)
    rootCauses.push({ finding: `Caída sostenida: ${s.consecutiveDeclines} períodos consecutivos en declive`, evidence: 'Tendencia bajista detectada en serie temporal', confidence: 'high' })
  if (s.topCategoryShare > 60)
    rootCauses.push({ finding: `Alta concentración: ${topProducts?.[0]?.name} representa ${s.topCategoryShare?.toFixed(1)}%`, evidence: 'Análisis de distribución de categorías', confidence: 'high' })
  if (rootCauses.length === 0)
    rootCauses.push({ finding: 'Comportamiento estable sin anomalías críticas detectadas', evidence: 'Variación dentro de rangos normales', confidence: 'medium' })

  const urgentActions = []
  if (s.consecutiveDeclines >= 3)
    urgentActions.push({ title: 'Análisis urgente de caída sostenida', description: `Investigar causas de ${s.consecutiveDeclines} períodos consecutivos en decline. Revisar demanda, competencia y eficiencia operativa.`, deadline: 'this_week', expectedImpact: 'Detener tendencia bajista', priority: 'critical' })
  if (s.topCategoryShare > 70)
    urgentActions.push({ title: 'Reducir concentración de riesgo', description: `${topProducts?.[0]?.name} representa ${s.topCategoryShare?.toFixed(1)}% del total. Diversificar fuentes de ingreso.`, deadline: 'this_month', expectedImpact: 'Reducir riesgo de concentración', priority: 'high' })
  if (urgentActions.length === 0)
    urgentActions.push({ title: 'Establecer revisión de KPIs', description: `Implementar revisión mensual comparando contra benchmark de ${fmt(s.monthlyAverage)}.`, deadline: 'this_month', expectedImpact: 'Mejor visibilidad operativa', priority: 'medium' })

  const monthlyValues = (monthlySales || []).map(m => m.revenue).filter(Boolean)
  const lastVal = monthlyValues[monthlyValues.length - 1] || s.monthlyAverage || 0
  const growthFactor = (s.revenueTrend || 0) / 100
  const nextPeriod = lastVal * (1 + growthFactor * 0.5)

  return {
    dataType: m.dataType || 'generic',
    confidence: 60,
    dataDescription: `${m.dataLabel || 'Datos de negocio'} — análisis generado automáticamente`,
    generatedBy: 'fallback',

    layer1_whatHappened: {
      executiveSummary,
      totalValue: s.totalRevenue || 0,
      averagePerPeriod: s.monthlyAverage || 0,
      totalRecords: s.totalTransactions || 0,
      dateRange: m.dateRange ? `${m.dateRange.start} – ${m.dateRange.end}` : null,
      mainValueColumn: m.primaryMetricName || 'Value',
      topMetrics: [
        { label: `Total ${m.primaryMetricName || 'Revenue'}`, value: fmt(s.totalRevenue), rawValue: s.totalRevenue, unit: m.isMonetary ? 'currency' : 'number' },
        { label: 'Promedio por período', value: fmt(s.monthlyAverage), rawValue: s.monthlyAverage, unit: m.isMonetary ? 'currency' : 'number' },
        { label: 'Tendencia general', value: `${s.revenueTrend >= 0 ? '+' : ''}${(s.revenueTrend || 0).toFixed(1)}%`, rawValue: s.revenueTrend, unit: 'percentage' },
      ],
      timeSeriesData: (monthlySales || []).map(p => ({ period: p.month, value: p.revenue, label: p.month })),
      topCategories: (topProducts || []).map(p => ({
        name: p.name, value: p.revenue, percentage: p.share,
        trend: 'stable',
      })),
      anomalies: s.consecutiveDeclines >= 2
        ? [{ description: `${s.consecutiveDeclines} períodos consecutivos con caída`, impact: 'high', value: `${s.consecutiveDeclines} períodos` }]
        : [],
    },

    layer2_whyItHappened: {
      rootCauses,
      patterns: [
        {
          pattern: s.revenueTrend >= 5 ? 'growth_acceleration' : s.revenueTrend <= -5 ? 'decline' : 'stability',
          description: s.revenueTrend >= 5 ? 'Tendencia de crecimiento sostenida en el período analizado' : s.revenueTrend <= -5 ? 'Tendencia bajista que requiere atención' : 'Comportamiento estable sin cambios bruscos',
          dataPoints: `Tendencia: ${(s.revenueTrend || 0).toFixed(1)}%, mejor período: ${s.bestMonth?.month || 'N/A'}`,
        },
      ],
      correlations: [],
      concentrationRisks: s.topCategoryShare > 40
        ? [{ type: 'product', name: topProducts?.[0]?.name || 'Top item', percentage: s.topCategoryShare || 0, risk: `Concentración del ${(s.topCategoryShare || 0).toFixed(1)}% — cualquier interrupción afecta significativamente el total` }]
        : [],
    },

    layer3_whatToDo: {
      urgentActions,
      opportunities: s.revenueTrend >= 5
        ? [{ title: 'Escalar operaciones', description: `La tendencia positiva de ${(s.revenueTrend || 0).toFixed(1)}% es el momento ideal para invertir en capacidad.`, potentialValue: `+${((s.totalRevenue || 0) * 0.15).toFixed(0)} adicional`, effort: 'medium' }]
        : [{ title: 'Optimización de período pico', description: `Replicar condiciones del mejor período (${s.bestMonth?.month || 'N/A'}) para mejorar el promedio.`, potentialValue: 'Incremento en promedio mensual', effort: 'low' }],
      forecast: {
        nextPeriod: parseFloat(nextPeriod.toFixed(2)),
        threeMonths: parseFloat((nextPeriod * 3 * (1 + growthFactor * 0.1)).toFixed(2)),
        confidence: 55,
        assumptions: 'Proyección lineal basada en tendencia histórica',
        scenarios: {
          optimistic: parseFloat((nextPeriod * 1.15).toFixed(2)),
          realistic: parseFloat(nextPeriod.toFixed(2)),
          pessimistic: parseFloat((nextPeriod * 0.85).toFixed(2)),
        },
      },
      riskAssessment: {
        overallLevel: s.consecutiveDeclines >= 3 ? 'high' : s.topCategoryShare > 70 ? 'medium' : 'low',
        score: Math.min(100, (s.consecutiveDeclines || 0) * 20 + (s.topCategoryShare || 0) * 0.5),
        topRisks: [
          s.consecutiveDeclines >= 2 && { risk: 'Caída sostenida de métricas', probability: 'high', impact: 'high' },
          s.topCategoryShare > 60 && { risk: 'Concentración excesiva en un segmento', probability: 'medium', impact: 'high' },
        ].filter(Boolean),
        mitigations: ['Diversificar fuentes de ingreso', 'Monitorear indicadores adelantados mensualmente'],
      },
    },

    criticalAlerts: [
      s.consecutiveDeclines >= 3 && `${s.consecutiveDeclines} períodos consecutivos en declive — requiere acción inmediata`,
      s.topCategoryShare > 80 && `Concentración crítica: ${(s.topCategoryShare || 0).toFixed(1)}% en un solo segmento`,
      (s.revenueTrend || 0) < -25 && `Caída severa de ${Math.abs(s.revenueTrend || 0).toFixed(1)}% en el período analizado`,
    ].filter(Boolean).slice(0, 3),

    highlights: [
      s.revenueTrend >= 10 && `Crecimiento sólido de ${(s.revenueTrend || 0).toFixed(1)}% en el período`,
      s.bestMonth && `Mejor período: ${s.bestMonth.month} con ${fmt(s.bestMonth.revenue)}`,
      (s.totalTransactions || 0) > 100 && `Alto volumen: ${(s.totalTransactions || 0).toLocaleString()} registros analizados`,
    ].filter(Boolean).slice(0, 3),

    dataQuality: {
      score: m.warnings?.length > 0 ? 70 : 90,
      completeness: Math.round(((m.validRows || 0) / Math.max(1, m.totalRows || 1)) * 100),
      issues: m.warnings || [],
      improvements: ['Agregar columna de fecha para análisis temporal', 'Verificar columnas de categoría'],
    },
  }
}

// ── Deep Claude analysis ─────────────────────────────────────────────────────
export async function runDeepAnalysis(sampleRows, columns, kpiData) {
  const { meta, summary, monthlySales, topProducts } = kpiData

  const columnStats = computeColumnStats(sampleRows, columns)

  const prompt = `Analyze this business dataset completely. Return ONLY valid JSON, no markdown, no explanation outside the JSON.

Dataset:
- Type detected: ${meta?.dataType || 'generic'}
- Data label: ${meta?.dataLabel || 'Business Data'}
- Primary metric: ${meta?.primaryMetricName || 'Value'}
- Columns: ${JSON.stringify(columns)}
- Total rows: ${meta?.totalRows || sampleRows.length}
- Main value column: ${meta?.primaryMetricName} (total: ${summary?.totalRevenue})
- Date column: ${meta?.dateRange ? 'detected' : 'null'}
- Category column: ${meta?.uniqueCategories > 1 ? 'detected' : 'null'}
- First 15 rows: ${JSON.stringify(sampleRows.slice(0, 15))}
- Column statistics: ${JSON.stringify(columnStats)}
- KPI summary: total=${summary?.totalRevenue}, avg=${summary?.monthlyAverage}, trend=${summary?.revenueTrend}%, consecutiveDeclines=${summary?.consecutiveDeclines}, topCategoryShare=${summary?.topCategoryShare}%
- Monthly data: ${JSON.stringify(monthlySales?.slice(0, 24))}
- Top categories: ${JSON.stringify(topProducts)}

Return this EXACT JSON structure (all text in Spanish, professional CFO language):
{
  "dataType": "Sales|Import-Export|Inventory|HR|Academic|Engineering|Financial|Other",
  "confidence": 0-100,
  "dataDescription": "Una frase describiendo qué son estos datos",
  "layer1_whatHappened": {
    "executiveSummary": "3-4 oraciones en español describiendo qué muestran los datos, estilo reporte CFO",
    "totalValue": number,
    "averagePerPeriod": number,
    "totalRecords": number,
    "dateRange": "string or null",
    "mainValueColumn": "string",
    "topMetrics": [{"label":"string","value":"string","rawValue":number,"unit":"currency|percentage|number|count"}],
    "timeSeriesData": [{"period":"string","value":number,"label":"string"}],
    "topCategories": [{"name":"string","value":number,"percentage":number,"trend":"up|down|stable"}],
    "anomalies": [{"description":"string","impact":"high|medium|low","value":"string"}]
  },
  "layer2_whyItHappened": {
    "rootCauses": [{"finding":"string","evidence":"string","confidence":"high|medium|low"}],
    "patterns": [{"pattern":"string","description":"string","dataPoints":"string"}],
    "correlations": [{"factor1":"string","factor2":"string","relationship":"string"}],
    "concentrationRisks": [{"type":"supplier|customer|product|geography","name":"string","percentage":number,"risk":"string"}]
  },
  "layer3_whatToDo": {
    "urgentActions": [{"title":"string","description":"string","deadline":"immediate|this_week|this_month|this_quarter","expectedImpact":"string","priority":"critical|high|medium"}],
    "opportunities": [{"title":"string","description":"string","potentialValue":"string","effort":"low|medium|high"}],
    "forecast": {
      "nextPeriod": number,
      "threeMonths": number,
      "confidence": number,
      "assumptions": "string",
      "scenarios": {"optimistic":number,"realistic":number,"pessimistic":number}
    },
    "riskAssessment": {
      "overallLevel": "low|medium|high|critical",
      "score": 0-100,
      "topRisks": [{"risk":"string","probability":"high|medium|low","impact":"high|medium|low"}],
      "mitigations": ["string"]
    }
  },
  "criticalAlerts": ["string - solo problemas urgentes reales, máx 3"],
  "highlights": ["string - aspectos positivos genuinos, máx 3"],
  "dataQuality": {
    "score": 0-100,
    "completeness": 0-100,
    "issues": ["string"],
    "improvements": ["string"]
  }
}`

  try {
    const response = await openai.chat.completions.create({
      model: ANALYSIS_MODEL,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: 'You are a world-class CFO, business analyst, and data scientist combined. You think in 3 layers: WHAT happened, WHY it happened, and WHAT TO DO about it. You speak in clear human language, never in jargon. You find patterns humans miss. You are proactive - you warn about problems before they become crises. Return ONLY valid JSON.' },
        { role: 'user', content: prompt },
      ],
    })

    const text = response.choices[0].message.content.trim()
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in Claude response')

    const analysis = JSON.parse(match[0])
    analysis.generatedBy = 'openai'
    return analysis

  } catch (err) {
    console.warn('[Analysis] Claude analysis failed, using fallback:', err.message)
    return generateFallbackAnalysis(kpiData)
  }
}
