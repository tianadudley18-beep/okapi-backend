import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import authRoutes from './routes/auth.js'
import fileRoutes from './routes/files.js'
import kpiRoutes from './routes/kpi.js'
import chatRoutes from './routes/chat.js'
import paymentRoutes from './routes/payments.js'
import projectRoutes from './routes/projects.js'
import alertRoutes from './routes/alerts.js'
import integrationRoutes from './routes/integrations.js'
import usageRoutes from './routes/usage.js'
import { startWeeklyDigestCron } from './services/weeklyDigest.js'
import { supabase } from './config/supabase.js'

const app = express()
const PORT = process.env.PORT || 3001

// Simple request logger
app.use((req, _res, next) => {
  const start = Date.now()
  _res.on('finish', () => {
    const ms = Date.now() - start
    const level = _res.statusCode >= 500 ? 'ERROR' : _res.statusCode >= 400 ? 'WARN' : 'INFO'
    console.log(`[${level}] ${req.method} ${req.path} ${_res.statusCode} ${ms}ms`)
  })
  next()
})

const corsOptions = {
  origin: [
    'http://localhost:5173',
    'https://okapi-frontend.vercel.app',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
}
app.use(cors(corsOptions))

// Raw body for Stripe webhooks
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

app.use('/api/auth', authRoutes)
app.use('/api/files', fileRoutes)
app.use('/api/kpi', kpiRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/payments', paymentRoutes)
app.use('/api/projects', projectRoutes)
app.use('/api/alerts', alertRoutes)
app.use('/api/integrations', integrationRoutes)
app.use('/api/usage', usageRoutes)

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`)
  if (!process.env.STRIPE_SECRET_KEY) console.warn('Stripe not configured — payment routes disabled')
  startWeeklyDigestCron()
  startMessageUsageResetCron()
})

async function startMessageUsageResetCron() {
  try {
    const { default: cron } = await import('node-cron')
    // Run at midnight on the 1st of every month
    cron.schedule('0 0 1 * *', async () => {
      console.log('[Cron] Resetting monthly message usage counts')
      try {
        const prevMonth = new Date()
        prevMonth.setMonth(prevMonth.getMonth() - 1)
        const month = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`
        await supabase.from('message_usage').delete().eq('month', month)
        console.log('[Cron] Message usage reset complete for month:', month)
      } catch (err) {
        console.error('[Cron] Message usage reset error:', err.message)
      }
    }, { timezone: 'America/Argentina/Buenos_Aires' })
  } catch {
    console.warn('node-cron not available — monthly usage reset disabled')
  }
}
