import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import Router from '@koa/router'
import jwt from 'jwt-simple'
import { Pool } from 'pg'
import crypto from 'node:crypto'

const PORT = parseInt(process.env.PORT ?? '3500', 10)
const SERVER_SECRET = process.env.SERVER_SECRET
const DB_URL = process.env.DB_URL

if (!SERVER_SECRET) throw new Error('SERVER_SECRET is required')
if (!DB_URL) throw new Error('DB_URL is required')

const pool = new Pool({ connectionString: DB_URL })

// ── Ensure token metadata table exists ───────────────────────────────

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS global_account.api_tokens (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      workspace  TEXT NOT NULL,
      account_uuid TEXT NOT NULL,
      workspace_uuid TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked    BOOLEAN NOT NULL DEFAULT false
    )
  `)
}

// ── UUID lookups ─────────────────────────────────────────────────────

async function lookupAccountUuid(email: string): Promise<string | null> {
  const res = await pool.query(
    `SELECT p.uuid FROM global_account.social_id si
     JOIN global_account.person p ON si.person_uuid = p.uuid
     WHERE si.value = $1 AND si.type = 'email' LIMIT 1`,
    [email]
  )
  return res.rows[0]?.uuid ?? null
}

async function lookupWorkspaceUuid(slug: string): Promise<string | null> {
  const res = await pool.query(
    `SELECT uuid FROM global_account.workspace WHERE url = $1 LIMIT 1`,
    [slug]
  )
  return res.rows[0]?.uuid ?? null
}

// ── Auth middleware ───────────────────────────────────────────────────

function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function requireServerSecret(ctx: Koa.Context, next: Koa.Next): Promise<void> | void {
  const provided = ctx.get('X-Server-Secret')
  if (!secretsEqual(provided, SERVER_SECRET!)) {
    ctx.status = 401
    ctx.body = { error: 'Invalid server secret' }
    return
  }
  return next() as Promise<void>
}

// ── Routes ───────────────────────────────────────────────────────────

const router = new Router()

// Health check
router.get('/healthz', (ctx) => {
  ctx.body = { ok: true }
})

// Mint a token
router.post('/tokens', requireServerSecret, async (ctx) => {
  const { email, workspace, expiryDays = 30 } = ctx.request.body as {
    email?: string
    workspace?: string
    expiryDays?: number
  }

  if (!email || !workspace) {
    ctx.status = 400
    ctx.body = { error: 'email and workspace are required' }
    return
  }

  if (expiryDays < 1 || expiryDays > 365) {
    ctx.status = 400
    ctx.body = { error: 'expiryDays must be between 1 and 365' }
    return
  }

  const accountUuid = await lookupAccountUuid(email)
  if (!accountUuid) {
    ctx.status = 404
    ctx.body = { error: `Account not found for email: ${email}` }
    return
  }

  const workspaceUuid = await lookupWorkspaceUuid(workspace)
  if (!workspaceUuid) {
    ctx.status = 404
    ctx.body = { error: `Workspace not found: ${workspace}` }
    return
  }

  const now = Math.floor(Date.now() / 1000)
  const exp = now + expiryDays * 86400
  const expiresAt = new Date(exp * 1000).toISOString()

  const token = jwt.encode(
    { account: accountUuid, workspace: workspaceUuid, exp },
    SERVER_SECRET!
  )

  const id = crypto.randomUUID()
  await pool.query(
    `INSERT INTO global_account.api_tokens (id, email, workspace, account_uuid, workspace_uuid, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, email, workspace, accountUuid, workspaceUuid, expiresAt]
  )

  ctx.body = { id, token, expiresAt }
})

// List tokens
router.get('/tokens', requireServerSecret, async (ctx) => {
  const res = await pool.query(
    `SELECT id, email, workspace, created_at, expires_at, revoked
     FROM global_account.api_tokens ORDER BY created_at DESC`
  )
  ctx.body = res.rows
})

// Revoke a token
router.delete('/tokens/:id', requireServerSecret, async (ctx) => {
  const { id } = ctx.params
  const res = await pool.query(
    `UPDATE global_account.api_tokens SET revoked = true WHERE id = $1 RETURNING id`,
    [id]
  )
  if (res.rowCount === 0) {
    ctx.status = 404
    ctx.body = { error: 'Token not found' }
    return
  }
  ctx.body = { id, revoked: true }
})

// ── Start ────────────────────────────────────────────────────────────

const app = new Koa()
app.use(bodyParser())
app.use(router.routes())
app.use(router.allowedMethods())

ensureTable()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Token service listening on :${PORT}`)
    })
  })
  .catch((err) => {
    console.error('Failed to initialize:', err)
    process.exit(1)
  })
