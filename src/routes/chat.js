import { Router } from 'express'
import { body, validationResult } from 'express-validator'
import { requireAuth } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import { getChatResponse } from '../services/aiService.js'
import { checkMessageLimit } from '../middleware/checkMessageLimit.js'

const router = Router()

router.use(requireAuth)

router.post('/',
  body('message').trim().notEmpty().isLength({ max: 2000 }),
  body('fileId').notEmpty(),
  checkMessageLimit,
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg })
    }

    const { message, fileId } = req.body
    const userId = req.user.id

    // Get file KPI data
    const { data: fileData, error: fileError } = await supabase
      .from('user_files')
      .select('kpi_data')
      .eq('id', fileId)
      .eq('user_id', userId)
      .single()

    if (fileError || !fileData) {
      return res.status(404).json({ message: 'File not found' })
    }

    // Get recent conversation history
    const { data: history } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('user_id', userId)
      .eq('file_id', fileId)
      .order('created_at', { ascending: false })
      .limit(10)

    const conversationHistory = (history || []).reverse()

    try {
      const reply = await getChatResponse(message, fileData.kpi_data, conversationHistory)

      // Save messages
      await supabase.from('chat_messages').insert([
        { user_id: userId, file_id: fileId, role: 'user', content: message },
        { user_id: userId, file_id: fileId, role: 'assistant', content: reply },
      ])

      res.json({ reply })
    } catch (err) {
      console.error('AI error:', err)
      res.status(500).json({ message: 'AI service error. Please try again.' })
    }
  }
)

router.get('/history/:fileId', async (req, res) => {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('user_id', req.user.id)
    .eq('file_id', req.params.fileId)
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) return res.status(500).json({ message: error.message })
  res.json({ messages: data })
})

export default router
