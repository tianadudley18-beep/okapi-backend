import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { upload } from '../middleware/upload.js'
import { supabase } from '../config/supabase.js'
import { parseFile } from '../services/dataParser.js'
import { processKPIs } from '../services/kpiProcessor.js'
import { detectDataSchema } from '../services/dataDetector.js'
import { runDeepAnalysis } from '../services/analysisService.js'
import { checkAndCreateAlerts } from '../services/alertsService.js'
import { checkMessageLimit } from '../middleware/checkMessageLimit.js'
import OpenAI from 'openai'

const router = Router()
router.use(requireAuth)

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── List projects ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*, project_files(count)')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })

    if (error) throw error

    const projects = (data || []).map(p => ({
      ...p,
      file_count: p.project_files?.[0]?.count ?? 0,
      project_files: undefined,
    }))

    res.json({ projects })
  } catch (err) {
    console.error('Projects list error:', err)
    res.status(500).json({ message: 'Could not load projects' })
  }
})

// ── Get single project ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*, project_files(count)')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()

    if (error || !data) return res.status(404).json({ message: 'Project not found' })

    res.json({
      project: {
        ...data,
        file_count: data.project_files?.[0]?.count ?? 0,
        project_files: undefined,
      },
    })
  } catch (err) {
    res.status(500).json({ message: 'Could not load project' })
  }
})

// ── Create project ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, description, color, icon, industry } = req.body
    if (!name?.trim()) return res.status(400).json({ message: 'Project name is required' })

    const payload = {
      user_id: req.user.id,
      name: name.trim(),
      description: description?.trim() || null,
      color: color || '#6366f1',
      icon: icon || 'chart',
      industry: industry || 'general',
    }
    console.log('[Projects] Creating project for user', req.user.id, ':', payload.name)

    const { data, error } = await supabase
      .from('projects')
      .insert(payload)
      .select()
      .single()

    if (error) {
      console.error('[Projects] Supabase insert error:', error.code, error.message, error.details, error.hint)
      // Give actionable message for common errors
      if (error.code === '42P01') {
        return res.status(500).json({
          message: 'Projects table does not exist. Please run supabase_schema.sql in your Supabase dashboard.',
          code: 'table_missing',
        })
      }
      if (error.code === '42501') {
        return res.status(500).json({
          message: 'Row Level Security is blocking the insert. Check the policy in supabase_schema.sql.',
          code: 'rls_error',
        })
      }
      throw error
    }

    console.log('[Projects] Created project', data.id)
    res.json({ project: data })
  } catch (err) {
    console.error('[Projects] Create error:', err.message, err.stack)
    res.status(500).json({ message: 'Could not create project. Check server logs.' })
  }
})

// ── Update project ────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { name, description, color, icon, industry } = req.body
    const updates = { updated_at: new Date().toISOString() }
    if (name !== undefined) updates.name = name.trim()
    if (description !== undefined) updates.description = description?.trim() || null
    if (color !== undefined) updates.color = color
    if (icon !== undefined) updates.icon = icon
    if (industry !== undefined) updates.industry = industry

    const { data, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ message: 'Project not found' })
    res.json({ project: data })
  } catch {
    res.status(500).json({ message: 'Could not update project' })
  }
})

// ── Delete project ────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)

    if (error) throw error
    res.json({ message: 'Project deleted' })
  } catch {
    res.status(500).json({ message: 'Could not delete project' })
  }
})

// ── List project files ────────────────────────────────────────────────────────
router.get('/:id/files', async (req, res) => {
  try {
    const { data: project } = await supabase
      .from('projects').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!project) return res.status(404).json({ message: 'Project not found' })

    const { data, error } = await supabase
      .from('project_files')
      .select('id, added_at, user_files(id, original_name, row_count, columns, created_at, kpi_data)')
      .eq('project_id', req.params.id)
      .order('added_at', { ascending: false })

    if (error) throw error
    res.json({ files: data || [] })
  } catch {
    res.status(500).json({ message: 'Could not load project files' })
  }
})

// ── Upload file directly to project ──────────────────────────────────────────
router.post('/:id/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file received' })

  const { data: project } = await supabase
    .from('projects').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
  if (!project) return res.status(404).json({ message: 'Project not found' })

  try {
    const { originalname, buffer } = req.file
    const parsed = await parseFile(buffer, originalname)
    if (parsed.error) return res.status(422).json({ message: parsed.error })

    const { rows, columns } = parsed
    if (!rows?.length) return res.status(422).json({ message: 'File is empty' })

    const schema = await detectDataSchema(columns, rows.slice(0, 100), originalname)
    const kpiData = processKPIs(rows, columns, schema)

    const numericColumns = columns.filter(col =>
      rows.slice(0, 20).some(r => {
        const v = r[col]
        if (typeof v === 'number') return !isNaN(v)
        if (typeof v === 'string') return !isNaN(parseFloat(v.replace(/[,$€]/g, '')))
        return false
      })
    )

    const { data: fileRecord, error: fileErr } = await supabase
      .from('user_files')
      .insert({
        user_id: req.user.id,
        original_name: originalname,
        row_count: rows.length,
        columns,
        kpi_data: { ...kpiData, sampleRows: rows.slice(0, 20), rawRows: rows.slice(0, 500), numericColumns },
      })
      .select('id, original_name, row_count, columns, created_at, kpi_data')
      .single()

    if (fileErr) throw fileErr

    await supabase.from('project_files').insert({ project_id: req.params.id, file_id: fileRecord.id })
    await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', req.params.id)

    // Background: deep analysis + alerts (non-blocking)
    ;(async () => {
      try {
        const analysis = await runDeepAnalysis(rows.slice(0, 500), columns, kpiData)
        if (analysis) {
          await supabase.from('user_files').update({
            kpi_data: { ...kpiData, sampleRows: rows.slice(0, 20), analysis },
          }).eq('id', fileRecord.id)
        }
        await checkAndCreateAlerts(req.user.id, fileRecord.id, kpiData, req.params.id)
      } catch { /* non-critical */ }
    })()

    res.json({ file: fileRecord })
  } catch (err) {
    console.error('Project upload error:', err)
    res.status(500).json({ message: 'Upload failed. Please try again.' })
  }
})

// ── Add existing file to project ──────────────────────────────────────────────
router.post('/:id/files', async (req, res) => {
  try {
    const { fileId } = req.body
    if (!fileId) return res.status(400).json({ message: 'fileId is required' })

    const { data: project } = await supabase
      .from('projects').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!project) return res.status(404).json({ message: 'Project not found' })

    const { data: file } = await supabase
      .from('user_files').select('id').eq('id', fileId).eq('user_id', req.user.id).single()
    if (!file) return res.status(404).json({ message: 'File not found' })

    const { data, error } = await supabase
      .from('project_files')
      .insert({ project_id: req.params.id, file_id: fileId })
      .select().single()

    if (error) {
      if (error.code === '23505') return res.status(409).json({ message: 'File already in project' })
      throw error
    }

    await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', req.params.id)
    res.json({ projectFile: data })
  } catch {
    res.status(500).json({ message: 'Could not add file to project' })
  }
})

// ── Remove file from project ──────────────────────────────────────────────────
router.delete('/:id/files/:fileId', async (req, res) => {
  try {
    const { data: project } = await supabase
      .from('projects').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!project) return res.status(404).json({ message: 'Project not found' })

    const { error } = await supabase
      .from('project_files')
      .delete()
      .eq('project_id', req.params.id)
      .eq('file_id', req.params.fileId)

    if (error) throw error
    res.json({ message: 'File removed from project' })
  } catch {
    res.status(500).json({ message: 'Could not remove file' })
  }
})

// ── Reprocess file with different column ─────────────────────────────────────
router.post('/:id/files/:fileId/reprocess', async (req, res) => {
  try {
    const { columnName } = req.body
    if (!columnName) return res.status(400).json({ message: 'columnName is required' })

    const { data: project } = await supabase
      .from('projects').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!project) return res.status(404).json({ message: 'Project not found' })

    const { data: fileRecord } = await supabase
      .from('user_files')
      .select('id, columns, kpi_data')
      .eq('id', req.params.fileId)
      .eq('user_id', req.user.id)
      .single()

    if (!fileRecord) return res.status(404).json({ message: 'File not found' })

    const rawRows = fileRecord.kpi_data?.rawRows || fileRecord.kpi_data?.sampleRows
    if (!rawRows?.length) return res.status(422).json({ message: 'No raw data available for reprocessing. Please re-upload the file.' })

    const columns = fileRecord.columns || []
    if (!columns.includes(columnName)) return res.status(400).json({ message: 'Column not found in file' })

    // Re-detect schema with column override
    const schema = await detectDataSchema(columns, rawRows.slice(0, 100), fileRecord.kpi_data?.meta?.originalName || 'file')
    schema.primaryMetricCol = columnName

    const kpiData = processKPIs(rawRows, columns, schema)
    const numericColumns = fileRecord.kpi_data?.numericColumns || columns

    await supabase.from('user_files').update({
      kpi_data: { ...kpiData, sampleRows: rawRows.slice(0, 20), rawRows: rawRows.slice(0, 500), numericColumns },
    }).eq('id', req.params.fileId)

    res.json({ message: 'File reprocessed successfully', kpiData })
  } catch (err) {
    console.error('Reprocess error:', err)
    res.status(500).json({ message: 'Could not reprocess file' })
  }
})

// ── List project integrations (sheets) ────────────────────────────────────────
router.get('/:id/sheets', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('integrations')
      .select('*')
      .eq('project_id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('type', 'google_sheets')

    if (error) throw error
    res.json({ sheets: data || [] })
  } catch {
    res.json({ sheets: [] })
  }
})

// ── Connect Google Sheet to project ──────────────────────────────────────────
router.post('/:id/sheets', async (req, res) => {
  const { sheetUrl } = req.body
  if (!sheetUrl?.trim()) return res.status(400).json({ message: 'Sheet URL is required' })

  const { data: project } = await supabase
    .from('projects').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
  if (!project) return res.status(404).json({ message: 'Project not found' })

  const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  if (!match) return res.status(400).json({ message: 'Invalid Google Sheets URL. Paste the full URL from your browser.' })

  const sheetId = match[1]

  try {
    // Try different export URLs (handles private-but-accessible sheets)
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`
    const csvRes = await fetch(csvUrl)

    if (!csvRes.ok) {
      return res.status(400).json({
        message: 'Could not access the Google Sheet. Make sure it is shared as "Anyone with the link can view".',
      })
    }

    const csvBuffer = Buffer.from(await csvRes.arrayBuffer())
    const parsed = await parseFile(csvBuffer, 'sheet.csv')
    if (parsed.error) return res.status(422).json({ message: parsed.error })

    const { rows, columns } = parsed
    if (!rows?.length) return res.status(422).json({ message: 'The Google Sheet appears to be empty.' })

    // Detect a sheet title from URL or use generic name
    const sheetName = `Google Sheet ${sheetId.slice(0, 8)}…`

    const schema = await detectDataSchema(columns, rows.slice(0, 100), 'sheet.csv')
    const kpiData = processKPIs(rows, columns, schema)

    // Create a user_file for this sheet data
    const { data: fileRecord, error: fileErr } = await supabase
      .from('user_files')
      .insert({
        user_id: req.user.id,
        original_name: sheetName,
        row_count: rows.length,
        columns,
        kpi_data: { ...kpiData, sampleRows: rows.slice(0, 20), source: 'google_sheets' },
      })
      .select('id')
      .single()

    if (fileErr) throw fileErr

    // Add to project
    await supabase.from('project_files').insert({ project_id: req.params.id, file_id: fileRecord.id })

    // Store integration record
    const { data: integration, error: intErr } = await supabase
      .from('integrations')
      .insert({
        user_id: req.user.id,
        project_id: req.params.id,
        type: 'google_sheets',
        name: sheetName,
        config: { sheetId, sheetUrl, fileId: fileRecord.id },
        status: 'connected',
        last_synced_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (intErr) throw intErr

    await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', req.params.id)

    res.json({ integration, rows: rows.length })
  } catch (err) {
    console.error('Google Sheets connect error:', err)
    res.status(500).json({ message: 'Could not connect Google Sheet. Make sure it is public.' })
  }
})

// ── Sync Google Sheet ─────────────────────────────────────────────────────────
router.put('/:id/sheets/:integrationId/sync', async (req, res) => {
  try {
    const { data: integration } = await supabase
      .from('integrations')
      .select('*')
      .eq('id', req.params.integrationId)
      .eq('user_id', req.user.id)
      .eq('project_id', req.params.id)
      .single()

    if (!integration) return res.status(404).json({ message: 'Integration not found' })

    const { sheetId, fileId } = integration.config || {}
    if (!sheetId) return res.status(400).json({ message: 'Integration missing sheet ID' })

    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`
    const csvRes = await fetch(csvUrl)
    if (!csvRes.ok) return res.status(400).json({ message: 'Could not fetch sheet. Check sharing settings.' })

    const csvBuffer = Buffer.from(await csvRes.arrayBuffer())
    const parsed = await parseFile(csvBuffer, 'sheet.csv')
    if (parsed.error || !parsed.rows?.length) return res.status(422).json({ message: 'Sheet is empty or unreadable.' })

    const { rows, columns } = parsed
    const schema = await detectDataSchema(columns, rows.slice(0, 100), 'sheet.csv')
    const kpiData = processKPIs(rows, columns, schema)

    if (fileId) {
      await supabase.from('user_files').update({
        row_count: rows.length,
        columns,
        kpi_data: { ...kpiData, sampleRows: rows.slice(0, 20), source: 'google_sheets' },
      }).eq('id', fileId)
    }

    await supabase.from('integrations').update({
      last_synced_at: new Date().toISOString(),
      status: 'connected',
    }).eq('id', req.params.integrationId)

    res.json({ message: 'Synced', rows: rows.length })
  } catch (err) {
    console.error('Sheet sync error:', err)
    res.status(500).json({ message: 'Sync failed.' })
  }
})

// ── Disconnect Google Sheet ───────────────────────────────────────────────────
router.delete('/:id/sheets/:integrationId', async (req, res) => {
  try {
    const { data: integration } = await supabase
      .from('integrations')
      .select('config')
      .eq('id', req.params.integrationId)
      .eq('user_id', req.user.id)
      .eq('project_id', req.params.id)
      .single()

    if (integration?.config?.fileId) {
      // Remove from project (but keep user_file)
      await supabase.from('project_files').delete()
        .eq('project_id', req.params.id)
        .eq('file_id', integration.config.fileId)
    }

    await supabase.from('integrations').delete().eq('id', req.params.integrationId)

    res.json({ message: 'Sheet disconnected' })
  } catch {
    res.status(500).json({ message: 'Could not disconnect sheet' })
  }
})

// ── Get project chat history ──────────────────────────────────────────────────
router.get('/:id/chat', async (req, res) => {
  try {
    const { data: project } = await supabase
      .from('projects').select('id').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!project) return res.status(404).json({ message: 'Project not found' })

    const { data } = await supabase
      .from('project_chats')
      .select('messages')
      .eq('project_id', req.params.id)
      .eq('user_id', req.user.id)
      .single()

    res.json({ messages: data?.messages || [] })
  } catch {
    res.json({ messages: [] })
  }
})

// ── Send project chat message ─────────────────────────────────────────────────
router.post('/:id/chat', checkMessageLimit, async (req, res) => {
  try {
    const { message } = req.body
    if (!message?.trim()) return res.status(400).json({ message: 'Message is required' })

    const { data: project } = await supabase
      .from('projects').select('id, name').eq('id', req.params.id).eq('user_id', req.user.id).single()
    if (!project) return res.status(404).json({ message: 'Project not found' })

    const { data: projectFiles } = await supabase
      .from('project_files')
      .select('user_files(original_name, row_count, kpi_data)')
      .eq('project_id', req.params.id)

    const { data: chatRecord } = await supabase
      .from('project_chats')
      .select('messages')
      .eq('project_id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle()

    const history = chatRecord?.messages || []

    const filesContext = (projectFiles || []).map(pf => {
      const f = pf.user_files
      if (!f?.kpi_data) return null
      const kpi = f.kpi_data
      return {
        file: f.original_name,
        rows: f.row_count,
        dataType: kpi.meta?.dataType,
        metricName: kpi.meta?.primaryMetricName,
        total: kpi.summary?.totalRevenue,
        trend: kpi.summary?.revenueTrend,
        bestPeriod: kpi.summary?.bestMonth,
        worstPeriod: kpi.summary?.worstMonth,
        topCategories: kpi.topProducts?.slice(0, 3),
      }
    }).filter(Boolean)

    const systemPrompt = `You are Okapi, an expert AI business analyst for project "${project.name}".
You have access to ${filesContext.length} file(s):
${JSON.stringify(filesContext, null, 2)}

Provide concise, specific, and actionable insights. Reference actual numbers from the data.
When asked to compare files, do so explicitly with numbers.
Respond in the same language as the user (Spanish if they write in Spanish).`

    const messages = [...history.slice(-12), { role: 'user', content: message }]

    let reply = ''
    let basicMode = false

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
      })
      reply = response.choices[0].message.content
    } catch (aiErr) {
      console.warn('OpenAI API unavailable, using rule-based fallback:', aiErr.message)
      basicMode = true
      reply = generateBasicChatReply(message, filesContext, project.name)
    }

    const newMessages = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }]

    await supabase.from('project_chats').upsert(
      {
        project_id: req.params.id,
        user_id: req.user.id,
        messages: newMessages.slice(-60),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,user_id' }
    )

    res.json({ reply, basicMode })
  } catch (err) {
    console.error('Project chat error:', err)
    res.status(500).json({ message: 'AI service error. Please try again.' })
  }
})

function generateBasicChatReply(message, filesContext, projectName) {
  const msg = message.toLowerCase()
  const hasFiles = filesContext.length > 0

  if (!hasFiles) {
    return `Este proyecto "${projectName}" aún no tiene archivos con datos. Subí un archivo Excel o CSV para que pueda analizar tu información.`
  }

  const f = filesContext[0]
  const fmtN = (n) => n != null ? `$${Number(n).toLocaleString('es-ES', { maximumFractionDigits: 0 })}` : 'N/A'
  const trend = f.trend != null ? (f.trend >= 0 ? `▲ +${f.trend.toFixed(1)}%` : `▼ ${f.trend.toFixed(1)}%`) : ''

  const totalValue = filesContext.reduce((sum, fc) => sum + (fc.total || 0), 0)
  const growth = f.trend || 0
  const summary = f.summary || ''

  const alerts = []
  filesContext.forEach(fc => {
    if (fc.trend < -10) alerts.push(`📉 ${fc.file}: tendencia negativa de ${fc.trend?.toFixed(1)}%`)
    if (fc.topCategories?.[0]?.share > 70) alerts.push(`⚠️ Alta concentración en ${fc.topCategories[0].name} (${fc.topCategories[0].share?.toFixed(0)}%)`)
  })

  const recommendations = []
  if (f.trend < 0) recommendations.push({ title: 'Investigar tendencia negativa', description: `La tendencia es ${f.trend?.toFixed(1)}%, revisá los períodos de caída` })
  if (f.topCategories?.[0]?.share > 70) recommendations.push({ title: 'Diversificar', description: `"${f.topCategories[0].name}" domina el ${f.topCategories[0].share?.toFixed(0)}%` })
  recommendations.push({ title: 'Análisis más profundo', description: 'Activá créditos en platform.openai.com para IA completa' })

  const topCategories = (f.topCategories || []).map(c => ({ name: c.name, value: c.revenue, percentage: c.share }))

  if (msg.includes('riesgo') || msg.includes('alerta') || msg.includes('problema')) {
    return alerts.length > 0
      ? `🚨 **Alertas detectadas:**\n${alerts.map(a => `• ${a}`).join('\n')}\n\n¿Querés que profundice en alguna?`
      : '✅ No detecté alertas críticas en tus datos actuales. El negocio parece estable.'
  }

  if (msg.includes('recomend') || msg.includes('hacer') || msg.includes('accion') || msg.includes('acción')) {
    return recommendations.length > 0
      ? `💡 **Recomendaciones basadas en tus datos:**\n${recommendations.slice(0, 3).map((r, i) => `${i + 1}. **${r.title}**: ${r.description}`).join('\n\n')}`
      : 'Subí más datos para recibir recomendaciones específicas.'
  }

  if (msg.includes('kpi') || msg.includes('metrica') || msg.includes('métrica') || msg.includes('numero') || msg.includes('dato')) {
    return `📊 **KPIs principales de "${projectName}":**\n• Total: ${fmtN(totalValue)}\n• Crecimiento: ${growth > 0 ? '+' : ''}${growth.toFixed(1)}%\n• Archivos analizados: ${filesContext.length}\n• Mejor período: ${f.bestPeriod?.month || 'N/A'} (${fmtN(f.bestPeriod?.revenue)})\n\n¿Sobre qué KPI específico querés saber más?`
  }

  if (msg.includes('resumen') || msg.includes('situacion') || msg.includes('situación') || msg.includes('como estoy') || msg.includes('cómo estoy')) {
    return summary
      ? `📋 **Resumen ejecutivo:**\n${summary}\n\n¿Querés profundizar en algún aspecto?`
      : `Tu proyecto tiene ${filesContext.length} archivo${filesContext.length > 1 ? 's' : ''} con ${totalValue > 0 ? fmtN(totalValue) + ' en valor total' : 'datos cargados'}. Tendencia: ${trend}. Subí más archivos para un análisis completo.`
  }

  if (msg.includes('categoria') || msg.includes('categoría') || msg.includes('producto') || msg.includes('proveedor')) {
    return topCategories.length > 0
      ? `🏆 **Top categorías:**\n${topCategories.slice(0, 5).map((c, i) => `${i + 1}. ${c.name}: ${fmtN(c.value)} (${(c.percentage || 0).toFixed(1)}%)`).join('\n')}`
      : 'No encontré datos de categorías. ¿Podés confirmar que tu archivo tiene una columna de categorías o productos?'
  }

  if (msg.includes('periodo') || msg.includes('período') || msg.includes('compar')) {
    return `📅 **Comparación de períodos en "${projectName}":**\n• Mejor: ${f.bestPeriod?.month || 'N/A'} — ${fmtN(f.bestPeriod?.revenue)}\n• Peor: ${f.worstPeriod?.month || 'N/A'} — ${fmtN(f.worstPeriod?.revenue)}\n• Tendencia general: ${trend}`
  }

  if (msg.includes('hola') || msg.includes('buenas') || msg.includes('hey')) {
    return `¡Hola! 👋 Soy Okapi, tu asistente de análisis de datos.\n\nEl proyecto "${projectName}" tiene **${filesContext.length} archivo${filesContext.length > 1 ? 's' : ''}** analizados.\n\nPodés preguntarme sobre:\n• 📊 KPIs y métricas\n• 🚨 Riesgos y alertas\n• 💡 Recomendaciones\n• 📋 Resumen ejecutivo\n• 🏆 Top categorías\n\n¿Por dónde empezamos?`
  }

  return `Basado en los datos de "${projectName}":\n• **Total analizado:** ${fmtN(totalValue)}\n• **Tendencia:** ${trend}\n• **Archivos:** ${filesContext.length}\n\n💡 *Para análisis más profundo con IA, activá créditos en platform.openai.com*\n\nPreguntame sobre: riesgos, recomendaciones, KPIs, resumen o categorías.`
}

export default router
