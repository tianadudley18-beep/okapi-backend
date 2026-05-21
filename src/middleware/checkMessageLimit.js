import { supabase } from '../config/supabase.js'
import { PLAN_LIMITS } from '../config/plans.js'

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

export async function checkMessageLimit(req, res, next) {
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

    if (limit >= 999999) {
      req.messagePlan = { plan, limit, unlimited: true }
      return next()
    }

    const { data: usage, error } = await supabase
      .from('message_usage')
      .select('messages_used')
      .eq('user_id', userId)
      .eq('month', month)
      .maybeSingle()

    if (error) {
      console.error('checkMessageLimit error:', error.message)
      return next()
    }

    const used = usage?.messages_used || 0

    if (used >= limit) {
      const nextMonth = new Date()
      nextMonth.setMonth(nextMonth.getMonth() + 1)
      nextMonth.setDate(1)
      const resetDate = nextMonth.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })

      return res.status(429).json({
        error: 'limit_reached',
        plan,
        used,
        limit,
        message: `Alcanzaste el límite de mensajes de tu plan ${limits.name.toLowerCase()}.`,
        upgradeMessage: plan === 'free'
          ? 'Actualizá al plan mensual para 150 mensajes/mes.'
          : 'Considerá el plan anual para mensajes ilimitados.',
        resetDate,
      })
    }

    // Increment usage
    await supabase
      .from('message_usage')
      .upsert(
        { user_id: userId, month, messages_used: used + 1, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,month' }
      )

    req.messagePlan = { plan, used: used + 1, limit }
    next()
  } catch (err) {
    console.error('checkMessageLimit unexpected error:', err.message)
    next()
  }
}
