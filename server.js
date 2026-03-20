/**
 * Delegram Shared Client Server
 * Multi-tenant Express app — serves all client sites from one server
 * Cloudflare Worker routes *.delegram.app → this server
 * Subdomain extracted from Host header → looks up client data in DB
 */

const express = require('express')
const { Pool } = require('pg')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

// ── Database ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
})

// ── Subdomain middleware ──────────────────────────────────────────────────────

async function getClient(subdomain) {
  if (!subdomain || subdomain === 'www') return null
  const result = await pool.query(
    `SELECT t.id, t.company_name, t.subdomain, t.status,
            cs.html, cs.css, cs.config, cs.admin_key,
            cs.updated_at
     FROM tenants t
     LEFT JOIN client_sites cs ON cs.tenant_id = t.id
     WHERE t.subdomain = $1 AND t.status = 'active'`,
    [subdomain]
  )
  return result.rows[0] || null
}

function extractSubdomain(host) {
  if (!host) return null
  const parts = host.split('.')
  if (parts.length < 2) return null
  // Handle: subdomain.delegram.app → subdomain
  // Handle: subdomain.delegram.app:3000 → subdomain
  const first = parts[0].split(':')[0]
  return first
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Health check (no subdomain required)
app.get('/health', (req, res) => {
  const subdomain = extractSubdomain(req.hostname)
  res.json({ ok: true, company: subdomain || 'delegram-clients' })
})

// Main site — serve client HTML
app.get('/', async (req, res) => {
  const subdomain = extractSubdomain(req.hostname)
  const client = await getClient(subdomain)

  if (!client) {
    return res.status(404).send(notFoundPage(subdomain))
  }

  // Use custom HTML if available, otherwise render from template
  if (client.html) {
    return res.send(client.html)
  }

  // Render default template with client data
  const config = client.config || {}
  res.send(renderTemplate(client, config))
})

// Email subscribe
app.post('/subscribe', async (req, res) => {
  const subdomain = extractSubdomain(req.hostname)
  const client = await getClient(subdomain)
  if (!client) return res.status(404).json({ error: 'Not found' })

  const { email, name } = req.body
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' })
  }

  try {
    await pool.query(
      `INSERT INTO subscribers (tenant_id, email, name, source)
       VALUES ($1, $2, $3, 'landing')
       ON CONFLICT (tenant_id, email) DO UPDATE SET name = EXCLUDED.name`,
      [client.id, email.toLowerCase().trim(), name || '']
    )
    res.json({ ok: true, message: 'Subscribed!' })
  } catch (err) {
    console.error('Subscribe error:', err)
    res.status(500).json({ error: 'Failed to subscribe' })
  }
})

// Analytics ping
app.post('/ping', async (req, res) => {
  const subdomain = extractSubdomain(req.hostname)
  const client = await getClient(subdomain)
  if (!client) return res.status(404).json({ error: 'Not found' })

  try {
    await pool.query(
      `INSERT INTO page_views (tenant_id, path, referrer, ua)
       VALUES ($1, $2, $3, $4)`,
      [client.id, req.body.path || '/', req.body.referrer || '', req.body.ua || '']
    )
  } catch {}
  res.json({ ok: true })
})

// Admin dashboard
app.get('/admin.html', async (req, res) => {
  const subdomain = extractSubdomain(req.hostname)
  const client = await getClient(subdomain)
  if (!client) return res.status(404).send(notFoundPage(subdomain))
  res.send(renderAdminPage(client))
})

// Admin API — stats
app.get('/api/admin/stats', async (req, res) => {
  const subdomain = extractSubdomain(req.hostname)
  const client = await getClient(subdomain)
  if (!client) return res.status(404).json({ error: 'Not found' })

  const key = req.headers['x-admin-key'] || req.query.key
  if (key !== client.admin_key) return res.status(401).json({ error: 'Unauthorized' })

  const [subs, views] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM subscribers WHERE tenant_id = $1', [client.id]),
    pool.query('SELECT COUNT(*) FROM page_views WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL \'7 days\'', [client.id]),
  ])

  res.json({
    subscribers: parseInt(subs.rows[0].count),
    page_views_7d: parseInt(views.rows[0].count),
    company: client.company_name,
    subdomain: client.subdomain,
  })
})

// Admin API — subscribers list
app.get('/api/admin/subscribers', async (req, res) => {
  const subdomain = extractSubdomain(req.hostname)
  const client = await getClient(subdomain)
  if (!client) return res.status(404).json({ error: 'Not found' })

  const key = req.headers['x-admin-key'] || req.query.key
  if (key !== client.admin_key) return res.status(401).json({ error: 'Unauthorized' })

  const result = await pool.query(
    'SELECT email, name, created_at FROM subscribers WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100',
    [client.id]
  )
  res.json({ subscribers: result.rows })
})

// ── Template rendering ────────────────────────────────────────────────────────

function renderTemplate(client, config) {
  const name = client.company_name
  const subdomain = client.subdomain
  const headline = config.headline || `Welcome to ${name}`
  const subtitle = config.subtitle || 'We are building something great.'
  const contactEmail = config.contact_email || `${subdomain}@delegram.app`
  const primaryColor = config.primary_color || '#22c55e'
  const bgColor = config.bg_color || '#050f07'
  const textColor = config.text_color || '#f0fdf4'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Inter, -apple-system, sans-serif; background: ${bgColor}; color: ${textColor}; }
  nav { display: flex; justify-content: space-between; align-items: center; padding: 1.5rem 2.5rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .logo { font-weight: 700; font-size: 1.3rem; color: ${primaryColor}; }
  .nav-cta { background: ${primaryColor}; color: ${bgColor}; padding: 0.6rem 1.4rem; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  .hero { max-width: 800px; margin: 5rem auto; padding: 0 2rem; text-align: center; }
  h1 { font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 800; line-height: 1.1; margin-bottom: 1.5rem; }
  h1 span { color: ${primaryColor}; }
  .subtitle { font-size: 1.15rem; line-height: 1.7; max-width: 600px; margin: 0 auto 2.5rem; opacity: 0.8; }
  .subscribe-form { display: flex; gap: 0.75rem; max-width: 420px; margin: 2rem auto 0; }
  .subscribe-form input { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; padding: 0.8rem 1rem; color: ${textColor}; font-size: 0.95rem; outline: none; }
  .subscribe-form button { background: ${primaryColor}; color: ${bgColor}; border: none; border-radius: 8px; padding: 0.8rem 1.4rem; font-weight: 700; cursor: pointer; white-space: nowrap; }
  .success-msg { display: none; color: ${primaryColor}; margin-top: 0.75rem; font-size: 0.9rem; text-align: center; }
  footer { text-align: center; padding: 3rem; opacity: 0.5; font-size: 0.85rem; border-top: 1px solid rgba(255,255,255,0.1); margin-top: 5rem; }
  @media (max-width: 768px) {
    nav { padding: 1rem 1.5rem; }
    .hero { margin: 3rem auto; }
    .subscribe-form { flex-direction: column; }
  }
</style>
</head>
<body>
<nav>
  <div class="logo">${name}</div>
  <a href="#subscribe" class="nav-cta">Get Started</a>
</nav>
<div class="hero">
  <h1>${headline.replace(/([^.!?]+)$/, '<span>$1</span>')}</h1>
  <p class="subtitle">${subtitle}</p>
  <div id="subscribe" class="subscribe-form">
    <input type="email" placeholder="Enter your email" id="email-input" />
    <button onclick="subscribe()">Join the waitlist</button>
  </div>
  <div class="success-msg" id="success-msg">✓ You're on the list!</div>
</div>
<footer>
  <p>&copy; ${new Date().getFullYear()} ${name} · <a href="mailto:${contactEmail}" style="color:inherit">${contactEmail}</a></p>
</footer>
<script>
async function subscribe() {
  const email = document.getElementById('email-input').value
  if (!email || !email.includes('@')) return alert('Please enter a valid email')
  const btn = document.querySelector('.subscribe-form button')
  btn.textContent = 'Joining...'
  btn.disabled = true
  try {
    const res = await fetch('/subscribe', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email }) })
    if (res.ok) {
      document.querySelector('.subscribe-form').style.display = 'none'
      document.getElementById('success-msg').style.display = 'block'
    }
  } catch(e) { btn.textContent = 'Join the waitlist'; btn.disabled = false }
}
// Analytics
fetch('/ping', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: '/', referrer: document.referrer, ua: navigator.userAgent }) }).catch(()=>{})
</script>
</body>
</html>`
}

function renderAdminPage(client) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${client.company_name} — Admin</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Inter, sans-serif; background: #0a0a0a; color: #f0f0f0; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 2rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .stat { background: #1a1a1a; border-radius: 8px; padding: 1.5rem; }
  .stat-num { font-size: 2rem; font-weight: 700; color: #22c55e; }
  .stat-label { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
  table { width: 100%; border-collapse: collapse; background: #1a1a1a; border-radius: 8px; overflow: hidden; }
  th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #222; font-size: 0.9rem; }
  th { color: #666; font-weight: 500; }
  #key-form { margin-bottom: 2rem; display: flex; gap: 0.5rem; }
  #key-form input { flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 0.6rem 1rem; color: #f0f0f0; }
  #key-form button { background: #22c55e; color: #000; border: none; border-radius: 6px; padding: 0.6rem 1.2rem; font-weight: 600; cursor: pointer; }
</style>
</head>
<body>
<h1>${client.company_name} — Admin Dashboard</h1>
<div id="key-form">
  <input type="password" id="admin-key" placeholder="Enter admin key" />
  <button onclick="loadStats()">Access Dashboard</button>
</div>
<div id="dashboard" style="display:none">
  <div class="stats" id="stats"></div>
  <h2 style="margin-bottom:1rem;font-size:1rem;color:#666">Recent Subscribers</h2>
  <table><thead><tr><th>Email</th><th>Name</th><th>Joined</th></tr></thead><tbody id="subs-table"></tbody></table>
</div>
<script>
async function loadStats() {
  const key = document.getElementById('admin-key').value
  const [stats, subs] = await Promise.all([
    fetch('/api/admin/stats?key=' + key).then(r => r.json()),
    fetch('/api/admin/subscribers?key=' + key).then(r => r.json())
  ])
  if (stats.error) return alert('Invalid admin key')
  document.getElementById('dashboard').style.display = 'block'
  document.getElementById('key-form').style.display = 'none'
  document.getElementById('stats').innerHTML = \`
    <div class="stat"><div class="stat-num">\${stats.subscribers}</div><div class="stat-label">Subscribers</div></div>
    <div class="stat"><div class="stat-num">\${stats.page_views_7d}</div><div class="stat-label">Page Views (7d)</div></div>
  \`
  document.getElementById('subs-table').innerHTML = subs.subscribers.map(s =>
    \`<tr><td>\${s.email}</td><td>\${s.name||'—'}</td><td>\${new Date(s.created_at).toLocaleDateString()}</td></tr>\`
  ).join('')
}
</script>
</body>
</html>`
}

function notFoundPage(subdomain) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:4rem;background:#000;color:#fff">
<h1 style="color:#22c55e">delegram</h1>
<p style="margin-top:1rem;color:#666">${subdomain ? `${subdomain}.delegram.app is not yet live.` : 'Site not found.'}</p>
</body></html>`
}

// ── DB migrations ─────────────────────────────────────────────────────────────

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_sites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id),
      html TEXT,
      css TEXT,
      config JSONB DEFAULT '{}',
      admin_key VARCHAR(64) NOT NULL DEFAULT substring(md5(random()::text), 1, 16),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscribers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      source VARCHAR(64) DEFAULT 'landing',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, email)
    );
    CREATE TABLE IF NOT EXISTS page_views (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      path VARCHAR(255) DEFAULT '/',
      referrer TEXT,
      ua TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `)
  console.log('✓ Migrations done')
}

// ── Start ─────────────────────────────────────────────────────────────────────

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Delegram client server running on port ${PORT}`))
  })
  .catch(err => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
