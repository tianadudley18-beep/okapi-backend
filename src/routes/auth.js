import { Router } from 'express'
import { body, validationResult } from 'express-validator'
import { supabase } from '../config/supabase.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.post('/register',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('fullName').trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg })
    }

    const { email, password, fullName } = req.body
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { full_name: fullName },
      email_confirm: true,
    })

    if (error) return res.status(400).json({ message: error.message })
    res.status(201).json({ message: 'Account created successfully', userId: data.user.id })
  }
)

router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    fullName: req.user.user_metadata?.full_name,
    createdAt: req.user.created_at,
  })
})

export default router
