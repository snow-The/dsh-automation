/**
 * dsh-automation — 不需要 agent 的定時檢查與收集。
 *
 * 為什麼要有這支（2026-11-12 使用者原話）：
 *   「自動化任務不是應該不需要依賴 agent 就可以完成檢查與搜集？」
 * DSH 官方的 schedule 是「把 prompt 送給一個 session」——那仍然要一個 LLM 在迴圈裡。
 * 這支插件相反：它在宿主進程裡用自己的 timer 跑純 Node 工作，不呼叫模型、不花 token。
 *
 * 形狀刻意像 RSSHub 的「固定幾套 route」：內建 5 種 adapter，預設 jobs.json 放幾組
 * 可直接用的範例；其他讓使用者自己加。資料全部在本機：
 *   ~/.dsh/automation/jobs.json          工作定義（第一次啟動自動生成範例）
 *   ~/.dsh/automation/state.json         每項的最後一次執行
 *   ~/.dsh/automation/latest/<id>.json   最新一筆結果
 *   ~/.dsh/automation/runs/<id>.jsonl    歷史（有上限）
 *
 * 與 agent 的邊界：agent 只透過 automation_list / automation_run / automation_status
 * 三個工具看與觸發；排程本身不需要任何 session 存在。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

export const name = 'automation'
export const inject = ['tools']

const HOME = join(homedir(), '.dsh', 'automation')
const JOBS = join(HOME, 'jobs.json')
const STATE = join(HOME, 'state.json')
const LATEST = join(HOME, 'latest')
const RUNS = join(HOME, 'runs')
const MAX_RUN_LINES = 500
const TICK_MS = 30_000

const EXAMPLE_JOBS = {
  version: 1,
  jobs: [
    {
      id: 'hn-top',
      type: 'rss',
      url: 'https://hnrss.org/frontpage',
      every: '15m',
      keep: 10,
      note: 'Hacker News 首頁；RSSHub 風格：換 url 就換來源',
    },
    {
      id: 'dsh-releases',
      type: 'rss',
      url: 'https://github.com/deepseek-ai/deepseek-harness/releases.atom',
      every: '1h',
      keep: 10,
      note: '上游 release 通知',
    },
    {
      id: 'local-web',
      type: 'http-status',
      url: 'http://127.0.0.1:3080/',
      every: '5m',
      note: '本機 DSH host 還活著嗎（只看 HTTP 狀態與延遲）',
    },
    {
      id: 'disk-home',
      type: 'disk',
      path: '~',
      every: '30m',
      note: '家目錄剩餘空間；低於 warnGB 會標記',
      warnGB: 20,
    },
    {
      id: 'echo-check',
      type: 'shell',
      command: process.platform === 'win32' ? 'cmd /c echo automation-ok' : 'echo automation-ok',
      every: '10m',
      timeoutMs: 10_000,
      note: 'shell adapter 範例：只記錄 exit code 與輸出尾巴',
    },
  ],
}

// ── 設定與狀態 ─────────────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [HOME, LATEST, RUNS]) mkdirSync(d, { recursive: true })
}

export function loadJobs() {
  ensureDirs()
  if (!existsSync(JOBS)) {
    writeFileSync(JOBS, JSON.stringify(EXAMPLE_JOBS, null, 2) + '\n', 'utf8')
    return { created: true, data: EXAMPLE_JOBS }
  }
  const raw = readFileSync(JOBS, 'utf8')
  const data = JSON.parse(raw)
  if (!Array.isArray(data.jobs)) throw new Error('jobs.json 必須有 jobs 陣列')
  return { created: false, data }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return {} }
}
function saveState(s) {
  try { writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8') } catch { /* 觀測失敗不該阻擋工作 */ }
}

export function parseEvery(every, dfltMs = 600_000) {
  if (typeof every === 'number' && Number.isFinite(every) && every > 0) return every * 1000
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(every ?? '').trim())
  if (!m) return dfltMs
  const n = Number(m[1])
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]
}

const expandHome = (p) => (p === '~' ? homedir() : String(p).startsWith('~/') ? join(homedir(), p.slice(2)) : String(p))

// ── 純解析（可單獨測試）──────────────────────────────────────────────
/** 最小 RSS/Atom 解析：不引入 XML 依賴，抓 <item>/<entry> 的 title/link/date。 */
export function parseFeed(xml) {
  const blocks = [...String(xml).matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)].map((m) => m[0])
  const pick = (block, tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
    if (!m) return null
    return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }[e])).trim()
  }
  return blocks.map((b) => ({
    title: pick(b, 'title'),
    link: pick(b, 'link') ?? (/<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? null),
    date: pick(b, 'pubDate') ?? pick(b, 'updated') ?? pick(b, 'published') ?? null,
  })).filter((x) => x.title || x.link)
}

/** JSON 點路徑：'a.b[0].c' 這類；空字串回傳原值。 */
export function pickPath(obj, path) {
  if (!path) return obj
  let cur = obj
  for (const seg of String(path).split('.')) {
    if (cur == null) return null
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg)
    if (!m) return null
    if (m[1]) cur = cur[m[1]]
    for (const idx of [...m[2].matchAll(/\[(\d+)\]/g)]) cur = cur?.[Number(idx[1])]
  }
  return cur ?? null
}

function tail(s, n = 400) {
  const t = String(s ?? '').trim()
  return t.length <= n ? t : t.slice(-n)
}

// ── Adapters ─────────────────────────────────────────────────────────
const ADAPTERS = {
  async rss(job) {
    const r = await fetch(job.url, { signal: AbortSignal.timeout(job.timeoutMs ?? 20_000), headers: { 'user-agent': 'dsh-automation/1' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const items = parseFeed(await r.text())
    const keep = Math.max(1, Number(job.keep ?? 20))
    return { ok: true, count: items.length, items: items.slice(0, keep) }
  },

  async 'http-json'(job) {
    const r = await fetch(job.url, { signal: AbortSignal.timeout(job.timeoutMs ?? 20_000), headers: { 'user-agent': 'dsh-automation/1' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const body = await r.json()
    const picked = pickPath(body, job.pick)
    const items = Array.isArray(picked) ? picked.slice(0, Math.max(1, Number(job.keep ?? 20))) : picked
    return { ok: true, value: items }
  },

  async 'http-status'(job) {
    const t0 = Date.now()
    const r = await fetch(job.url, { method: job.method ?? 'GET', signal: AbortSignal.timeout(job.timeoutMs ?? 15_000) })
    const bytes = (await r.arrayBuffer()).byteLength
    // 健康檢查的判準是「服務還活著」，不是「我授權成功」：401/403 代表進程在跑、只是要 token
    // （本機 DSH web 就是這樣）。只有 5xx / 連不上才算失敗。
    return { ok: r.status < 500, status: r.status, authRequired: r.status === 401 || r.status === 403, ms: Date.now() - t0, bytes }
  },

  async shell(job) {
    const timeout = Number(job.timeoutMs ?? 30_000)
    return await new Promise((resolve) => {
      const child = spawn(job.command, { shell: true, windowsHide: true })
      let out = ''
      let err = ''
      const timer = setTimeout(() => { try { child.kill() } catch {} }, timeout)
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ ok: code === 0, exitCode: code, stdout: tail(out), stderr: tail(err) })
      })
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message) }) })
    })
  },

  async disk(job) {
    // Node 的 statfs 在 Windows 上可用；拿不到就退回 statfs 例外 → 明確失敗，不假裝成功。
    const { statfs } = await import('node:fs/promises')
    const p = expandHome(job.path ?? '~')
    const s = await statfs(p)
    const freeGB = (s.bavail * s.bsize) / 1024 ** 3
    const totalGB = (s.blocks * s.bsize) / 1024 ** 3
    const warn = Number(job.warnGB ?? 0)
    return { ok: warn ? freeGB >= warn : true, freeGB: Number(freeGB.toFixed(1)), totalGB: Number(totalGB.toFixed(1)), path: p, warnGB: warn || null }
  },
}

export async function runJob(job) {
  const t0 = Date.now()
  const adapter = ADAPTERS[job.type]
  const base = { job: job.id, type: job.type, startedAt: new Date(t0).toISOString() }
  if (!adapter) return { ...base, ok: false, ms: 0, error: `unknown job type: ${job.type}` }
  try {
    const out = await adapter(job)
    return { ...base, ...out, ok: out.ok !== false, ms: Date.now() - t0 }
  } catch (e) {
    return { ...base, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 400) }
  }
}

/** 執行一項並落檔；回傳結果。 */
export async function executeJob(job, state = loadState()) {
  ensureDirs()
  const result = await runJob(job)
  const stamp = new Date().toISOString()
  const rec = { ...result, finishedAt: stamp }
  try { writeFileSync(join(LATEST, `${job.id}.json`), JSON.stringify(rec, null, 2), 'utf8') } catch {}
  try {
    appendFileSync(join(RUNS, `${job.id}.jsonl`), JSON.stringify(rec) + '\n', 'utf8')
    // 超過上限就裁掉前半（只留最近 MAX_RUN_LINES 行）
    const f = join(RUNS, `${job.id}.jsonl`)
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
    if (lines.length > MAX_RUN_LINES) writeFileSync(f, lines.slice(-MAX_RUN_LINES).join('\n') + '\n', 'utf8')
  } catch {}
  state[job.id] = { lastRunAt: stamp, lastOk: rec.ok, lastMs: rec.ms, lastError: rec.error ?? null }
  saveState(state)
  return rec
}

function due(job, state, now = Date.now()) {
  const every = parseEvery(job.every)
  const last = state[job.id]?.lastRunAt ? Date.parse(state[job.id].lastRunAt) : 0
  return now - last >= every
}

// ── 工具面 ────────────────────────────────────────────────────────────
const render = (fn) => ({ schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: fn(v) }] })

const listTool = {
  name: 'automation_list',
  description: '列出本機自動化工作（不需要 agent 的定時檢查/收集）。資料在 ~/.dsh/automation/jobs.json。',
  parameters: { type: 'object', properties: {} },
  output: render((v) => {
    if (!v.jobs.length) return '（沒有工作）'
    return v.jobs.map((j) => `${j.id.padEnd(16)} ${String(j.type).padEnd(12)} every=${j.every ?? '?'}  last=${j.lastRunAt ?? 'never'}  ok=${j.lastOk ?? '-'}  ${j.error ?? ''}`).join('\n')
  }),
  timeoutMs: 10_000,
  isConcurrencySafe: () => true,
  async execute() {
    const { data } = loadJobs()
    const state = loadState()
    return { source: JOBS, jobs: data.jobs.map((j) => ({ id: j.id, type: j.type, every: j.every, note: j.note ?? null, ...state[j.id] })) }
  },
}

const runTool = {
  name: 'automation_run',
  description: '立刻執行一項自動化工作（或 id="all" 跑全部）。不呼叫模型，只跑 Node/adapter。',
  parameters: { type: 'object', properties: { id: { type: 'string', description: '工作 id，或 all' } }, required: ['id'] },
  output: render((v) => v.results.map((r) => `${r.job}: ${r.ok ? 'OK' : 'FAIL'} ${r.ms}ms ${r.error ?? ''}`).join('\n')),
  timeoutMs: 120_000,
  isConcurrencySafe: () => false,
  async execute(args) {
    const { data } = loadJobs()
    const state = loadState()
    const jobs = String(args?.id ?? '') === 'all' ? data.jobs : data.jobs.filter((j) => j.id === args?.id)
    if (!jobs.length) throw new Error('NOT_FOUND: ' + args?.id)
    const results = []
    for (const job of jobs) results.push(await executeJob(job, state))
    return { results }
  },
}

const statusTool = {
  name: 'automation_status',
  description: '自動化層狀態：工作數、最近執行、失敗項、資料目錄。',
  parameters: { type: 'object', properties: {} },
  output: render((v) => JSON.stringify(v, null, 1)),
  timeoutMs: 10_000,
  isConcurrencySafe: () => true,
  async execute() {
    const { data, created } = loadJobs()
    const state = loadState()
    const failed = data.jobs.filter((j) => state[j.id] && state[j.id].lastOk === false).map((j) => j.id)
    return {
      home: HOME,
      jobsFile: JOBS,
      jobsFileCreated: created,
      jobs: data.jobs.length,
      types: [...new Set(data.jobs.map((j) => j.type))],
      failed,
      lastRuns: Object.fromEntries(data.jobs.map((j) => [j.id, state[j.id] ?? null])),
      tickMs: TICK_MS,
    }
  },
}

// ── 生命週期 ──────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  ensureDirs()
  let timer = null
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const { data } = loadJobs()
      const state = loadState()
      const now = Date.now()
      for (const job of data.jobs) {
        if (!due(job, state, now)) continue
        try {
          const r = await executeJob(job, state)
          ctx.logger?.info?.(`automation: ${job.id} ${r.ok ? 'ok' : 'FAIL'} ${r.ms}ms`)
        } catch (e) {
          ctx.logger?.warn?.('automation: ' + job.id + ' ' + e.message)
        }
      }
    } catch (e) {
      ctx.logger?.warn?.('automation tick failed: ' + (e?.message ?? e))
    } finally {
      running = false
    }
  }

  if (config?.enabled !== false) {
    timer = setInterval(() => { tick().catch(() => {}) }, Number(config?.tickMs ?? TICK_MS))
    if (typeof timer.unref === 'function') timer.unref()
    setImmediate(() => tick().catch(() => {}))
  }

  for (const t of [listTool, runTool, statusTool]) {
    try { ctx.tools.register(t) } catch (e) { ctx.logger?.warn?.(`automation: ${t.name} skipped: ${e}`) }
  }

  ctx.logger?.info?.(`dsh-automation: ${JOBS}（不需 agent 的定時檢查；tick ${Number(config?.tickMs ?? TICK_MS)}ms）`)

  return () => { if (timer) clearInterval(timer) }
}

export const __internals = { parseFeed, pickPath, parseEvery, runJob, executeJob, loadJobs, loadState, ADAPTERS, EXAMPLE_JOBS, HOME }
