import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL = process.env.AI_MODEL || 'gpt-4o-mini'

function formatValue(value, isMonetary) {
  if (value === null || value === undefined) return 'N/A'
  if (isMonetary) {
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function buildSystemPrompt(kpiData) {
  const {
    summary, monthlySales, topProducts,
    meta = {},
    detectedColumns,
  } = kpiData

  const {
    dataType = 'generic',
    dataLabel = 'Business Data',
    primaryMetricName = 'Value',
    categoryLabel = 'Categories',
    isMonetary = true,
    analysisNotes = '',
    dateRange,
    additionalMetrics = [],
  } = meta

  const fmt = v => formatValue(v, isMonetary)

  const trendSign = summary.revenueTrend >= 0 ? '+' : ''
  const trendEmoji = summary.revenueTrend >= 10 ? '📈' : summary.revenueTrend < -10 ? '📉' : '➡️'
  const riskFlags = []
  if (summary.consecutiveDeclines >= 3) riskFlags.push(`CRITICAL: ${summary.consecutiveDeclines} consecutive declining periods`)
  if (summary.topCategoryShare > 70) riskFlags.push(`HIGH CONCENTRATION: top item = ${summary.topCategoryShare?.toFixed(1)}% of total`)
  if (summary.revenueTrend < -20) riskFlags.push(`SHARP DECLINE: ${summary.revenueTrend?.toFixed(1)}% overall trend`)

  const additionalContext = additionalMetrics.length > 0
    ? `\n## ADDITIONAL METRICS\n${additionalMetrics.map(m => `- ${m.label}: ${m.format === 'currency' ? fmt(m.value) : m.value?.toLocaleString()}`).join('\n')}`
    : ''

  const riskContext = riskFlags.length > 0
    ? `\n## ⚠️ ACTIVE RISK FLAGS\n${riskFlags.map(r => `- ${r}`).join('\n')}`
    : ''

  return `You are Okapi — an expert AI business analyst and strategic copilot. You proactively surface insights, flag risks, and guide decisions based on real data. You are currently analyzing ${dataLabel}.

## YOUR ROLE
- You are a PROACTIVE copilot, not just a reactive Q&A bot
- When answering, always include: (1) the direct answer, (2) what it means strategically, (3) a concrete next action
- Reference specific numbers — vague advice has no value
- If the user asks something unclear, interpret it in the most useful business context
- Explain concepts briefly when relevant (e.g. "MoM growth means month-over-month change")

## DATASET CONTEXT ${trendEmoji}
- Data type: ${dataType}
- Primary metric: ${primaryMetricName}
- Period analyzed: ${dateRange ? `${dateRange.start} to ${dateRange.end}` : 'Multiple periods'}
- Analysis notes: ${analysisNotes || `Auto-detected ${dataLabel}`}

## KEY METRICS SNAPSHOT
| Metric | Value |
|--------|-------|
| Total ${primaryMetricName} | ${fmt(summary.totalRevenue)} |
| Total Records | ${summary.totalTransactions?.toLocaleString()} |
| Period Average | ${fmt(summary.monthlyAverage)} |
| Overall Trend | ${trendSign}${summary.revenueTrend?.toFixed(1)}% |
| Last Period Change | ${summary.latestMomGrowth !== null ? `${summary.latestMomGrowth >= 0 ? '+' : ''}${summary.latestMomGrowth?.toFixed(1)}%` : 'N/A'} |
| Best Period | ${summary.bestMonth?.month || 'N/A'} (${fmt(summary.bestMonth?.revenue)}) |
| Worst Period | ${summary.worstMonth?.month || 'N/A'} (${fmt(summary.worstMonth?.revenue)}) |
| Consecutive Declines | ${summary.consecutiveDeclines || 0} periods |
| Top ${categoryLabel} Concentration | ${summary.topCategoryShare?.toFixed(1) || 'N/A'}% |
${additionalContext}
${riskContext}

## PERIOD-BY-PERIOD DATA
${monthlySales?.map(m => `- ${m.month}: ${fmt(m.revenue)}${m.momGrowth !== null && m.momGrowth !== undefined ? ` (${m.momGrowth >= 0 ? '+' : ''}${m.momGrowth?.toFixed(1)}% MoM)` : ''}`).join('\n')}

## TOP ${categoryLabel?.toUpperCase()}
${topProducts?.map((p, i) => `${i + 1}. ${p.name}: ${fmt(p.revenue)} (${p.share?.toFixed(1)}% of total)`).join('\n')}

## RESPONSE GUIDELINES
- Domain language: use ${dataLabel}-appropriate terms (not generic "revenue" for HR/inventory data)
- Length: 3-6 sentences for simple questions; use bullet points for recommendations (max 5 bullets)
- Always tie insights to the actual numbers above
- For trend questions, compare best vs worst and explain the gap
- For recommendation requests, rank by impact and include why
- Respond in the SAME LANGUAGE the user writes in
- Be direct, confident, and specific — avoid hedging unless data is genuinely ambiguous`
}

export async function getChatResponse(message, kpiData, conversationHistory = []) {
  const systemPrompt = buildSystemPrompt(kpiData)

  const messages = [
    ...conversationHistory.slice(-10).map(m => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'user', content: message },
  ]

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 1000,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    })
    return response.choices[0].message.content
  } catch (err) {
    console.warn('OpenAI API unavailable, using rule-based fallback:', err.message)
    return fallbackChatResponse(message, kpiData)
  }
}

function fallbackChatResponse(message, kpiData) {
  const msg = message.toLowerCase()
  const { summary = {}, topProducts = [], monthlySales = [], meta = {} } = kpiData || {}
  const fmt = (n) => n != null ? `$${Number(n).toLocaleString('es-ES', { maximumFractionDigits: 0 })}` : 'N/A'
  const totalValue = summary.totalRevenue || 0
  const growth = summary.revenueTrend || 0
  const trend = growth >= 0 ? `▲ +${growth.toFixed(1)}%` : `▼ ${growth.toFixed(1)}%`

  if (msg.includes('riesgo') || msg.includes('alerta') || msg.includes('problema')) {
    const alerts = []
    if (summary.consecutiveDeclines >= 3) alerts.push(`${summary.consecutiveDeclines} períodos consecutivos en caída`)
    if (summary.topCategoryShare > 70) alerts.push(`Alta concentración: top categoría = ${summary.topCategoryShare?.toFixed(1)}%`)
    if (summary.revenueTrend < -20) alerts.push(`Caída aguda del ${Math.abs(growth).toFixed(1)}%`)
    return alerts.length > 0
      ? `🚨 **Alertas detectadas:**\n${alerts.map(a => `• ${a}`).join('\n')}\n\n¿Querés profundizar en alguna?`
      : '✅ No detecté alertas críticas. El negocio parece estable.'
  }

  if (msg.includes('recomend') || msg.includes('hacer') || msg.includes('accion') || msg.includes('acción')) {
    const recs = []
    if (growth < 0) recs.push('Investigar causas de la tendencia negativa')
    if (summary.topCategoryShare > 70) recs.push('Diversificar el mix de categorías')
    recs.push('Revisar los períodos de mejor y peor performance')
    return `💡 **Recomendaciones:**\n${recs.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n*Para análisis personalizado activá créditos en platform.openai.com*`
  }

  if (msg.includes('kpi') || msg.includes('metrica') || msg.includes('métrica') || msg.includes('numero')) {
    return `📊 **KPIs principales:**\n• Total: ${fmt(totalValue)}\n• Tendencia: ${trend}\n• Mejor período: ${summary.bestMonth?.month || 'N/A'} (${fmt(summary.bestMonth?.revenue)})\n• Peor período: ${summary.worstMonth?.month || 'N/A'}\n• Registros: ${summary.totalTransactions?.toLocaleString() || 'N/A'}`
  }

  if (msg.includes('categoria') || msg.includes('categoría') || msg.includes('producto')) {
    return topProducts.length > 0
      ? `🏆 **Top categorías:**\n${topProducts.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}: ${fmt(p.revenue)} (${p.share?.toFixed(1)}%)`).join('\n')}`
      : 'No encontré datos de categorías en este archivo.'
  }

  if (msg.includes('hola') || msg.includes('buenas') || msg.includes('hey')) {
    return `¡Hola! 👋 Soy Okapi, tu asistente de análisis.\n\nTenés: **${fmt(totalValue)}** con tendencia **${trend}**.\n\nPodés preguntarme sobre: riesgos, recomendaciones, KPIs, categorías o resumen.\n\n*Para IA completa activá créditos en platform.openai.com*`
  }

  return `Basado en tus datos:\n• **Total:** ${fmt(totalValue)}\n• **Tendencia:** ${trend}\n• **Tipo:** ${meta.dataLabel || 'Datos de negocio'}\n\n💡 *Para análisis profundo activá créditos en platform.openai.com*\n\nPreguntame sobre: riesgos, recomendaciones, KPIs o categorías.`
}
