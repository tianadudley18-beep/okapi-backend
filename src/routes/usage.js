import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import { PLAN_LIMITS } from '../config/plans.js'

const router = Router()
router.use(requireAuth)

function getCurrentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getPlanFromSubscription(subscription) {
  if (!subscription || subscription.status !== 'active') return 'free'
  const priceId = subscription.stripe_price_id || ''
  if (priceId === process.env.STRIPE_ANNUAL_PRICE_ID) return 'annual'
  if (priceId === process.env.STRIPE_MONTHLY_PRICE_ID) return 'monthly'
  return 'free'
}

router.get('/messages', async (req, res) => {
  try {
    const userId = req.user.id
    const month = getCurrentMonth()

    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('status, stripe_price_id')
      .eq('user_id', userId)
      .maybeSingle()

    const plan = getPlanFromSubscription(subscription)
    const limits = PLAN_LIMITS[plan]
    const limit = limits.aiMessagesPerMonth

    const { data: usage } = await supabase
      .from('message_usage')
      .select('messages_used')
      .eq('user_id', userId)
      .eq('month', month)
      .maybeSingle()

    const used = usage?.messages_used || 0

    const nextMonth = new Date()
    nextMonth.setMonth(nextMonth.getMonth() + 1)
    nextMonth.setDate(1)
    const resetDate = nextMonth.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })

    const unlimited = limit >= 999999
    const remaining = unlimited ? 999999 : Math.max(0, limit - used)
    const percentage = unlimited ? 0 : Math.round((used / limit) * 100)

    res.json({ plan, used, limit: unlimited ? null : limit, remaining, resetDate, percentage, unlimited })
  } catch (err) {
    console.error('Usage error:', err)
    res.status(500).json({ message: 'Could not load usage' })
  }
})

export default router
