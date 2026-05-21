import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'

const router = Router()
router.use(requireAuth)

// GET /api/integrations - list user's connected sources
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('integrations')
      .select('*')
      .eq('user_id', req.user.id)

    if (error) throw error
    res.json({ integrations: data || [] })
  } catch {
    res.json({ integrations: [] })
  }
})

// POST /api/integrations/google-sheets - connect a Google Sheet
router.post('/google-sheets', async (req, res) => {
  try {
    const { sheetUrl } = req.body
    if (!sheetUrl?.trim()) return res.status(400).json({ message: 'Sheet URL is required' })

    // Extract sheet ID from URL
    const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
    if (!match) return res.status(400).json({ message: 'Invalid Google Sheets URL. Paste the full URL from your browser.' })

    const sheetId = match[1]

    if (!process.env.GOOGLE_SHEETS_API_KEY) {
      return res.status(503).json({
        message: 'Google Sheets integration not configured. Add GOOGLE_SHEETS_API_KEY to server .env',
        code: 'not_configured',
      })
    }

    // Fetch sheet metadata
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?key=${process.env.GOOGLE_SHEETS_API_KEY}`
    const metaRes = await fetch(metaUrl)
    if (!metaRes.ok) {
      const err = await metaRes.json().catch(() => ({}))
      return res.status(400).json({ message: err.error?.message || 'Could not access sheet. Make sure it is shared publicly.' })
    }

    const meta = await metaRes.json()
    const title = meta.properties?.title || 'Google Sheet'
    const sheets = meta.sheets?.map(s => s.properties.title) || []

    // Store the connection
    const { data, error } = await supabase
      .from('integrations')
      .upsert({
        user_id: req.user.id,
        type: 'google_sheets',
        name: title,
        config: { sheetId, sheetUrl, sheets },
        status: 'connected',
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'user_id,type,config->>sheetId' })
      .select()
      .single()

    if (error) throw error
    res.json({ integration: data, title, sheets })
  } catch (err) {
    console.error('Google Sheets connect error:', err)
    res.status(500).json({ message: 'Could not connect Google Sheet. Please try again.' })
  }
})

// DELETE /api/integrations/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('integrations')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)

    if (error) throw error
    res.json({ message: 'Integration disconnected' })
  } catch {
    res.status(500).json({ message: 'Could not disconnect integration' })
  }
})

export default router
