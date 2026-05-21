import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { upload } from '../middleware/upload.js'
import { supabase } from '../config/supabase.js'
import { parseFile } from '../services/dataParser.js'
import { processKPIs } from '../services/kpiProcessor.js'
import { detectDataSchema } from '../services/dataDetector.js'
import { runDeepAnalysis } from '../services/analysisService.js'
import { checkAndCreateAlerts } from '../services/alertsService.js'

const router = Router()
router.use(requireAuth)

// ── Upload ───────────────────────────────────────────────────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  // Multer error (wrong type, too large) is caught by the error handler below
  if (!req.file) {
    return res.status(400).json({
      code: 'no_file',
      message: 'No file was received. Please select a file and try again.',
    })
  }

  const { originalname, buffer } = req.file
  const userId = req.user.id

  try {
    // ── 1. Parse ─────────────────────────────────────────────────────────────
    const parsed = await parseFile(buffer, originalname)

    // Parser returned a hard error (e.g. .xls format)
    if (parsed.error) {
      return res.status(422).json({ code: 'parse_error', message: parsed.error })
    }

    const { rows, columns, warnings: parseWarnings = [] } = parsed

    if (!rows || rows.length === 0) {
      return res.status(422).json({
        code: 'empty_file',
        message: 'The file appears to be empty or has no readable data rows. Please check the file and try again.',
      })
    }

    if (columns.length < 2) {
      return res.status(422).json({
        code: 'too_few_columns',
        message: `Only ${columns.length} column was found. Please upload a file with at least 2 columns to generate insights.`,
      })
    }

    // ── 2. Detect schema ─────────────────────────────────────────────────────
    let schema = {}
    try {
      schema = await detectDataSchema(columns, rows, originalname)
    } catch (detErr) {
      console.warn('Schema detection failed, continuing with heuristics:', detErr.message)
      // processKPIs handles missing schema gracefully
    }

    // ── 3. Process KPIs ──────────────────────────────────────────────────────
    const kpiData = processKPIs(rows, columns, schema)

    if (kpiData.error) {
      return res.status(422).json({ code: kpiData.error, message: kpiData.errorMessage })
    }

    // Merge parse warnings into meta
    if (parseWarnings.length > 0) {
      kpiData.meta.parseWarnings = parseWarnings
    }

    // ── 4. Cache AI detection + sample rows ──────────────────────────────────
    kpiData.schema = schema             // Cache: AI column detection result
    kpiData.sampleRows = rows.slice(0, 20)
    kpiData.sampleColumns = columns

    // ── 5. Store ─────────────────────────────────────────────────────────────
    const { data: fileRecord, error: dbError } = await supabase
      .from('user_files')
      .insert({
        user_id: userId,
        original_name: originalname,
        row_count: rows.length,
        columns,
        kpi_data: kpiData,
      })
      .select()
      .single()

    if (dbError) throw dbError

    res.json({
      message: 'File processed successfully',
      fileId: fileRecord.id,
      fileName: originalname,
      rowCount: rows.length,
      validRows: kpiData.meta?.validRows ?? rows.length,
      warnings: [...(parseWarnings), ...(kpiData.meta?.warnings ?? [])],
      detectedColumns: kpiData.detectedColumns,
      dataType: kpiData.meta?.dataType,
      dataLabel: kpiData.meta?.dataLabel,
    })

    // Background: run deep analysis, trigger alerts (non-blocking)
    setImmediate(async () => {
      try {
        const analysis = await Promise.race([
          runDeepAnalysis(rows.slice(0, 20), columns, kpiData),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 45000))
        ])
        await supabase.from('user_files')
          .update({ kpi_data: { ...kpiData, analysis, sampleRows: kpiData.sampleRows } })
          .eq('id', fileRecord.id)
        console.log(`[Analysis] Cached for file ${fileRecord.id}`)
      } catch (err) {
        console.warn(`[Analysis] Background analysis failed for ${fileRecord.id}:`, err.message)
      }
      // Check KPI thresholds and create alerts
      try {
        await checkAndCreateAlerts(userId, fileRecord.id, kpiData)
      } catch (err) {
        console.warn(`[Alerts] Check failed for ${fileRecord.id}:`, err.message)
      }
    })
  } catch (err) {
    console.error('Upload error:', err)

    // Give contextual messages for known failure modes
    const msg = err.message || ''
    if (msg.includes('password') || msg.includes('encrypted')) {
      return res.status(422).json({
        code: 'encrypted_file',
        message: 'This file appears to be password-protected. Please remove the password and try again.',
      })
    }
    if (msg.includes('zip') || msg.includes('corrupt') || msg.includes('Invalid')) {
      return res.status(422).json({
        code: 'corrupt_file',
        message: 'The file could not be read — it may be corrupted. Try re-saving it from Excel or another app.',
      })
    }

    res.status(500).json({
      code: 'server_error',
      message: 'Something went wrong while processing your file. Please try again.',
    })
  }
})

// Multer error handler (wrong file type, too large)
router.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      code: 'file_too_large',
      message: 'File exceeds the 10 MB limit. Please split the file or remove unused columns.',
    })
  }
  if (err?.message?.includes('Only .xlsx')) {
    return res.status(415).json({
      code: 'wrong_file_type',
      message: 'Only Excel (.xlsx) and CSV files are supported. Please convert your file and try again.',
    })
  }
  res.status(400).json({ code: 'upload_error', message: err?.message || 'Upload failed.' })
})

// ── List files ───────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_files')
      .select('id, original_name, row_count, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ files: data || [] })
  } catch {
    res.json({ files: [] }) // always return a usable response
  }
})

// ── Delete file ──────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('user_files')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)

    if (error) throw error
    res.json({ message: 'File deleted' })
  } catch {
    res.status(500).json({ message: 'Could not delete file. Please try again.' })
  }
})

export default router
