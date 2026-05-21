import multer from 'multer'
import path from 'path'

const storage = multer.memoryStorage()

const fileFilter = (_req, file, cb) => {
  const allowed = ['.xlsx', '.csv']
  const ext = path.extname(file.originalname).toLowerCase()
  if (allowed.includes(ext)) {
    cb(null, true)
  } else {
    cb(new Error('Only .xlsx and .csv files are allowed'), false)
  }
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
})
