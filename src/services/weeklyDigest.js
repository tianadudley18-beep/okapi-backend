import { supabase } from '../config/supabase.js'

let nodemailer = null
let nodecron = null

async function loadDeps() {
  try {
    const nm = await import('nodemailer')
    nodemailer = nm.default
  } catch {
    console.warn('[WeeklyDigest] nodemailer not installed — email sending disabled')
  }
  try {
    const nc = await import('node-cron')
    nodecron = nc.default
  } catch {
    console.warn('[WeeklyDigest] node-cron not installed — scheduled digest disabled')
  }
}

function createTransporter() {
  if (!nodemailer) return null
  const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM } = process.env
  if (!EMAIL_HOST || !EMAIL_USER || !EMAIL_PASS) return null
  return nodemailer.createTransport({
    host: EMAIL_HOST,
    port: parseInt(EMAIL_PORT) || 587,
    secure: parseInt(EMAIL_PORT) === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  })
}

function computeOkapiScore(kpi) {
  const s = kpi.summary || {}
  let growth = s.revenueTrend >= 10 ? 30 : s.revenueTrend >= 0 ? 15 : 0
  let stability = s.consecutiveDeclines === 0 ? 20 : s.consecutiveDeclines <= 1 ? 10 : 0
  let diversification = s.topCategoryShare <= 60 ? 25 : s.topCategoryShare <= 80 ? 12 : 0
  let trend = s.latestMomGrowth == null ? 12 : s.latestMomGrowth >= 5 ? 25 : s.latestMomGrowth >= 0 ? 12 : 0
  return growth + stability + diversification + trend
}

function scoreLabel(s) {
  if (s >= 91) return '✨ Excelente'
  if (s >= 76) return '🟢 Saludable'
  if (s >= 61) return '🟡 Estable'
  if (s >= 41) return '🟠 En riesgo'
  return '🔴 Crítico'
}

function fmt(n) {
  if (n == null) return 'N/A'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${Number(n).toLocaleString('es-ES', { maximumFractionDigits: 0 })}`
}

async function sendDigestForUser(transporter, user, projects) {
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER
  const date = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })

  const projectSections = await Promise.all(projects.map(async p => {
    const { data: files } = await supabase
      .from('project_files')
      .select('user_files(kpi_data, row_count)')
      .eq('project_id', p.id)
      .limit(5)

    const kpis = (files || []).map(pf => pf.user_files?.kpi_data).filter(Boolean)
    if (!kpis.length) return null

    const totalRevenue = kpis.reduce((s, k) => s + (k.summary?.totalRevenue || 0), 0)
    const avgTrend = kpis.reduce((s, k) => s + (k.summary?.revenueTrend || 0), 0) / kpis.length
    const consecutiveDeclines = Math.max(...kpis.map(k => k.summary?.consecutiveDeclines || 0))
    const score = computeOkapiScore({ summary: { revenueTrend: avgTrend, consecutiveDeclines, topCategoryShare: kpis[0]?.summary?.topCategoryShare, latestMomGrowth: kpis[0]?.summary?.latestMomGrowth } })
    const trendStr = avgTrend >= 0 ? `▲ +${avgTrend.toFixed(1)}%` : `▼ ${avgTrend.toFixed(1)}%`

    let alert = ''
    if (consecutiveDeclines >= 3) alert = `⚠️ Alerta: ${consecutiveDeclines} períodos consecutivos en declive`
    else if (kpis[0]?.summary?.topCategoryShare > 80) alert = `⚠️ Alta concentración en una categoría (${kpis[0].summary.topCategoryShare.toFixed(0)}%)`

    let recommendation = ''
    if (avgTrend < -10) recommendation = 'Revisá las causas de la caída y considerá ajustar tu estrategia de producto o canal de venta.'
    else if (avgTrend > 20) recommendation = 'Buen momento para consolidar el crecimiento — considerá reinvertir en las categorías líderes.'
    else recommendation = 'Mantén el monitoreo semanal y revisá la diversificación de categorías.'

    return {
      name: p.name,
      score,
      scoreLabel: scoreLabel(score),
      total: fmt(totalRevenue),
      trend: trendStr,
      alert,
      recommendation,
    }
  }))

  const validSections = projectSections.filter(Boolean)
  if (!validSections.length) return

  const emailBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 20px; color: #1a1a2e;">
  <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 24px; border-radius: 16px; color: white; margin-bottom: 24px;">
    <h1 style="margin: 0; font-size: 22px;">📊 Resumen semanal de Okapi</h1>
    <p style="margin: 4px 0 0; opacity: 0.85; font-size: 14px;">${date}</p>
  </div>

  ${validSections.map(s => `
  <div style="border: 1px solid #e5e7eb; border-radius: 16px; padding: 20px; margin-bottom: 16px;">
    <h2 style="margin: 0 0 12px; font-size: 16px; color: #1a1a2e;">${s.name}</h2>
    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px;">
      <div style="background: #f9fafb; border-radius: 10px; padding: 12px; text-align: center;">
        <p style="margin: 0; font-size: 11px; color: #6b7280;">Okapi Score</p>
        <p style="margin: 4px 0 0; font-size: 18px; font-weight: 700; color: #6366f1;">${s.score}/100</p>
        <p style="margin: 2px 0 0; font-size: 10px; color: #9ca3af;">${s.scoreLabel}</p>
      </div>
      <div style="background: #f9fafb; border-radius: 10px; padding: 12px; text-align: center;">
        <p style="margin: 0; font-size: 11px; color: #6b7280;">Total</p>
        <p style="margin: 4px 0 0; font-size: 16px; font-weight: 700;">${s.total}</p>
      </div>
      <div style="background: #f9fafb; border-radius: 10px; padding: 12px; text-align: center;">
        <p style="margin: 0; font-size: 11px; color: #6b7280;">Tendencia</p>
        <p style="margin: 4px 0 0; font-size: 16px; font-weight: 700;">${s.trend}</p>
      </div>
    </div>
    ${s.alert ? `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 10px; margin-bottom: 12px; font-size: 13px; color: #92400e;">${s.alert}</div>` : ''}
    <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 10px; font-size: 13px; color: #1e40af;">
      💡 <strong>Recomendación:</strong> ${s.recommendation}
    </div>
  </div>
  `).join('')}

  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>Este resumen fue generado automáticamente por Okapi.</p>
    <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/projects" style="color: #6366f1; text-decoration: none; font-weight: 600;">Ver mis proyectos →</a>
  </div>
</body>
</html>
  `

  await transporter.sendMail({
    from: `"Okapi Analytics" <${from}>`,
    to: user.email,
    subject: `📊 Tu resumen semanal de Okapi — ${date}`,
    html: emailBody,
  })

  console.log(`[WeeklyDigest] Sent to ${user.email}`)
}

export async function sendWeeklyDigests() {
  const transporter = createTransporter()
  if (!transporter) {
    console.log('[WeeklyDigest] Email not configured — skipping')
    return
  }

  try {
    const { data: projects } = await supabase
      .from('projects')
      .select('id, name, user_id')
      .order('updated_at', { ascending: false })

    if (!projects?.length) return

    const userProjectMap = {}
    projects.forEach(p => {
      if (!userProjectMap[p.user_id]) userProjectMap[p.user_id] = []
      userProjectMap[p.user_id].push(p)
    })

    for (const [userId, userProjects] of Object.entries(userProjectMap)) {
      try {
        const { data: { user } } = await supabase.auth.admin.getUserById(userId)
        if (!user?.email) continue
        await sendDigestForUser(transporter, user, userProjects)
      } catch (err) {
        console.error(`[WeeklyDigest] Error for user ${userId}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[WeeklyDigest] Fatal error:', err.message)
  }
}

export async function startWeeklyDigestCron() {
  await loadDeps()
  if (!nodecron) {
    console.log('[WeeklyDigest] node-cron not available — cron not started')
    return
  }
  // Every Monday at 8:00 AM
  nodecron.schedule('0 8 * * 1', () => {
    console.log('[WeeklyDigest] Running weekly digest...')
    sendWeeklyDigests()
  }, { timezone: 'America/Argentina/Buenos_Aires' })

  console.log('[WeeklyDigest] Cron scheduled — Mondays at 8:00 AM ART')
}
