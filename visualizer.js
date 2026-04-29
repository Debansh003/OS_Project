// ============================================
// GC VISUALIZER — INTERACTIVE ENGINE
// ============================================

const canvas = document.getElementById('gc-canvas');
const ctx = canvas.getContext('2d');
const logBody = document.getElementById('log-body');
const overlay = document.getElementById('canvas-overlay');

let W, H;
let objects = [];
let edges = [];
let currentAlgo = 'refcount';
let animFrame = null;
let gcRunning = false;
let idCounter = 0;
let gcRoots = [];

// ---- ALGO META DATA ----
const algoMeta = {
  refcount: {
    tag: 'REFERENCE COUNTING',
    title: 'Track Every Reference',
    desc: 'Each object maintains a count of how many references point to it. When the count drops to zero, the memory is immediately reclaimed — no pauses, no waiting.',
    pause: 'Incremental', pauseClass: 'good',
    overhead: 'Per-write', overheadClass: 'mid',
    cycles: 'Cannot detect', cyclesClass: 'bad',
    used: 'CPython, Swift, Rust (Rc)'
  },
  marksweep: {
    tag: 'MARK & SWEEP',
    title: 'Trace the Reachable',
    desc: 'Two phases: Mark traverses the object graph from GC roots setting mark bits. Sweep linearly scans the heap freeing all unmarked objects.',
    pause: 'Stop-the-World', pauseClass: 'bad',
    overhead: 'Mark bit/obj', overheadClass: 'mid',
    cycles: 'Fully handled', cyclesClass: 'good',
    used: 'Go, early JVM, Ruby, Lua'
  },
  generational: {
    tag: 'GENERATIONAL GC',
    title: 'Most Objects Die Young',
    desc: 'Divides heap into generations. New objects go to the young gen. Survivors get promoted. Frequent minor GCs collect young gen cheaply.',
    pause: 'Minor pauses', pauseClass: 'mid',
    overhead: 'Write barriers', overheadClass: 'mid',
    cycles: 'Fully handled', cyclesClass: 'good',
    used: 'JVM G1/ZGC, V8, .NET CLR'
  }
};

// ---- COLORS ----
const COLORS = {
  active: '#2ed573',
  marked: '#ffd32a',
  dead: '#ff4757',
  freed: '#3a3a5c',
  freeing: '#ff6b81',
  young: '#00f5c4',
  old: '#7c4dff',
  root: '#74b9ff',
  edge: 'rgba(255,255,255,0.25)',
  edgeActive: 'rgba(0,245,196,0.6)',
  bg: '#141420',
  surface: '#1a1a28',
  text: '#e8e8f0',
  textDim: 'rgba(232,232,240,0.5)'
};

// ---- RESIZE ----
function resizeCanvas() {
  const wrapper = canvas.parentElement;
  W = wrapper.clientWidth;
  H = wrapper.clientHeight;
  canvas.width = W;
  canvas.height = H;
  render();
}

window.addEventListener('resize', resizeCanvas);

// ---- OBJECT CLASS ----
class GCObject {
  constructor(x, y, id, gen = 'young') {
    this.id = id;
    this.x = x;
    this.y = y;
    this.vx = (Math.random() - 0.5) * 0.3;
    this.vy = (Math.random() - 0.5) * 0.3;
    this.r = 30;
    this.refCount = 0;
    this.marked = false;
    this.state = 'active'; // active, marked, dead, freed, freeing
    this.gen = gen; // young, old
    this.age = 0;
    this.isRoot = false;
    this.label = `O${id}`;
    this.alpha = 1;
    this.scale = 1;
    this.pulsePhase = Math.random() * Math.PI * 2;
  }

  getColor() {
    if (this.isRoot) return COLORS.root;
    if (this.state === 'freed') return COLORS.freed;
    if (this.state === 'freeing') return COLORS.freeing;
    if (this.state === 'dead') return COLORS.dead;
    if (this.state === 'marked') return COLORS.marked;
    if (currentAlgo === 'generational') {
      return this.gen === 'old' ? COLORS.old : COLORS.young;
    }
    return COLORS.active;
  }

  draw(t) {
    if (this.state === 'freed') return;

    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.translate(this.x, this.y);
    ctx.scale(this.scale, this.scale);

    const pulse = 1 + Math.sin(t * 0.002 + this.pulsePhase) * 0.04;
    const r = this.r;
    const color = this.getColor();

    // glow
    const glow = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 1.8);
    glow.addColorStop(0, color + '40');
    glow.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.8 * pulse, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();

    // outer ring
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // inner fill
    ctx.beginPath();
    ctx.arc(0, 0, r - 3, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r);
    grad.addColorStop(0, color + '50');
    grad.addColorStop(1, color + '15');
    ctx.fillStyle = grad;
    ctx.fill();

    // label
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold 13px 'Space Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label, 0, -4);

    // ref count or gen badge
    if (currentAlgo === 'refcount') {
      ctx.font = `10px 'Space Mono', monospace`;
      ctx.fillStyle = color;
      ctx.fillText(`rc:${this.refCount}`, 0, 9);
    } else if (currentAlgo === 'generational') {
      ctx.font = `10px 'Space Mono', monospace`;
      ctx.fillStyle = color;
      ctx.fillText(this.gen, 0, 9);
    } else if (this.state === 'marked') {
      ctx.font = `10px 'Space Mono', monospace`;
      ctx.fillStyle = COLORS.marked;
      ctx.fillText('✓', 0, 9);
    }

    // root badge
    if (this.isRoot) {
      ctx.font = `10px 'Space Mono', monospace`;
      ctx.fillStyle = COLORS.root;
      ctx.fillText('ROOT', 0, r + 14);
    }

    ctx.restore();
  }

  update() {
    if (this.state === 'freed') return;
    this.x += this.vx;
    this.y += this.vy;
    this.vx *= 0.99;
    this.vy *= 0.99;

    // Bounce off walls
    const pad = this.r + 20;
    if (this.x < pad) { this.x = pad; this.vx = Math.abs(this.vx) * 0.7; }
    if (this.x > W - pad) { this.x = W - pad; this.vx = -Math.abs(this.vx) * 0.7; }
    if (this.y < pad) { this.y = pad; this.vy = Math.abs(this.vy) * 0.7; }
    if (this.y > H - pad) { this.y = H - pad; this.vy = -Math.abs(this.vy) * 0.7; }

    // Soft repulsion
    for (const other of objects) {
      if (other === this || other.state === 'freed') continue;
      const dx = this.x - other.x;
      const dy = this.y - other.y;
      const dist = Math.hypot(dx, dy);
      const minDist = (this.r + other.r) * 2.5;
      if (dist < minDist && dist > 0.1) {
        const force = (minDist - dist) / minDist * 0.05;
        this.vx += (dx / dist) * force;
        this.vy += (dy / dist) * force;
      }
    }
  }
}

// ---- DRAW EDGES ----
function drawEdges() {
  for (const e of edges) {
    const a = objects.find(o => o.id === e.from);
    const b = objects.find(o => o.id === e.to);
    if (!a || !b || a.state === 'freed' || b.state === 'freed') continue;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.1) continue;

    const nx = dx / dist;
    const ny = dy / dist;
    const startX = a.x + nx * a.r;
    const startY = a.y + ny * a.r;
    const endX = b.x - nx * (b.r + 8);
    const endY = b.y - ny * (b.r + 8);

    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);

    const isActive = a.state === 'active' || a.state === 'marked';
    ctx.strokeStyle = isActive ? COLORS.edgeActive : COLORS.edge;
    ctx.lineWidth = isActive ? 1.5 : 1;
    ctx.stroke();

    // Arrow
    const angle = Math.atan2(endY - startY, endX - startX);
    ctx.save();
    ctx.translate(endX, endY);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-10, -5);
    ctx.lineTo(-10, 5);
    ctx.closePath();
    ctx.fillStyle = isActive ? COLORS.edgeActive : COLORS.edge;
    ctx.fill();
    ctx.restore();
  }
}

// ---- RENDER ----
let lastT = 0;
function render(t = 0) {
  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.02)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 50) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += 50) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Generational zones
  if (currentAlgo === 'generational') {
    const midY = H * 0.5;
    ctx.fillStyle = 'rgba(0,245,196,0.03)';
    ctx.fillRect(0, 0, W, midY);
    ctx.fillStyle = 'rgba(124,77,255,0.03)';
    ctx.fillRect(0, midY, W, H - midY);

    ctx.font = "11px 'Space Mono', monospace";
    ctx.fillStyle = 'rgba(0,245,196,0.3)';
    ctx.textAlign = 'left';
    ctx.fillText('YOUNG GENERATION', 16, 24);
    ctx.fillStyle = 'rgba(124,77,255,0.3)';
    ctx.fillText('OLD GENERATION (TENURED)', 16, midY + 24);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(0, midY); ctx.lineTo(W, midY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Edges
  drawEdges();

  // Objects
  for (const obj of objects) {
    obj.update();
    obj.draw(t);
  }

  animFrame = requestAnimationFrame(render);
}

// ---- ALGO SELECTION ----
function selectAlgo(algo) {
  currentAlgo = algo;
  resetViz();

  document.querySelectorAll('.algo-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-algo="${algo}"]`).classList.add('active');

  const meta = algoMeta[algo];
  document.getElementById('algo-tag').textContent = meta.tag;
  document.getElementById('algo-title').textContent = meta.title;
  document.getElementById('algo-desc').textContent = meta.desc;
  document.getElementById('prop-pause').textContent = meta.pause;
  document.getElementById('prop-pause').className = 'prop-val ' + meta.pauseClass;
  document.getElementById('prop-overhead').textContent = meta.overhead;
  document.getElementById('prop-overhead').className = 'prop-val ' + meta.overheadClass;
  document.getElementById('prop-cycles').textContent = meta.cycles;
  document.getElementById('prop-cycles').className = 'prop-val ' + meta.cyclesClass;
  document.getElementById('prop-used').textContent = meta.used;

  log(`Switched to ${meta.tag}`, 'info');
}

// ---- ADD OBJECT ----
function addObject() {
  if (objects.filter(o => o.state !== 'freed').length >= 12) {
    log('Max objects reached. Free some first.', 'warn');
    return;
  }

  const pad = 60;
  let x, y, gen;

  if (currentAlgo === 'generational') {
    // New objects always in young gen (top half)
    x = pad + Math.random() * (W - pad * 2);
    y = pad + Math.random() * (H * 0.5 - pad * 2);
    gen = 'young';
  } else {
    x = pad + Math.random() * (W - pad * 2);
    y = pad + Math.random() * (H - pad * 2);
    gen = 'young';
  }

  const obj = new GCObject(x, y, ++idCounter, gen);

  if (objects.filter(o => o.state !== 'freed').length === 0) {
    obj.isRoot = true;
    obj.refCount = 1;
    gcRoots.push(obj.id);
    log(`Allocated ${obj.label} as GC root`, 'success');
  } else {
    log(`Allocated ${obj.label} — refcount: 0 (orphan)`, 'info');
  }

  objects.push(obj);
  overlay.classList.add('hidden');
  updateRefCounts();
}

// ---- ADD REFERENCE ----
function addReference() {
  const active = objects.filter(o => o.state !== 'freed');
  if (active.length < 2) {
    log('Need at least 2 objects to create a reference', 'warn');
    return;
  }

  // Pick a random pair with no existing edge
  const shuffled = [...active].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length; i++) {
    for (let j = 0; j < shuffled.length; j++) {
      if (i === j) continue;
      const from = shuffled[i];
      const to = shuffled[j];
      const exists = edges.find(e => e.from === from.id && e.to === to.id);
      if (!exists) {
        edges.push({ from: from.id, to: to.id });
        log(`Created reference: ${from.label} → ${to.label}`, 'info');
        updateRefCounts();
        return;
      }
    }
  }
  log('All possible references already exist', 'warn');
}

// ---- REMOVE REFERENCE ----
function removeReference() {
  if (edges.length === 0) {
    log('No references to remove', 'warn');
    return;
  }

  const e = edges[Math.floor(Math.random() * edges.length)];
  const from = objects.find(o => o.id === e.from);
  const to = objects.find(o => o.id === e.to);
  edges = edges.filter(x => x !== e);
  log(`Removed reference: ${from?.label} → ${to?.label}`, 'warn');
  updateRefCounts();

  if (currentAlgo === 'refcount') {
    checkRefCountDead();
  }
}

// ---- UPDATE REF COUNTS ----
function updateRefCounts() {
  const counts = {};
  for (const obj of objects) {
    if (obj.state !== 'freed') counts[obj.id] = 0;
  }

  for (const e of edges) {
    const to = objects.find(o => o.id === e.to);
    if (to && to.state !== 'freed') {
      counts[e.to] = (counts[e.to] || 0) + 1;
    }
  }

  for (const obj of objects) {
    if (obj.state === 'freed') continue;
    if (obj.isRoot) {
      obj.refCount = Math.max(1, counts[obj.id] || 1);
    } else {
      obj.refCount = counts[obj.id] || 0;
    }
  }
}

// ---- CHECK REF COUNT ----
function checkRefCountDead() {
  for (const obj of objects) {
    if (obj.state === 'freed' || obj.state === 'dead' || obj.isRoot) continue;
    if (obj.refCount === 0) {
      obj.state = 'dead';
      log(`${obj.label} ref count = 0 → marked for immediate collection`, 'warn');
    }
  }
}

// ---- RUN GC ----
async function runGC() {
  if (gcRunning) return;
  gcRunning = true;
  document.getElementById('btn-gc').textContent = '⏳ Running...';
  document.getElementById('btn-gc').disabled = true;

  if (currentAlgo === 'refcount') await runRefCountGC();
  else if (currentAlgo === 'marksweep') await runMarkSweep();
  else if (currentAlgo === 'generational') await runGenerationalGC();

  gcRunning = false;
  document.getElementById('btn-gc').textContent = '▶ Run GC';
  document.getElementById('btn-gc').disabled = false;
  updateRefCounts();
}

// ---- REF COUNT GC ----
async function runRefCountGC() {
  log('--- Running Reference Count GC ---', 'info');
  checkRefCountDead();

  const dead = objects.filter(o => o.state === 'dead');
  if (dead.length === 0) {
    log('No objects with zero ref count. Nothing to collect.', 'success');
    return;
  }

  for (const obj of dead) {
    log(`Collecting ${obj.label} (rc=0)...`, 'warn');
    obj.state = 'freeing';
    await sleep(500);

    // Decrement outgoing refs
    const outgoing = edges.filter(e => e.from === obj.id);
    edges = edges.filter(e => e.from !== obj.id);
    for (const e of outgoing) {
      const target = objects.find(o => o.id === e.to);
      if (target && !target.isRoot) {
        target.refCount = Math.max(0, target.refCount - 1);
        log(`  Decremented ${target.label}.rc → ${target.refCount}`, 'info');
        if (target.refCount === 0 && target.state === 'active') {
          target.state = 'dead';
          log(`  ${target.label} rc=0 → cascading collection`, 'warn');
        }
      }
    }
    edges = edges.filter(e => e.to !== obj.id);

    await sleep(300);
    obj.state = 'freed';
    log(`Freed ${obj.label} ✓`, 'success');
  }

  // Check for cycles
  const orphans = objects.filter(o => o.state === 'active' && !o.isRoot && o.refCount > 0);
  const reachable = getReachable();
  const cyclic = orphans.filter(o => !reachable.has(o.id));
  if (cyclic.length > 0) {
    log(`⚠️ Cyclic garbage detected: ${cyclic.map(o => o.label).join(', ')} — cannot collect!`, 'error');
  }
}

// ---- MARK SWEEP GC ----
async function runMarkSweep() {
  log('--- Running Mark & Sweep GC ---', 'info');
  log('Phase 1: Marking reachable objects...', 'info');

  // Reset marks
  for (const obj of objects) {
    if (obj.state !== 'freed') {
      obj.marked = false;
      obj.state = 'active';
    }
  }
  await sleep(300);

  // BFS from roots
  const roots = objects.filter(o => o.isRoot && o.state !== 'freed');
  const worklist = [...roots];
  const visited = new Set(roots.map(o => o.id));

  while (worklist.length > 0) {
    const obj = worklist.shift();
    obj.state = 'marked';
    obj.marked = true;
    log(`  Marked ${obj.label}`, 'info');
    await sleep(250);

    const outgoing = edges.filter(e => e.from === obj.id);
    for (const e of outgoing) {
      const child = objects.find(o => o.id === e.to && o.state !== 'freed');
      if (child && !visited.has(child.id)) {
        visited.add(child.id);
        worklist.push(child);
      }
    }
  }

  await sleep(500);
  log('Phase 2: Sweeping unreachable objects...', 'warn');

  let collected = 0;
  for (const obj of objects) {
    if (obj.state === 'freed') continue;
    if (!obj.marked) {
      log(`  Sweeping ${obj.label} (unreachable)`, 'warn');
      obj.state = 'freeing';
      await sleep(300);
      edges = edges.filter(e => e.from !== obj.id && e.to !== obj.id);
      obj.state = 'freed';
      collected++;
    } else {
      obj.state = 'active';
    }
  }

  if (collected === 0) {
    log('No garbage found — all objects reachable', 'success');
  } else {
    log(`Collected ${collected} object(s) ✓`, 'success');
  }
}

// ---- GENERATIONAL GC ----
async function runGenerationalGC() {
  log('--- Running Generational GC (Minor) ---', 'info');
  log('Collecting young generation...', 'info');

  // Age all objects
  const youngObjs = objects.filter(o => o.gen === 'young' && o.state !== 'freed');

  for (const obj of youngObjs) {
    obj.age++;
    if (obj.age >= 3) {
      // Promote to old generation
      const midY = H * 0.5;
      obj.gen = 'old';
      obj.y = midY + 60 + Math.random() * (H * 0.5 - 120);
      log(`  Promoting ${obj.label} to old generation (survived ${obj.age} cycles)`, 'success');
      await sleep(300);
    }
  }

  // Mark from roots
  const reachable = getReachable();

  // Find dead young objects
  const deadYoung = youngObjs.filter(o => !reachable.has(o.id) && !o.isRoot);
  if (deadYoung.length === 0) {
    log('Minor GC: No garbage in young generation', 'success');
  }

  for (const obj of deadYoung) {
    log(`  Collecting young ${obj.label}`, 'warn');
    obj.state = 'freeing';
    await sleep(300);
    edges = edges.filter(e => e.from !== obj.id && e.to !== obj.id);
    obj.state = 'freed';
  }

  if (deadYoung.length > 0) {
    log(`Minor GC complete: collected ${deadYoung.length} young object(s) ✓`, 'success');
  }

  // Occasionally trigger major GC
  const oldCount = objects.filter(o => o.gen === 'old' && o.state !== 'freed').length;
  if (oldCount >= 4) {
    await sleep(500);
    log('Old generation threshold reached — triggering Major GC...', 'warn');
    await sleep(300);

    const deadOld = objects.filter(o => o.gen === 'old' && o.state !== 'freed' && !reachable.has(o.id) && !o.isRoot);
    for (const obj of deadOld) {
      log(`  Collecting old ${obj.label}`, 'warn');
      obj.state = 'freeing';
      await sleep(300);
      edges = edges.filter(e => e.from !== obj.id && e.to !== obj.id);
      obj.state = 'freed';
    }
    log(`Major GC complete ✓`, 'success');
  }
}

// ---- HELPERS ----
function getReachable() {
  const visited = new Set();
  const roots = objects.filter(o => o.isRoot && o.state !== 'freed');
  const queue = [...roots];
  roots.forEach(o => visited.add(o.id));

  while (queue.length > 0) {
    const obj = queue.shift();
    const outgoing = edges.filter(e => e.from === obj.id);
    for (const e of outgoing) {
      const child = objects.find(o => o.id === e.to && o.state !== 'freed');
      if (child && !visited.has(child.id)) {
        visited.add(child.id);
        queue.push(child);
      }
    }
  }
  return visited;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `▸ ${msg}`;
  logBody.appendChild(line);
  logBody.scrollTop = logBody.scrollHeight;

  // Keep log clean
  const lines = logBody.querySelectorAll('.log-line');
  if (lines.length > 30) lines[0].remove();
}

// ---- RESET ----
function resetViz() {
  objects = [];
  edges = [];
  gcRoots = [];
  idCounter = 0;
  gcRunning = false;
  logBody.innerHTML = '<div class="log-line info">▸ Visualizer ready. Allocate some objects to begin.</div>';
  overlay.classList.remove('hidden');
}

// ---- SCROLL TO VIZ ----
function scrollToViz() {
  document.getElementById('viz-section').scrollIntoView({ behavior: 'smooth' });
}

// ---- INIT ----
resizeCanvas();
render();

// ---- CANVAS CLICK TO SELECT ----
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  for (const obj of objects) {
    if (obj.state === 'freed') continue;
    const dist = Math.hypot(mx - obj.x, my - obj.y);
    if (dist < obj.r) {
      log(`${obj.label}: state=${obj.state}, refCount=${obj.refCount}, gen=${obj.gen}, root=${obj.isRoot}`, 'info');
      // Pop bounce
      obj.vx += (Math.random() - 0.5) * 2;
      obj.vy += (Math.random() - 0.5) * 2;
    }
  }
});