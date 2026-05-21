import { supabase } from '../config/supabase.js'

export async function createAlert({ userId, projectId, fileId, type, message, severity = 'medium' }) {
  try {
    const { data, error } = await supabase
      .from('alerts')
      .insert({
        user_id: userId,
        project_id: projectId || null,
        file_id: fileId || null,
        type,
        message,
        severity,
        is_read: false,
      })
      .select()
      .single()

    if (error) throw error
    return data
  } catch (err) {
    console.error('Failed to create alert:', err.message)
    return null
  }
}

export async function checkAndCreateAlerts(userId, fileId, kpiData, projectId = null) {
  const { summary, meta } = kpiData
  if (!summary) return []

  const toCreate = []

  if ((summary.consecutiveDeclines || 0) >= 3) {
    toCreate.push({
      type: 'consecutive_decline',
      message: `${summary.consecutiveDeclines} períodos consecutivos en declive en ${meta?.dataLabel || 'tus datos'}`,
      severity: 'critical',
    })
  }

  if ((summary.topCategoryShare || 0) > 80) {
    toCreate.push({
      type: 'concentration_risk',
      message: `Riesgo de concentración crítico: un segmento representa el ${summary.topCategoryShare.toFixed(1)}% del total`,
      severity: 'high',
    })
  }

  if ((summary.revenueTrend || 0) < -25) {
    toCreate.push({
      type: 'sharp_decline',
      message: `Caída severa de ${Math.abs(summary.revenueTrend).toFixed(1)}% en ${meta?.primaryMetricName || 'métricas clave'}`,
      severity: 'critical',
    })
  }

  if ((summary.revenueTrend || 0) > 50) {
    toCreate.push({
      type: 'sudden_spike',
      message: `Pico inusual: ${meta?.primaryMetricName || 'Métrica'} subió ${summary.revenueTrend.toFixed(1)}% — verificar si es real`,
      severity: 'medium',
    })
  }

  const created = []
  for (const alert of toCreate) {
    const result = await createAlert({ userId, projectId, fileId, ...alert })
    if (result) created.push(result)
  }

  return created
}
