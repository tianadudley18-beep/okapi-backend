import Stripe from 'stripe'

const stripeKey = process.env.STRIPE_SECRET_KEY
export const stripe = stripeKey ? new Stripe(stripeKey) : null
export const stripeEnabled = Boolean(stripe)

const PRICE_IDS = {
  monthly: process.env.STRIPE_MONTHLY_PRICE_ID,
  annual: process.env.STRIPE_ANNUAL_PRICE_ID,
}

export async function createCheckoutSession(userId, userEmail, plan) {
  if (!stripe) throw new Error('Stripe is not configured')
  if (!PRICE_IDS[plan]) throw new Error(`Unknown plan: ${plan}`)

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: userEmail,
    line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/subscription?success=1`,
    cancel_url: `${process.env.FRONTEND_URL}/subscription?canceled=1`,
    metadata: { userId, plan },
    subscription_data: { metadata: { userId, plan } },
  })

  return { url: session.url, sessionId: session.id }
}

export async function handleWebhookEvent(rawBody, sig) {
  if (!stripe) throw new Error('Stripe is not configured')
  const event = stripe.webhooks.constructEvent(
    rawBody,
    sig,
    process.env.STRIPE_WEBHOOK_SECRET
  )
  return event
}

export async function getCustomerSubscription(customerId) {
  if (!stripe) throw new Error('Stripe is not configured')
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'active',
    limit: 1,
  })
  return subscriptions.data[0] || null
}

export async function createPortalSession(customerId) {
  if (!stripe) throw new Error('Stripe is not configured')
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${process.env.FRONTEND_URL}/subscription`,
  })
  return { url: session.url }
}
