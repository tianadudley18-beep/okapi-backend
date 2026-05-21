import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'

const router = Router()
router.use(requireAuth)

// GET /api/alerts
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const { data, error } = await supabase
      .from('alerts')
      .select('*')
      .eq('user_id', req.user.id)
      .order('triggered_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    res.json({ alerts: data || [] })
  } catch {
    res.status(500).json({ message: 'Could not load alerts' })
  }
})

// GET /api/alerts/unread-count
router.get('/unread-count', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('alerts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false)

    if (error) throw error
    res.json({ count: count || 0 })
  } catch {
    res.json({ count: 0 })
  }
})

// PUT /api/alerts/read-all  — must come before /:id route
router.put('/read-all', async (req, res) => {
  try {
    const { error } = await supabase
      .from('alerts')
      .update({ is_read: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false)

    if (error) throw error
    res.json({ message: 'All alerts marked as read' })
  } catch {
    res.status(500).json({ message: 'Could not update alerts' })
  }
})

// PUT /api/alerts/:id/read
router.put('/:id/read', async (req, res) => {
  try {
    const { error } = await supabase
      .from('alerts')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)

    if (error) throw error
    res.json({ message: 'Alert marked as read' })
  } catch {
    res.status(500).json({ message: 'Could not update alert' })
  }
})

export default router
