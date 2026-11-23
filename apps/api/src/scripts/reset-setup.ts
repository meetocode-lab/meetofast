import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
if (!args.includes('--confirm')) {
  console.error('Usage: npm --workspace @meofast/api run setup:reset -- --confirm')
  console.error(
    'WARNING: This removes install.lock and config.enc.json so the Setup Wizard can run again.',
  )
  process.exit(1)
}

const dataDir = path.resolve(process.env.MEOFAST_DATA_DIR ?? path.join(process.cwd(), 'data'))
for (const filename of ['install.lock', 'config.enc.json']) {
  const filePath = path.join(dataDir, filename)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
    console.log(`Removed ${filePath}`)
  }
}

console.log('Setup lock cleared. Restart the API server to enter bootstrap setup mode.')
