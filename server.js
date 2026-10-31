const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
function loadEnv() {
  const filename = path.join(ROOT, '.env');
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv();
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.TINYFISH_API_KEY;
const platforms = [
  ['Coursera', 'https://www.coursera.org/search?query='],
  ['Udemy', 'https://www.udemy.com/courses/search/?q='],
  ['edX', 'https://www.edx.org/search?q='],
  ['Udacity', 'https://www.udacity.com/courses/all?search='],
  ['DeepLearning.AI', 'https://www.deeplearning.ai/courses/']
];

function db() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ saved: [], preferences: {} }, null, 2));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function persist(value) { fs.writeFileSync(DB_FILE, JSON.stringify(value, null, 2)); }
function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', c => { raw += c; if (raw.length > 1_000_000) reject(new Error('Request too large')); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject); }); }
function safeCourse(c) {
  if (!c || typeof c !== 'object') return null;
  const text = (v) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 1000) : 'Not disclosed';
  const list = (v) => Array.isArray(v) ? v.map(x => String(x).slice(0, 300)).slice(0, 40) : [];
  return {
    id: String(c.id || crypto.randomUUID()), course_name: text(c.course_name || c.name), platform: text(c.platform), course_url: text(c.course_url || c.url), instructor: text(c.instructor),
    syllabus: list(c.syllabus), prerequisites: list(c.prerequisites), projects: list(c.projects), duration: text(c.duration), price: text(c.price), currency: text(c.currency),
    certificate: typeof c.certificate === 'boolean' ? c.certificate : 'Not disclosed', difficulty: text(c.difficulty), skills: list(c.skills), last_updated: text(c.last_updated),
    source_url: text(c.source_url || c.course_url || c.url), research_timestamp: text(c.research_timestamp || new Date().toISOString()), verification: 'TinyFish source extraction'
  };
}
const crypto = require('node:crypto');

async function research(req, res) {
  if (!API_KEY) return send(res, 503, { error: 'TinyFish is not configured. Add TINYFISH_API_KEY to the server environment and restart.' });
  const { topic, selectedPlatforms } = await body(req);
  if (typeof topic !== 'string' || topic.trim().length < 2 || topic.length > 180) return send(res, 400, { error: 'Enter a learning goal between 2 and 180 characters.' });
  const chosen = platforms.filter(([name]) => !Array.isArray(selectedPlatforms) || selectedPlatforms.includes(name));
  if (!chosen.length) return send(res, 400, { error: 'Select at least one platform.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  let disconnected = false;
  res.on('close', () => { if (!res.writableEnded) disconnected = true; });
  emit({ type: 'stage', step: 1, message: `Understanding your learning goal: ${topic.trim()}` });
  emit({ type: 'stage', step: 2, message: `Discovering ${chosen.length} selected learning platforms.` });
  const allCourses = [];
  let completed = 0;
  await Promise.all(chosen.map(async ([platform, searchUrl]) => {
    if (disconnected) return;
    const target = searchUrl + encodeURIComponent(topic.trim());
    emit({ type: 'source', platform, url: target, status: 'visiting' });
    emit({ type: 'stage', step: 3, message: `Visiting ${platform} search results.` });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch('https://agent.tinyfish.ai/v1/automation/run-sse', {
        method: 'POST', signal: controller.signal,
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ url: target, goal: `Research publicly accessible courses on ${platform} relevant to "${topic.trim()}". Search this platform and inspect up to 3 relevant course detail pages. Return ONLY courses you actually find on the pages. For each course provide course_name, platform, course_url, instructor, syllabus (topic list), prerequisites, projects (hands-on projects only), duration, price, currency, certificate (true/false only if explicit), difficulty, skills, last_updated. Use "Not disclosed" for unavailable scalar fields and [] for unavailable lists. Never infer or invent facts. Include source_url for the exact page and research_timestamp as current ISO timestamp. Return JSON shaped as {"courses":[...]}.` })
      });
      if (!response.ok) throw new Error(`TinyFish returned HTTP ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (!disconnected) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n'); buffer = chunks.pop() || '';
        for (const chunk of chunks) {
          const line = chunk.split('\n').find(x => x.startsWith('data:'));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            if (event.type === 'PROGRESS') emit({ type: 'stage', step: 4, platform, message: event.purpose || `Extracting course information from ${platform}.` });
            if (event.type === 'COMPLETE') {
              const result = event.result?.courses ? event.result : event.result?.result || event.result;
              const courses = Array.isArray(result) ? result : result?.courses || [];
              courses.forEach(c => { const normalized = safeCourse({ ...c, platform: c.platform || platform, source_url: c.source_url || c.course_url, research_timestamp: new Date().toISOString() }); if (normalized && normalized.course_url !== 'Not disclosed') allCourses.push(normalized); });
              emit({ type: 'source', platform, url: target, status: courses.length ? 'complete' : 'no_results', count: courses.length });
            }
            if (event.type === 'ERROR' || event.type === 'FAILED') emit({ type: 'source', platform, url: target, status: 'blocked', message: event.message || 'The platform could not be verified.' });
          } catch { /* Ignore non-JSON stream frames. */ }
        }
      }
    } catch (error) {
      emit({ type: 'source', platform, url: target, status: 'error', message: error.name === 'AbortError' ? 'Research timed out.' : error.message });
    } finally { clearTimeout(timeout); }
    completed++;
    emit({ type: 'platform_done', platform, completed, total: chosen.length });
  }));
  if (!disconnected) {
    emit({ type: 'stage', step: 6, message: 'Comparing verified course information.' });
    const result = { type: 'complete', courses: allCourses, researchedAt: new Date().toISOString(), platforms: chosen.map(x => x[0]) };
    const state = db(); state.lastResearch = result; persist(state);
    emit({ type: 'stage', step: 7, message: allCourses.length ? 'Preparing evidence-based results.' : 'No verifiable course pages were returned.' });
    emit(result); res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { configured: Boolean(API_KEY) });
    if (req.method === 'POST' && url.pathname === '/api/research') return await research(req, res);
    if (url.pathname === '/api/saved' && req.method === 'GET') return send(res, 200, db().saved || []);
    if (url.pathname === '/api/saved' && req.method === 'POST') { const c = safeCourse(await body(req)); if (!c) return send(res, 400, { error: 'Invalid course.' }); const state = db(); state.saved = [...(state.saved || []).filter(x => x.id !== c.id), c]; persist(state); return send(res, 200, state.saved); }
    if (url.pathname.startsWith('/api/saved/') && req.method === 'DELETE') { const id = decodeURIComponent(url.pathname.slice('/api/saved/'.length)); const state = db(); state.saved = (state.saved || []).filter(x => x.id !== id); persist(state); return send(res, 200, state.saved); }
    if (url.pathname === '/api/preferences' && req.method === 'GET') return send(res, 200, db().preferences || {});
    if (url.pathname === '/api/preferences' && req.method === 'PUT') { const pref = await body(req); const state = db(); state.preferences = pref; persist(state); return send(res, 200, pref); }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(ROOT, 'public', file);
    if (!target.startsWith(path.resolve(ROOT, 'public') + path.sep) && target !== path.resolve(ROOT, 'public', 'index.html')) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(target, (error, content) => { if (error) return send(res, 404, { error: 'Not found' }); const ext = path.extname(target); res.writeHead(200, { 'Content-Type': ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/html' }); res.end(content); });
  } catch (error) { if (!res.headersSent) send(res, 500, { error: error.message }); else res.end(); }
});
server.listen(PORT, HOST, () => console.log(`CourseCompass listening on http://${HOST}:${PORT}`));
