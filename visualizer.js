// ============================================
// GC VISUALIZER v2 — custom refs, step panel, speed control
// ============================================

const canvas = document.getElementById('gc-canvas');
const ctx = canvas.getContext('2d');
const logBody = document.getElementById('log-body');
const overlay = document.getElementById('canvas-overlay');

let W, H;
let objects = [];
let edges = [];
let currentAlgo = 'refcount';
let gcRunning = false;
let idCounter = 0;
let speedMultiplier = 2;
let pulseEdge = null; // { from, to } highlighted edge during GC

const SPEED_LABELS = { 1:'Very Slow', 2:'Slow', 3:'Normal', 4:'Fast', 5:'Very Fast' };

// base delay scaled by speed (1=1400ms … 5=200ms)
function W8(base = 1200) {
  return new Promise(r => setTimeout(r, base / speedMultiplier));
}

function updateSpeed(v) {
  speedMultiplier = +v;
  document.getElementById('speed-val').textContent = SPEED_LABELS[v];
}

// ---- STEP PANEL ----
function setStep(tag, title, desc, prog = null) {
  document.getElementById('step-tag').textContent = tag;
  document.getElementById('step-title').textContent = title;
  document.getElementById('step-desc').textContent = desc;
  const wrap = document.getElementById('step-progress-wrap');
  if (prog !== null) {
    wrap.style.display = 'flex';
    document.getElementById('step-fill').style.width = prog.pct + '%';
    document.getElementById('step-count').textContent = prog.cur + ' / ' + prog.total;
  } else {
    wrap.style.display = 'none';
  }
  // color the panel border
  const panel = document.getElementById('step-panel');
  panel.className = 'step-panel';
  if (tag.includes('MARK')) panel.classList.add('phase-mark');
  else if (tag.includes('SWEEP')) panel.classList.add('phase-sweep');
  else if (tag.includes('⚠')) panel.classList.add('phase-warn');
  else if (tag.includes('✓')) panel.classList.add('phase-done');
}

function clearStep() {
  setStep('IDLE', 'Ready to begin',
    'Allocate objects, draw your own reference graph, then click Run GC to see the algorithm execute step-by-step with full explanations.');
  document.getElementById('step-panel').className = 'step-panel';
}

// ---- ALGO META ----
const algoMeta = {
  refcount: {
    tag:'REFERENCE COUNTING', title:'Track Every Reference',
    desc:'Each object maintains a count of how many references point to it. When the count drops to zero, the memory is immediately reclaimed — no pauses, no waiting.',
    pause:'Incremental', pauseClass:'good',
    overhead:'Per-write', overheadClass:'mid',
    cycles:'Cannot detect', cyclesClass:'bad',
    used:'CPython, Swift, Rust (Rc)'
  },
  marksweep: {
    tag:'MARK & SWEEP', title:'Trace the Reachable',
    desc:'Two phases: Mark traverses the object graph from GC roots setting mark bits. Sweep linearly scans the heap freeing all unmarked objects.',
    pause:'Stop-the-World', pauseClass:'bad',
    overhead:'Mark bit/obj', overheadClass:'mid',
    cycles:'Fully handled', cyclesClass:'good',
    used:'Go, early JVM, Ruby, Lua'
  },
  generational: {
    tag:'GENERATIONAL GC', title:'Most Objects Die Young',
    desc:'Divides heap into generations. New objects go to young gen. Survivors get promoted. Frequent minor GCs collect young gen cheaply.',
    pause:'Minor pauses', pauseClass:'mid',
    overhead:'Write barriers', overheadClass:'mid',
    cycles:'Fully handled', cyclesClass:'good',
    used:'JVM G1/ZGC, V8, .NET CLR'
  }
};

// ---- COLORS ----
const C = {
  active:'#1d8348', marked:'#b7860a', dead:'#c0392b',
  freed:'#d1d1d6', freeing:'#e74c3c',
  young:'#0071e3', old:'#6e3ff3', root:'#0071e3',
  scanning:'#ff6b00',
  edge:'rgba(0,0,0,0.12)', edgeOn:'rgba(0,113,227,0.5)',
  edgePulse:'#b7860a', bg:'#f5f5f7', text:'#1d1d1f'
};

// ---- RESIZE ----
function resizeCanvas() {
  const w = canvas.parentElement;
  W = w.clientWidth; H = w.clientHeight;
  canvas.width = W; canvas.height = H;
}
window.addEventListener('resize', resizeCanvas);

// ---- OBJECT ----
class GCObject {
  constructor(x, y, id, gen='young') {
    this.id=id; this.x=x; this.y=y;
    this.vx=0; this.vy=0;
    this.r=32; this.refCount=0; this.marked=false;
    this.state='active'; this.gen=gen; this.age=0;
    this.isRoot=false; this.label='O'+id;
    this.scanning=false; this.pulsePhase=Math.random()*Math.PI*2;
  }

  color() {
    if (this.scanning) return C.scanning;
    if (this.isRoot) return C.root;
    if (this.state==='freeing') return C.freeing;
    if (this.state==='dead') return C.dead;
    if (this.state==='marked') return C.marked;
    if (currentAlgo==='generational') return this.gen==='old' ? C.old : C.young;
    return C.active;
  }

  draw(t) {
    if (this.state==='freed') return;
    ctx.save();
    ctx.translate(this.x, this.y);
    const pulse = this.scanning
      ? 1 + Math.sin(t*.007+this.pulsePhase)*.13
      : 1 + Math.sin(t*.002+this.pulsePhase)*.04;
    const r = this.r, col = this.color();

    // glow
    const g = ctx.createRadialGradient(0,0,r*.4,0,0,r*2.2);
    g.addColorStop(0, col+'44'); g.addColorStop(1,'transparent');
    ctx.beginPath(); ctx.arc(0,0,r*2.2*pulse,0,Math.PI*2);
    ctx.fillStyle=g; ctx.fill();

    // scanning ring
    if (this.scanning) {
      ctx.beginPath(); ctx.arc(0,0,r+8,0,Math.PI*2);
      ctx.strokeStyle=col+'70'; ctx.lineWidth=2; ctx.stroke();
    }

    // main circle
    ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2);
    ctx.strokeStyle=col; ctx.lineWidth=this.scanning?3:2; ctx.stroke();

    // fill
    ctx.beginPath(); ctx.arc(0,0,r-3,0,Math.PI*2);
    const gf = ctx.createRadialGradient(-r*.3,-r*.3,0,0,0,r);
    gf.addColorStop(0,col+'55'); gf.addColorStop(1,col+'12');
    ctx.fillStyle=gf; ctx.fill();

    // main label
    ctx.fillStyle=C.text; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font="bold 12px 'Inter',sans-serif"; ctx.fillText(this.label, 0, -6);
    ctx.font="bold 12px 'Inter',monospace";
    ctx.fillText(this.label, 0, -6);

    // sub-label
    ctx.font="10px 'JetBrains Mono',monospace"; ctx.fillStyle=col;
    if (currentAlgo==='refcount') ctx.fillText('rc:'+this.refCount,0,8);
    else if (currentAlgo==='generational') ctx.fillText(this.gen==='old'?'OLD':'YOUNG',0,8);
    else if (this.state==='marked') { ctx.fillStyle=C.marked; ctx.fillText('✓ live',0,8); }
    else if (this.scanning) ctx.fillText('scanning…',0,8);

    // ROOT badge
    if (this.isRoot) {
      ctx.fillStyle=C.root;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-18,r+5,36,14,3);
      else ctx.rect(-18,r+5,36,14);
      ctx.fill();
      ctx.fillStyle='#0a0a0f';
      ctx.font="bold 8px 'JetBrains Mono',monospace";
      ctx.fillText('ROOT',0,r+12);
    }

    // age badge
    if (currentAlgo==='generational' && this.age>0) {
      ctx.fillStyle=col+'99';
      ctx.font="9px 'JetBrains Mono',monospace";
      ctx.fillText('age:'+this.age, 0, r+(this.isRoot?26:14));
    }
    ctx.restore();
  }

  update() {
    // objects are static — no movement
  }
}

// ---- DRAW EDGES ----
function drawEdges(t) {
  for (const e of edges) {
    const a=objects.find(o=>o.id===e.from), b=objects.find(o=>o.id===e.to);
    if(!a||!b||a.state==='freed'||b.state==='freed') continue;
    const dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy);
    if(d<.1) continue;
    const nx=dx/d, ny=dy/d;
    const sx=a.x+nx*a.r, sy=a.y+ny*a.r;
    const ex=b.x-nx*(b.r+10), ey=b.y-ny*(b.r+10);
    const isPulse = pulseEdge && pulseEdge.from===e.from && pulseEdge.to===e.to;
    const isOn = a.state==='active'||a.state==='marked'||a.scanning;

    ctx.save();
    if (isPulse) {
      ctx.setLineDash([8,5]); ctx.lineDashOffset=-(t*.05)%13;
      ctx.strokeStyle=C.edgePulse; ctx.lineWidth=3;
      ctx.shadowColor=C.edgePulse; ctx.shadowBlur=10;
    } else {
      ctx.strokeStyle=isOn?C.edgeOn:C.edge;
      ctx.lineWidth=isOn?1.8:1;
    }
    ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(ex,ey); ctx.stroke();

    // arrow
    const ang=Math.atan2(ey-sy,ex-sx);
    ctx.translate(ex,ey); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-12,-5); ctx.lineTo(-12,5); ctx.closePath();
    ctx.fillStyle=isPulse?C.edgePulse:(isOn?C.edgeOn:C.edge);
    if(isPulse){ctx.shadowColor=C.edgePulse;ctx.shadowBlur=6;}
    ctx.fill();
    ctx.restore();

    // edge label mid-point
    ctx.save();
    ctx.font="9px 'JetBrains Mono',monospace";
    ctx.fillStyle=isPulse?C.edgePulse:'rgba(255,255,255,0.22)';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(a.label+'→'+b.label, (sx+ex)/2, (sy+ey)/2-10);
    ctx.restore();
  }
}

// ---- RENDER LOOP ----
function render(t=0) {
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle=C.bg; ctx.fillRect(0,0,W,H);

  // subtle grid
  ctx.strokeStyle='rgba(0,0,0,0.04)'; ctx.lineWidth=1;
  for(let x=0;x<W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let y=0;y<H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}

  // generational zones
  if (currentAlgo==='generational') {
    const mid=H*.52;
    ctx.fillStyle='rgba(0,113,227,0.04)'; ctx.fillRect(0,0,W,mid);
    ctx.fillStyle='rgba(110,63,243,0.04)'; ctx.fillRect(0,mid,W,H-mid);
    ctx.strokeStyle='rgba(0,0,0,0.08)'; ctx.lineWidth=1;
    ctx.setLineDash([8,8]);
    ctx.beginPath();ctx.moveTo(0,mid);ctx.lineTo(W,mid);ctx.stroke();
    ctx.setLineDash([]);
    ctx.font="11px 'JetBrains Mono',monospace"; ctx.textAlign='left';
    ctx.fillStyle='rgba(0,113,227,0.5)'; ctx.fillText('▲  YOUNG GENERATION',14,22);
    ctx.fillStyle='rgba(110,63,243,0.5)'; ctx.fillText('▼  OLD GENERATION (TENURED)',14,mid+22);
  }

  drawEdges(t);
  for (const o of objects) { o.update(); o.draw(t); }
  requestAnimationFrame(render);
}

// ---- ALGO SELECT ----
function selectAlgo(algo) {
  currentAlgo=algo; resetViz();
  document.querySelectorAll('.algo-tab').forEach(t=>t.classList.remove('active'));
  document.querySelector('[data-algo="'+algo+'"]').classList.add('active');
  const m=algoMeta[algo];
  document.getElementById('algo-tag').textContent=m.tag;
  document.getElementById('algo-title').textContent=m.title;
  document.getElementById('algo-desc').textContent=m.desc;
  document.getElementById('prop-pause').textContent=m.pause;
  document.getElementById('prop-pause').className='prop-val '+m.pauseClass;
  document.getElementById('prop-overhead').textContent=m.overhead;
  document.getElementById('prop-overhead').className='prop-val '+m.overheadClass;
  document.getElementById('prop-cycles').textContent=m.cycles;
  document.getElementById('prop-cycles').className='prop-val '+m.cyclesClass;
  document.getElementById('prop-used').textContent=m.used;
  log('Switched to '+m.tag,'info'); clearStep();
}

// ---- ADD OBJECT ----
function addObject() {
  const active=objects.filter(o=>o.state!=='freed');
  if(active.length>=12){log('Max 12 objects reached.','warn');return;}
  const pad=70; let x,y,gen='young';
  if(currentAlgo==='generational'){
    x=pad+Math.random()*(W-pad*2); y=pad+Math.random()*(H*.52-pad*2);
  } else {
    x=pad+Math.random()*(W-pad*2); y=pad+Math.random()*(H-pad*2);
  }
  const obj=new GCObject(x,y,++idCounter,gen);
  if(active.length===0){
    obj.isRoot=true; obj.refCount=1;
    log('Allocated '+obj.label+' as GC root','success');
    setStep('SETUP',''+obj.label+' is a GC Root',
      'The first object is a GC root — it represents a local variable on the stack or a global. The GC always starts reachability tracing from roots. Roots are never collected.');
  } else {
    log('Allocated '+obj.label+' (refcount=0, no references yet)','info');
    setStep('SETUP',''+obj.label+' allocated on heap',
      'This object lives on the heap. It currently has zero incoming references. Use the Custom Reference builder to connect it to other objects, or it will be treated as garbage when GC runs.');
  }
  objects.push(obj);
  overlay.classList.add('hidden');
  updateRefCounts(); refreshDropdowns();
}

// ---- DROPDOWNS ----
function refreshDropdowns() {
  const active=objects.filter(o=>o.state!=='freed');
  const fSel=document.getElementById('ref-from');
  const tSel=document.getElementById('ref-to');
  const fv=fSel.value, tv=tSel.value;
  fSel.innerHTML='<option value="">From…</option>';
  tSel.innerHTML='<option value="">To…</option>';
  for(const o of active){
    const lbl=o.label+(o.isRoot?' (root)':'');
    fSel.appendChild(new Option(lbl,o.id));
    tSel.appendChild(new Option(lbl,o.id));
  }
  if(fv) fSel.value=fv;
  if(tv) tSel.value=tv;
}

function addCustomRef() {
  const fId=+document.getElementById('ref-from').value;
  const tId=+document.getElementById('ref-to').value;
  if(!fId||!tId){log('Select both From and To objects first.','warn');return;}
  if(fId===tId){log('An object cannot reference itself.','warn');return;}
  if(edges.find(e=>e.from===fId&&e.to===tId)){log('That reference already exists.','warn');return;}
  const from=objects.find(o=>o.id===fId), to=objects.find(o=>o.id===tId);
  edges.push({from:fId,to:tId});
  log('Added reference: '+from.label+' → '+to.label,'success');
  setStep('SETUP','Reference '+from.label+' → '+to.label+' added',
    currentAlgo==='refcount'
      ? to.label+"'s reference count increases by 1. As long as "+from.label+' is reachable, '+to.label+' is also reachable and safe from collection.'
      : 'During the Mark phase the GC will follow this edge when traversing the object graph from roots. Objects reachable via this path will not be collected.');
  updateRefCounts();
  if(currentAlgo==='refcount') syncDeadStates();
  pulseEdge={from:fId,to:tId}; setTimeout(()=>pulseEdge=null,2000);
}

function removeCustomRef() {
  const fId=+document.getElementById('ref-from').value;
  const tId=+document.getElementById('ref-to').value;
  if(!fId||!tId){log('Select both objects to remove a reference.','warn');return;}
  const idx=edges.findIndex(e=>e.from===fId&&e.to===tId);
  if(idx===-1){log('No such reference exists.','warn');return;}
  const from=objects.find(o=>o.id===fId), to=objects.find(o=>o.id===tId);
  edges.splice(idx,1);
  log('Removed reference: '+from.label+' → '+to.label,'warn');
  setStep('SETUP','Reference '+from.label+' → '+to.label+' removed',
    currentAlgo==='refcount'
      ? to.label+"'s reference count decreases by 1. If it drops to 0, this object becomes garbage and reference counting will collect it immediately."
      : 'The edge is gone. If '+to.label+' has no other path from a GC root, the Mark phase will not reach it and the Sweep phase will free it.');
  updateRefCounts();
  if(currentAlgo==='refcount') syncDeadStates();
}

// ---- REF COUNT UTILS ----
function updateRefCounts() {
  const cnt={};
  for(const o of objects) if(o.state!=='freed') cnt[o.id]=0;
  for(const e of edges){
    const t=objects.find(o=>o.id===e.to);
    if(t&&t.state!=='freed') cnt[e.to]=(cnt[e.to]||0)+1;
  }
  for(const o of objects){
    if(o.state==='freed') continue;
    o.refCount=o.isRoot ? Math.max(1,cnt[o.id]||1) : (cnt[o.id]||0);
  }
}

function syncDeadStates() {
  for(const o of objects){
    if(o.state==='freed'||o.isRoot) continue;
    if(o.refCount===0&&o.state==='active'){
      o.state='dead'; log(o.label+' refcount=0 → will be collected','warn');
    }
    if(o.refCount>0&&o.state==='dead') o.state='active';
  }
}

// ---- RUN GC ----
async function runGC() {
  if(gcRunning) return;
  if(objects.filter(o=>o.state!=='freed').length===0){log('Nothing allocated yet.','warn');return;}
  gcRunning=true;
  const btn=document.getElementById('btn-gc');
  btn.textContent='⏳ Running…'; btn.disabled=true;
  document.getElementById('btn-add').disabled=true;

  if(currentAlgo==='refcount') await runRefCount();
  else if(currentAlgo==='marksweep') await runMarkSweep();
  else await runGenerational();

  gcRunning=false;
  btn.textContent='▶ Run GC'; btn.disabled=false;
  document.getElementById('btn-add').disabled=false;
  updateRefCounts(); refreshDropdowns();
  setStep('✓ DONE','GC cycle complete',
    'All unreachable objects have been collected. You can allocate more objects, modify references, and run GC again to see the algorithm repeat.');
}

// ============================================
// 1. REFERENCE COUNTING
// ============================================
async function runRefCount() {
  setStep('REF COUNT','Starting Reference Count GC',
    'Reference counting reclaims memory the instant a reference count drops to zero — no heap scan needed. Each object carries an integer counter that is incremented/decremented as pointers are created or destroyed.');
  log('═══ Reference Count GC ═══','info');
  await W8(1400);

  // STEP 1 — show counts
  setStep('STEP 1 / 3','Inspect all reference counts',
    'The runtime checks every live object\'s refcount. Objects with refcount=0 have no pointers pointing at them — they are unreachable garbage and can be freed immediately without scanning the rest of the heap.');
  log('Scanning reference counts on all objects…','info');
  await W8(1300);

  updateRefCounts();
  const snap=objects.filter(o=>o.state!=='freed').map(o=>o.label+'(rc='+o.refCount+')').join(', ');
  log('Counts: '+snap,'info');
  await W8(900);
  syncDeadStates();

  const dead=objects.filter(o=>o.state==='dead');
  if(dead.length===0){
    setStep('STEP 2 / 3','No garbage found',
      'Every object has at least one reference pointing to it. Reference counting has nothing to collect. Try removing a reference using the dropdown above to create garbage, then run GC again.');
    log('No objects with refcount=0. Nothing to collect.','success');
    await W8(1200); return;
  }

  // STEP 2 — collect
  setStep('STEP 2 / 3','Collecting objects with refcount=0',
    'Reference counting frees objects immediately — one at a time, right where the count dropped. No stop-the-world pause. Each freed object decrements the refcounts of objects it was pointing to (cascade effect).',
    {cur:0,total:dead.length,pct:0});
  log('Found '+dead.length+' garbage object(s)','warn');
  await W8(1100);

  for(let i=0;i<dead.length;i++){
    const obj=dead[i];
    setStep('STEP 2 / 3','Freeing '+obj.label+' (rc=0)',
      obj.label+' has refcount=0 — nothing points to it. The allocator immediately reclaims its memory. Any objects '+obj.label+' was pointing to have their refcounts decremented, possibly cascading.',
      {cur:i+1,total:dead.length,pct:Math.round((i+1)/dead.length*100)});

    obj.scanning=true;
    log('Collecting '+obj.label+' (rc=0)…','warn');
    await W8(1000);
    obj.scanning=false; obj.state='freeing';

    const out=edges.filter(e=>e.from===obj.id);
    edges=edges.filter(e=>e.from!==obj.id&&e.to!==obj.id);

    for(const e of out){
      const t=objects.find(o=>o.id===e.to);
      if(t&&!t.isRoot){
        t.refCount=Math.max(0,t.refCount-1);
        pulseEdge={from:obj.id,to:t.id};
        log('  '+t.label+'.refcount decremented → '+t.refCount,'info');
        await W8(700);
        pulseEdge=null;
        if(t.refCount===0&&t.state==='active'){
          t.state='dead';
          log('  '+t.label+' now rc=0 → cascade!','warn');
        }
      }
    }
    await W8(700);
    obj.state='freed';
    log('✓ Freed '+obj.label,'success');
    await W8(500);
  }

  // STEP 3 — cycle check
  setStep('STEP 3 / 3','Checking for reference cycles',
    'Reference counting cannot detect cycles. If A→B and B→A exist with no external pointer, both have rc=1 even though neither is reachable. This is a memory leak — the classic weakness of pure reference counting. CPython adds a separate cycle collector to handle this.');
  log('Checking for cyclic garbage…','info');
  await W8(1300);

  updateRefCounts();
  const reach=getReachable();
  const cyclic=objects.filter(o=>o.state==='active'&&!o.isRoot&&!reach.has(o.id));
  if(cyclic.length>0){
    cyclic.forEach(o=>o.state='dead');
    log('⚠ Cycle leak! '+cyclic.map(o=>o.label).join(', ')+' are unreachable but rc≠0','error');
    setStep('⚠ CYCLE LEAK','Cycle detected — cannot collect!',
      cyclic.map(o=>o.label).join(' and ')+' form a reference cycle. Their refcounts are non-zero because they point to each other, but no root can reach them. They are leaked memory. This is why Python, Swift, and Rust (with Rc) add separate mechanisms to detect cycles.');
  } else {
    log('No cycles detected.','success');
  }
}

// ============================================
// 2. MARK & SWEEP
// ============================================
async function runMarkSweep() {
  setStep('MARK & SWEEP','Starting Mark & Sweep GC',
    'Mark & Sweep is the foundational GC algorithm. It runs in two phases: MARK traces all reachable objects from GC roots (like graph BFS/DFS). SWEEP linearly scans the entire heap, freeing anything not marked. The whole program pauses during this — "stop-the-world".');
  log('═══ Mark & Sweep GC ═══','info');
  await W8(1500);

  // reset
  for(const o of objects) if(o.state!=='freed'){o.marked=false;o.state='active';o.scanning=false;}

  // ── MARK PHASE ──
  setStep('MARK PHASE','Locating GC roots',
    'GC roots are the starting points of reachability — local variables on the stack, static/global variables, CPU registers. Any object reachable from a root is alive. The Mark phase is essentially a graph traversal starting from every root simultaneously.');
  log('─ Phase 1: Mark ─','info');
  await W8(1400);

  const roots=objects.filter(o=>o.isRoot&&o.state!=='freed');
  log('Roots: '+(roots.length?roots.map(o=>o.label).join(', '):'none'),'info');
  await W8(900);

  const worklist=[...roots];
  const visited=new Set(roots.map(o=>o.id));
  const total=objects.filter(o=>o.state!=='freed').length;
  let markN=0;

  while(worklist.length>0){
    const obj=worklist.shift(); markN++;
    setStep('MARK PHASE','Visiting '+obj.label+(obj.isRoot?' (root)':''),
      'The GC traverses the object graph from root '+(roots[0]?.label||'root')+'. Visiting '+obj.label+' now — setting its mark bit to indicate it is reachable. Then following all outgoing pointers to discover more live objects.',
      {cur:markN,total,pct:Math.round(markN/total*100)});

    obj.scanning=true;
    log('  Visiting '+obj.label+'…','info');
    await W8(950);
    obj.scanning=false; obj.state='marked'; obj.marked=true;
    log('  ✓ Marked '+obj.label+' as reachable','info');
    await W8(600);

    for(const e of edges.filter(e=>e.from===obj.id)){
      const child=objects.find(o=>o.id===e.to&&o.state!=='freed');
      if(child&&!visited.has(child.id)){
        visited.add(child.id); worklist.push(child);
        pulseEdge={from:obj.id,to:child.id};
        log('  Following edge '+obj.label+' → '+child.label,'info');
        await W8(700); pulseEdge=null;
      }
    }
  }
  log('Mark complete. '+markN+' object(s) reachable.','success');
  await W8(1000);

  // ── SWEEP PHASE ──
  const garbage=objects.filter(o=>o.state!=='freed'&&!o.marked);
  setStep('SWEEP PHASE','Scanning heap for unmarked objects',
    'Mark phase done — '+markN+' live objects found. Now sweeping the entire heap linearly. Every object without a mark bit is unreachable garbage. '+garbage.length+' object(s) will be freed. Marked objects have their bit cleared, ready for the next GC cycle.');
  log('─ Phase 2: Sweep ─','warn');
  await W8(1400);

  let collected=0;
  for(let i=0;i<objects.length;i++){
    const obj=objects[i];
    if(obj.state==='freed') continue;
    const pct=Math.round((i/objects.length)*100);
    if(!obj.marked){
      setStep('SWEEP PHASE','Sweeping '+obj.label+' — unreachable!',
        obj.label+' has no mark bit — the Mark phase never reached it, meaning no path exists from any GC root to this object. It is dead memory. The sweep frees it and returns the memory to the allocator.',
        {cur:i+1,total:objects.length,pct});
      obj.scanning=true;
      log('  Sweeping '+obj.label+' (not marked)','warn');
      await W8(950);
      obj.scanning=false; obj.state='freeing';
      edges=edges.filter(e=>e.from!==obj.id&&e.to!==obj.id);
      await W8(600);
      obj.state='freed'; collected++;
      log('  ✓ Freed '+obj.label,'success');
      await W8(400);
    } else {
      setStep('SWEEP PHASE','Keeping '+obj.label+' — reachable ✓',
        obj.label+' was marked during the Mark phase. It is live. Its mark bit is now cleared so the next GC cycle starts fresh. This object stays in memory.',
        {cur:i+1,total:objects.length,pct});
      obj.state='active'; obj.marked=false;
      log('  Keeping '+obj.label+' (marked live)','info');
      await W8(500);
    }
  }
  log('Sweep complete. Collected '+collected+' object(s).','success');
}

// ============================================
// 3. GENERATIONAL GC
// ============================================
async function runGenerational() {
  setStep('GEN GC','Starting Generational GC',
    'Generational GC is based on the "generational hypothesis" — most objects die young. The heap is split into generations. New objects go to the young generation. Frequent cheap minor GCs collect the young gen. Objects that survive are promoted to the old gen, collected rarely via expensive major GC.');
  log('═══ Generational GC ═══','info');
  await W8(1500);

  const young=objects.filter(o=>o.gen==='young'&&o.state!=='freed');

  // STEP 1 — age
  setStep('STEP 1 / 4','Aging young generation objects',
    'Each GC cycle increments the age counter of surviving young objects. Objects that survive '+3+' or more cycles are promoted to the old generation — the runtime assumes they are long-lived.');
  log('─ Aging '+young.length+' young objects ─','info');
  await W8(1300);

  let promoted=0;
  for(const obj of young){
    obj.age++;
    obj.scanning=true;
    log('  '+obj.label+' age → '+obj.age,'info');
    await W8(500);
    obj.scanning=false;
    if(obj.age>=3){
      setStep('STEP 1 / 4','Promoting '+obj.label+' to old generation',
        obj.label+' has survived '+obj.age+' GC cycles — it is clearly long-lived. Moving it to the old generation. It will only be collected during a rare, expensive major GC. This is how generational GC avoids scanning long-lived objects on every cycle.');
      obj.gen='old';
      obj.y=Math.min(obj.y+80, H*.52+80);
      log('  ↑ Promoting '+obj.label+' to old gen','success');
      promoted++;
      await W8(950);
    }
  }
  if(!promoted) log('  No objects ready for promotion.','info');

  // STEP 2 — minor GC
  setStep('STEP 2 / 4','Minor GC — scanning young generation only',
    'Minor GC only looks at the young generation — a small memory region. This is very fast. We find which young objects are reachable from roots (including pointers from old gen via the remembered set/write barriers).');
  log('─ Minor GC: young generation ─','warn');
  await W8(1300);

  const reach=getReachable();
  const youngNow=objects.filter(o=>o.gen==='young'&&o.state!=='freed');
  const deadY=youngNow.filter(o=>!reach.has(o.id)&&!o.isRoot);
  const liveY=youngNow.filter(o=>reach.has(o.id)||o.isRoot);

  setStep('STEP 3 / 4',
    'Young gen: '+liveY.length+' live, '+deadY.length+' garbage',
    deadY.length>0
      ? 'Unreachable young objects: '+deadY.map(o=>o.label).join(', ')+'. These are collected now — the key insight is that collecting only the young gen is fast because it\'s small. The majority of GC work happens here.'
      : 'All young objects are reachable. Nothing to collect from the young generation right now.',
    {cur:0,total:Math.max(deadY.length,1),pct:0});
  await W8(1100);

  for(let i=0;i<deadY.length;i++){
    const obj=deadY[i];
    setStep('STEP 3 / 4','Collecting young '+obj.label,
      obj.label+' is a young unreachable object. This is the common case generational GC optimises for — most allocations die in the young generation, making minor GC very efficient. Freeing now.',
      {cur:i+1,total:deadY.length,pct:Math.round((i+1)/deadY.length*100)});
    obj.scanning=true;
    log('  Collecting young '+obj.label,'warn');
    await W8(900);
    obj.scanning=false; obj.state='freeing';
    edges=edges.filter(e=>e.from!==obj.id&&e.to!==obj.id);
    await W8(600); obj.state='freed';
    log('  ✓ Freed '+obj.label,'success');
  }
  if(deadY.length) log('Minor GC: collected '+deadY.length+' young object(s)','success');
  else log('Minor GC: no garbage in young generation.','success');

  // STEP 4 — major GC?
  const oldNow=objects.filter(o=>o.gen==='old'&&o.state!=='freed');
  setStep('STEP 4 / 4','Old generation check ('+oldNow.length+' objects)',
    oldNow.length>=3
      ? 'Old generation has '+oldNow.length+' objects — threshold reached. Triggering Major GC. This is expensive (full old gen scan, longer pause) but happens rarely. The infrequency is what makes generational GC efficient overall.'
      : 'Old generation has only '+oldNow.length+' object(s) — below threshold. No major GC needed. This is the efficiency win: long-lived objects are rarely scanned.');
  await W8(1300);

  if(oldNow.length>=3){
    log('─ Old gen threshold reached — Major GC ─','warn');
    await W8(1200);
    const deadO=oldNow.filter(o=>!reach.has(o.id)&&!o.isRoot);
    for(const obj of deadO){
      setStep('MAJOR GC','Collecting old '+obj.label,
        obj.label+' is in the old generation but is no longer reachable. Major GC must scan the entire old generation to find these — that\'s why it causes longer pauses. This happens infrequently to maintain overall throughput.');
      obj.scanning=true;
      log('  Collecting old '+obj.label,'warn');
      await W8(1000);
      obj.scanning=false; obj.state='freeing';
      edges=edges.filter(e=>e.from!==obj.id&&e.to!==obj.id);
      await W8(700); obj.state='freed';
      log('  ✓ Freed old '+obj.label,'success');
    }
    if(!deadO.length) log('  No unreachable objects in old gen.','success');
    log('Major GC complete.','success');
  } else {
    log('Old gen below threshold — skipping major GC.','success');
  }
}

// ---- HELPERS ----
function getReachable(){
  const vis=new Set();
  const roots=objects.filter(o=>o.isRoot&&o.state!=='freed');
  const q=[...roots]; roots.forEach(o=>vis.add(o.id));
  while(q.length){
    const o=q.shift();
    for(const e of edges.filter(e=>e.from===o.id)){
      const c=objects.find(x=>x.id===e.to&&x.state!=='freed');
      if(c&&!vis.has(c.id)){vis.add(c.id);q.push(c);}
    }
  }
  return vis;
}

function log(msg,type='info'){
  const el=document.createElement('div');
  el.className='log-line '+type; el.textContent='▸ '+msg;
  logBody.appendChild(el); logBody.scrollTop=logBody.scrollHeight;
  const lines=logBody.querySelectorAll('.log-line');
  if(lines.length>40) lines[0].remove();
}

function resetViz(){
  objects=[]; edges=[]; idCounter=0; gcRunning=false; pulseEdge=null;
  logBody.innerHTML='<div class="log-line info">▸ Visualizer ready. Allocate some objects to begin.</div>';
  overlay.classList.remove('hidden');
  clearStep(); refreshDropdowns();
}

function scrollToViz(){
  document.getElementById('viz-section').scrollIntoView({behavior:'smooth'});
}

// canvas click → inspect object
canvas.addEventListener('click', e=>{
  if(gcRunning) return;
  const rect=canvas.getBoundingClientRect();
  const mx=(e.clientX-rect.left)*(W/rect.width);
  const my=(e.clientY-rect.top)*(H/rect.height);
  for(const obj of objects){
    if(obj.state==='freed') continue;
    if(Math.hypot(mx-obj.x,my-obj.y)<obj.r){
      const inc=edges.filter(e=>e.to===obj.id).length;
      const out=edges.filter(e=>e.from===obj.id).length;
      log('Inspect '+obj.label+': state='+obj.state+' rc='+obj.refCount+' gen='+obj.gen+' age='+obj.age+' root='+obj.isRoot+' in='+inc+' out='+out,'info');
      setStep('INSPECT',obj.label+' — '+obj.state,
        'State: '+obj.state+' | RefCount: '+obj.refCount+' | Generation: '+obj.gen+' | Age: '+obj.age+' | Root: '+obj.isRoot+' | Incoming refs: '+inc+' | Outgoing refs: '+out);
      return;
    }
  }
});

resizeCanvas();
render();