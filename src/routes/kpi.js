import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import { runDeepAnalysis } from '../services/analysisService.js'

const router = Router()
router.use(requireAuth)

router.get('/:fileId', async (req, res) => {
  const { data, error } = await supabase
    .from('user_files')
    .select('kpi_data, original_name, columns')
    .eq('id', req.params.fileId)
    .eq('user_id', req.user.id)
    .single()

  if (error || !data) {
    return res.status(404).json({ message: 'File not found' })
  }

  const kpiData = data.kpi_data

  // Lazy analysis: generate on first fetch if background job hasn't completed yet
  if (!kpiData?.analysis && kpiData?.sampleRows?.length > 0) {
    try {
      const cols = kpiData.sampleColumns || data.columns || Object.keys(kpiData.sampleRows[0] || {})
      const analysis = await Promise.race([
        runDeepAnalysis(kpiData.sampleRows, cols, kpiData),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))
      ])
      kpiData.analysis = analysis

      // Cache in Supabase (don't await — return response immediately)
      supabase.from('user_files')
        .update({ kpi_data: { ...kpiData, analysis } })
        .eq('id', req.params.fileId)
        .then(() => console.log(`[Analysis] Lazy cache stored for ${req.params.fileId}`))
        .catch(console.warn)

    } catch (err) {
      console.warn('[Analysis] Lazy generation failed, client gets null analysis:', err.message)
    }
  }

  res.json(kpiData)
})

export default router
