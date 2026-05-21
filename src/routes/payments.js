import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
  stripe,
  stripeEnabled,
} from '../services/stripeService.js'

const stripeRequired = (_req, res, next) => {
  if (!stripeEnabled) return res.status(503).json({ message: 'Payments not configured' })
  next()
}

const router = Router()

router.post('/checkout', requireAuth, stripeRequired, async (req, res) => {
  const { plan } = req.body
  if (!['monthly', 'annual'].includes(plan)) {
    return res.status(400).json({ message: 'Invalid plan. Choose monthly or annual.' })
  }

  try {
    const result = await createCheckoutSession(req.user.id, req.user.email, plan)
    res.json(result)
  } catch (err) {
    console.error('Stripe checkout error:', err)
    res.status(500).json({ message: err.message })
  }
})

router.post('/portal', requireAuth, stripeRequired, async (req, res) => {
  try {
    const { data } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', req.user.id)
      .single()

    if (!data?.stripe_customer_id) {
      return res.status(400).json({ message: 'No active subscription found.' })
    }

    const result = await createPortalSession(data.stripe_customer_id)
    res.json(result)
  } catch (err) {
    console.error('Portal session error:', err)
    res.status(500).json({ message: err.message })
  }
})

router.get('/subscription', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  res.json({ subscription: data || null })
})

router.post('/webhook', stripeRequired, async (req, res) => {
  const sig = req.headers['stripe-signature']

  let event
  try {
    event = await handleWebhookEvent(req.body, sig)
  } catch (err) {
    console.error('Webhook signature error:', err.message)
    return res.status(400).json({ message: `Webhook error: ${err.message}` })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const { userId, plan } = session.metadata

        // Get Stripe subscription details
        const stripeSub = await stripe.subscriptions.retrieve(session.subscription)

        await supabase.from('subscriptions').upsert({
          user_id: userId,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          plan,
          status: 'active',
          current_period_end: stripeSub.current_period_end,
        }, { onConflict: 'user_id' })
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object
        const userId = sub.metadata?.userId
        if (userId) {
          await supabase.from('subscriptions')
            .update({
              status: sub.status,
              current_period_end: sub.current_period_end,
            })
            .eq('stripe_subscription_id', sub.id)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object
        await supabase.from('subscriptions')
          .update({ status: 'canceled' })
          .eq('stripe_subscription_id', sub.id)
        break
      }
    }

    res.json({ received: true })
  } catch (err) {
    console.error('Webhook processing error:', err)
    res.status(500).json({ message: 'Webhook processing failed' })
  }
})

export default router
