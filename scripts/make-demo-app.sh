#!/usr/bin/env bash
# Builds a small demo application with a dated git history, for trying and
# testing inloop: frontend, API routes, authentication, data access, async
# code, several connected modules, and how login evolved over five commits.
#
#   scripts/make-demo-app.sh /path/to/new/dir
#
# The code is never run by inloop; it only has to read like a real project.
set -euo pipefail

DIR="${1:?usage: make-demo-app.sh <new directory>}"
if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  echo "refusing to write into non-empty $DIR" >&2
  exit 1
fi
mkdir -p "$DIR"
cd "$DIR"
git init -q -b main
git config user.name "Demo Author"
git config user.email "demo@example.com"

commit() { # date message
  git add -A
  GIT_AUTHOR_DATE="$1T10:00:00" GIT_COMMITTER_DATE="$1T10:00:00" git commit -q -m "$2"
}

mkdir -p server/auth server/db web

# --- 1. plain-text passwords and server sessions --------------------------
cat > package.json <<'EOF'
{
  "name": "demo-app",
  "version": "0.1.0",
  "main": "server/app.js",
  "dependencies": {
    "express": "^4.19.2"
  }
}
EOF

cat > server/db/index.js <<'EOF'
// A tiny stand-in for a database client: rows live in memory.
const tables = { users: [] }

async function query(table, predicate) {
  return tables[table].filter(predicate)
}

async function insert(table, row) {
  tables[table].push(row)
  return row
}

module.exports = { query, insert }
EOF

cat > server/db/users.js <<'EOF'
const db = require('./index')

async function findUserByEmail(email) {
  const rows = await db.query('users', u => u.email === email)
  return rows[0] || null
}

async function createUser(email, password) {
  return db.insert('users', { id: Date.now(), email, password })
}

module.exports = { findUserByEmail, createUser }
EOF

cat > server/auth/sessions.js <<'EOF'
const sessions = new Map()

function createSession(user) {
  const id = Math.random().toString(36).slice(2)
  sessions.set(id, user.id)
  return id
}

module.exports = { createSession }
EOF

cat > server/auth/controller.js <<'EOF'
const { findUserByEmail, createUser } = require('../db/users')
const { createSession } = require('./sessions')

async function login(req, res) {
  const { email, password } = req.body
  const user = await findUserByEmail(email)
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'invalid credentials' })
  }
  const sessionId = createSession(user)
  res.json({ sessionId })
}

async function register(req, res) {
  const { email, password } = req.body
  const user = await createUser(email, password)
  res.status(201).json({ id: user.id })
}

module.exports = { login, register }
EOF

cat > server/app.js <<'EOF'
const express = require('express')
const { login, register } = require('./auth/controller')

const app = express()
app.use(express.json())

app.post('/api/login', login)
app.post('/api/register', register)

app.listen(3000)
EOF
commit 2026-05-02 "Initial server with login and register"

# --- 2. hash passwords ------------------------------------------------------
cat > server/auth/passwords.js <<'EOF'
const bcrypt = require('bcrypt')

const ROUNDS = 12

async function hashPassword(password) {
  return bcrypt.hash(password, ROUNDS)
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash)
}

module.exports = { hashPassword, verifyPassword }
EOF

cat > server/db/users.js <<'EOF'
const db = require('./index')

async function findUserByEmail(email) {
  const rows = await db.query('users', u => u.email === email)
  return rows[0] || null
}

async function createUser(email, passwordHash) {
  return db.insert('users', { id: Date.now(), email, passwordHash })
}

module.exports = { findUserByEmail, createUser }
EOF

cat > server/auth/controller.js <<'EOF'
const { findUserByEmail, createUser } = require('../db/users')
const { createSession } = require('./sessions')
const { hashPassword, verifyPassword } = require('./passwords')

async function login(req, res) {
  const { email, password } = req.body
  const user = await findUserByEmail(email)
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'invalid credentials' })
  }
  const sessionId = createSession(user)
  res.json({ sessionId })
}

async function register(req, res) {
  const { email, password } = req.body
  const passwordHash = await hashPassword(password)
  const user = await createUser(email, passwordHash)
  res.status(201).json({ id: user.id })
}

module.exports = { login, register }
EOF
node -e "const p=require('./package.json');p.dependencies.bcrypt='^5.1.1';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
commit 2026-06-11 "Hash passwords with bcrypt"

# --- 3. JWT instead of server sessions --------------------------------------
git rm -q server/auth/sessions.js
cat > server/auth/tokens.js <<'EOF'
const jwt = require('jsonwebtoken')

const SECRET = process.env.JWT_SECRET
const LIFETIME = '1h'

function createToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, SECRET, { expiresIn: LIFETIME })
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET)
  } catch (err) {
    return null
  }
}

module.exports = { createToken, verifyToken }
EOF

cat > server/auth/controller.js <<'EOF'
const { findUserByEmail, createUser } = require('../db/users')
const { createToken } = require('./tokens')
const { hashPassword, verifyPassword } = require('./passwords')

async function login(req, res) {
  const { email, password } = req.body
  const user = await findUserByEmail(email)
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'invalid credentials' })
  }
  const token = createToken(user)
  res.json({ token })
}

async function register(req, res) {
  const { email, password } = req.body
  const passwordHash = await hashPassword(password)
  const user = await createUser(email, passwordHash)
  res.status(201).json({ id: user.id })
}

module.exports = { login, register }
EOF
node -e "const p=require('./package.json');p.dependencies.jsonwebtoken='^9.0.2';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
commit 2026-07-16 "Switch from server sessions to JWT tokens"

# --- 4. protected route -----------------------------------------------------
mkdir -p server/middleware
cat > server/middleware/requireAuth.js <<'EOF'
const { verifyToken } = require('../auth/tokens')

function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  const claims = token && verifyToken(token)
  if (!claims) {
    return res.status(401).json({ error: 'not signed in' })
  }
  req.user = claims
  next()
}

module.exports = { requireAuth }
EOF

cat > server/app.js <<'EOF'
const express = require('express')
const { login, register } = require('./auth/controller')
const { requireAuth } = require('./middleware/requireAuth')

const app = express()
app.use(express.json())

app.post('/api/login', login)
app.post('/api/register', register)

app.get('/api/me', requireAuth, me)

function me(req, res) {
  res.json({ id: req.user.sub, email: req.user.email })
}

app.listen(3000)
EOF
commit 2026-08-21 "Add requireAuth middleware and /api/me"

# --- 5. frontend ------------------------------------------------------------
cat > web/api.js <<'EOF'
export async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.json()).error)
  return res.json()
}

export async function loginRequest(email, password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error('login failed')
  return res.json()
}
EOF

cat > web/session.js <<'EOF'
export function saveToken(token) {
  localStorage.setItem('token', token)
}

export function currentToken() {
  return localStorage.getItem('token')
}
EOF

cat > web/LoginForm.jsx <<'EOF'
import { useState } from 'react'
import { loginRequest } from './api'
import { saveToken } from './session'

export function LoginForm({ onSignedIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)

  async function handleLogin(event) {
    event.preventDefault()
    try {
      const { token } = await loginRequest(email, password)
      saveToken(token)
      onSignedIn()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <form>
      <input value={email} onChange={e => setEmail(e.target.value)} />
      <input type="password" value={password} onChange={e => setPassword(e.target.value)} />
      <button onClick={handleLogin}>Log in</button>
      {error && <p>{error}</p>}
    </form>
  )
}
EOF
commit 2026-09-26 "Add the login form"

# --- a secret that must never be read, and uncommitted work -----------------
printf 'JWT_SECRET=demo-secret-value-do-not-read-0123456789\n' > .env
printf '.env\nnode_modules/\n' > .gitignore
git add .gitignore
GIT_AUTHOR_DATE="2026-09-27T10:00:00" GIT_COMMITTER_DATE="2026-09-27T10:00:00" git commit -q -m "Ignore env files"
printf '\n// TODO: rate-limit login attempts\n' >> server/auth/controller.js

echo "demo app ready in $DIR"
git --no-pager log --oneline
