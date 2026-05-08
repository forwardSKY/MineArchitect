/**
 * pipeline.ts — End-to-End Orchestration
 *
 * Input → Stage 1 (normalize) → Stage 2 (solve) → HTML
 *
 * Stage 1: 1 LLM call, best model
 * Stage 2: N LLM calls (one per sentence), any model
 * Render:  0 LLM calls, pure template
 */

import {
  createEngine, execute, executeBatch, buildContext,
  fillDefaults, solvedEntities, Op, Entity,
  cloneEngine, commitInto, EngineState
} from './engine';import { STAGE1_PROMPT, STAGE2_PROMPT } from './prompts';

export type LLMCall = (system: string, user: string) => Promise<string>;

/** 每一句处理的上下文 */
interface SentenceCtx {
  allSentences: string[];
  index: number;
  recentWindow: number;
}

export interface PipelineResult {
  normalized: string[];
  entityCount: number;
  totalOps: number;
  finalDOF: number;
  html: string;
}

/** Full pipeline: raw text → HTML */
/** Full pipeline: raw text → HTML */
/** Full pipeline: raw text → HTML */
export async function run(
  input: string,
  callLLM: LLMCall,
): Promise<PipelineResult> {
  // ── Stage 1: Normalize ──
  const normText = await callLLM(STAGE1_PROMPT, input);
  const sentences = normText.split('\n').map(s => s.trim()).filter(s => s.length > 0);

  // ── Stage 2: Solve ──
  // THIS IS THE MISSING LINE YOUR EDITOR IS COMPLAINING ABOUT:
  const engine = createEngine(); 
  let totalOps = 0;

  for (let i = 0; i < sentences.length; i++) {
    const ctx: SentenceCtx = {
      allSentences: sentences,
      index: i,
      recentWindow: 4   // 展示最近4句，可根据需要调整
    };
    const result = await solveSentence(engine, ctx, callLLM);
    totalOps += result.logs.length;  
  }

  // Fill any remaining DOF
  fillDefaults(engine);

  // ── Render ──
  const entities = solvedEntities(engine);
  const html = renderHTML(entities);

  return {
    normalized: sentences,
    entityCount: entities.length,
    totalOps,
    finalDOF: engine.totalDOF,
    html,
  };
}


/** Parse JSON ops from LLM response */
function parseOps(raw: string): Op[] {
  try {
    const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // Find the JSON object
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end < 0) return [];
    const json = JSON.parse(clean.substring(start, end + 1));
    return json.ops || [];
  } catch {
    return [];
  }
}


/** 只向 LLM 展示与当前句子相关的实体（滑动窗口） */
function buildScopedContext(
  engine: EngineState,
  ctx: SentenceCtx,
  feedback: string
): string {
  const current = ctx.allSentences[ctx.index];
  const recent = ctx.allSentences.slice(
    Math.max(0, ctx.index - ctx.recentWindow),
    ctx.index
  );
  const lookahead = ctx.allSentences.slice(ctx.index + 1, ctx.index + 2);

  // 1) 确定作用域内实体：
  //    - 当前句和前几句文本中出现过的 ID
  //    - 未完成（dofPos > 0）的实体
  //    - 最后声明的几个实体（最近 5 个）
  const inScope = new Set<string>();
  const text = [...recent, current].join(' ').toLowerCase();

  // 遍历所有实体，ID 出现在文本中则加入范围
  for (const id of engine.entities.keys()) {
    if (text.includes(id)) inScope.add(id);
    else {
      // 宽松匹配：snake_case 分词，至少出现 2 个字符的片段
      const parts = id.split('_');
      if (parts.length && parts.every(p => text.includes(p))) inScope.add(id);
    }
  }

  // 未完成实体总是可见
  for (const e of engine.entities.values()) {
    if (e.dofPos > 0) inScope.add(e.id);
  }

  // 最后声明的 5 个实体（按 id 插入顺序不好，我们记一下最后 declare 的时间？暂时用最近加入的 5 个）
  // 简单方案：把 entities 转为数组取最后 5 个
  const allIds = [...engine.entities.keys()];
  const recentDeclarations = allIds.slice(-5);
  recentDeclarations.forEach(id => inScope.add(id));

  // 2) 构建上下文文本
  const lines: string[] = ['== ENTITIES IN SCOPE =='];
  for (const id of inScope) {
    const e = engine.entities.get(id)!;
    lines.push(formatEntityShort(e));
  }

  const outIds = allIds.filter(id => !inScope.has(id));
  if (outIds.length > 0) {
    lines.push(`\n== ${outIds.length} OTHER ENTITIES (IDs only) ==`);
    lines.push(outIds.join(', '));
  }

  // 3) 叙事句
  lines.push('\n== RECENT SENTENCES ==');
  recent.forEach((s, i) => lines.push(`[${ctx.index - recent.length + i + 1}] ${s}`));
  lines.push(`\n>>> CURRENT [${ctx.index + 1}/${ctx.allSentences.length}] <<<`);
  lines.push(current);
  if (lookahead.length) lines.push(`\n(next: ${lookahead[0]})`);

  if (feedback) lines.push(`\n== FEEDBACK FROM PREVIOUS ATTEMPT ==\n${feedback}`);

  return lines.join('\n');
}

/** 简短格式化单个实体 */
function formatEntityShort(e: Entity): string {
  const status = e.position
    ? `pos=(${e.position.map(v => v.toFixed(1))})`
    : `dof=${e.dofPos}`;
  let line = `${e.id}: ${e.type} dims(${e.dims}) ${status}`;
  if (e.position) {
    const [x, y, z] = e.position;
    const [w, h, d] = e.dims;
    line += ` faces: e${(x + w/2).toFixed(1)} w${(x - w/2).toFixed(1)} n${(z + d/2).toFixed(1)} s${(z - d/2).toFixed(1)} t${(y + h/2).toFixed(1)} b${(y - h/2).toFixed(1)}`;
  }
  return line;
}


/** 处理单个句子的 Agent Loop，带重试和反馈 */
async function solveSentence(
  engine: EngineState,
  ctx: SentenceCtx,
  callLLM: LLMCall,
  maxAttempts = 3
): Promise<{ ok: boolean; attempts: number; logs: string[] }> {
  let feedback = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1. 克隆引擎，在副本上尝试
    const trial = cloneEngine(engine);
    const dofBefore = trial.totalDOF;

    // 2. 构建 prompt（目前使用全量上下文）
    const current = ctx.allSentences[ctx.index];
    const recent = ctx.allSentences.slice(
      Math.max(0, ctx.index - ctx.recentWindow),
      ctx.index
    );
    const prompt = buildScopedContext(trial, ctx, feedback) +
      `\nOutput the PGA operations for this sentence as JSON {"ops":[...]}`;

    // 3. 调用 LLM
    const resp = await callLLM(STAGE2_PROMPT, prompt);
    const ops = parseOps(resp);

    // 4. 空操作直接成功
    if (ops.length === 0) {
      return { ok: true, attempts: attempt, logs: ['no-op'] };
    }

    // 5. 在副本上执行操作
    const logs = executeBatch(trial, ops);

    // 6. 检查结果
    const errors = logs.filter(l => l.startsWith('error'));
    const dofReduced = dofBefore - trial.totalDOF;
    const hasDeclare = ops.some(o => o.op === 'declare');

    // 接受条件：无错误，且 (有 declare 或 DOF 确实下降)
    const ok = errors.length === 0 && (hasDeclare || dofReduced > 0);

    if (ok) {
      // 成功：将副本状态写回主引擎
      commitInto(engine, trial);
      return { ok: true, attempts: attempt, logs };
    }

    // 失败：构建反馈并准备重试
    feedback =
      `Attempt ${attempt} rejected.\n` +
      (errors.length ? `Errors: ${errors.join('; ')}\n` : '') +
      `DOF before=${dofBefore} after=${trial.totalDOF} (need to decrease).\n` +
      `Common issues: parallel/duplicate planes, wrong face name, referencing undeclared id.`;
  }

  // 超过最大重试次数
  return { ok: false, attempts: maxAttempts, logs: ['gave up after retries'] };
}

/** Direct pipeline: skip LLM, provide ops per sentence directly */
export function runDirect(
  sentences: string[],
  opsPerSentence: Op[][],
): PipelineResult {
  const engine = createEngine();
  let totalOps = 0;

  for (let i = 0; i < sentences.length; i++) {
    const ops = opsPerSentence[i] || [];
    const logs = executeBatch(engine, ops);
    totalOps += ops.length;
    // Print progress
    if (ops.length > 0) {
      console.log(`  [${i + 1}/${sentences.length}] "${sentences[i].substring(0, 50)}..."`);
      logs.forEach(l => console.log(`    ${l}`));
    }
  }

  console.log(`\n  Pre-default DOF: ${engine.totalDOF}`);
  fillDefaults(engine);
  console.log(`  Post-default DOF: ${engine.totalDOF}`);

  const entities = solvedEntities(engine);
  const html = renderHTML(entities);

  return { normalized: sentences, entityCount: entities.length, totalOps, finalDOF: engine.totalDOF, html };
}


// ═══════════════════════════════════════════════════════════════════
// HTML RENDERER — Architectural sketch aesthetic
// ═══════════════════════════════════════════════════════════════════

interface RenderEntity {
  id: string; type: string; material: string;
  position: [number, number, number];
  dims: [number, number, number];
  orient: number; log: string[];
}

const MAT_COLORS: Record<string, [string, string, number]> = {
  // [fill, edge, opacity]
  wood:     ['#C8A060', '#8A6830', 0.50],
  oak:      ['#D4B878', '#9A7840', 0.50],
  stone:    ['#908478', '#605448', 0.55],
  glass:    ['#B8D8E8', '#6A9AB8', 0.15],
  concrete: ['#C8C0B8', '#8A8280', 0.40],
  steel:    ['#CCCCCC', '#888888', 0.50],
  metal:    ['#AAAAAA', '#666666', 0.50],
  fabric:   ['#D8C8B0', '#A89880', 0.50],
  tile:     ['#E8D8C8', '#B0A090', 0.50],
  ceramic:  ['#E0D4C4', '#B0A090', 0.50],
  drywall:  ['#E8E0D8', '#B0A898', 0.30],
  organic:  ['#8AAE68', '#5A7E40', 0.35],
  default:  ['#E0D8D0', '#A89A90', 0.40],
};

function renderHTML(entities: RenderEntity[]): string {
  // Build mesh data
  const meshes = entities.map(e => {
    const [fill, edge, opacity] = MAT_COLORS[e.material] || MAT_COLORS.default;
    return { ...e, fill, edge, opacity };
  });

  // Compute camera bounds
  let maxR = 10;
  for (const m of meshes) {
    const r = Math.sqrt(m.position[0] ** 2 + m.position[2] ** 2) + Math.max(...m.dims);
    if (r > maxR) maxR = r;
  }
  const camDist = maxR * 1.8;

  const meshJSON = JSON.stringify(meshes);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PGA Sketch</title>
<style>
*{margin:0;box-sizing:border-box}
body{background:#f5f2ed;overflow:hidden;font-family:system-ui,sans-serif}
canvas{display:block;cursor:grab}canvas:active{cursor:grabbing}
#hud{position:fixed;top:16px;left:16px;background:rgba(245,242,237,.92);border:1px solid rgba(0,0,0,.08);border-radius:8px;padding:12px 16px;pointer-events:auto;max-width:260px}
#hud h3{font-size:12px;font-weight:600;color:#2a2a2a;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px}
#hud p{font-size:11px;color:#888;line-height:1.5;margin:0}
#info{position:fixed;bottom:16px;left:16px;font-size:10px;color:#aaa}
#cut{position:fixed;right:16px;top:50%;transform:translateY(-50%);writing-mode:vertical-lr;-webkit-appearance:none;width:3px;height:180px;background:rgba(0,0,0,.1);border-radius:2px;outline:none}
#cut::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#2a2a2a;cursor:grab}
.btn{font-size:11px;padding:4px 10px;border:1px solid rgba(0,0,0,.12);border-radius:4px;background:#fff;cursor:pointer;color:#444;margin:2px}
.btn:hover{background:#eee}.btn.on{background:#2a2a2a;color:#fff;border-color:#2a2a2a}
</style></head><body>
<div id="hud">
<h3>PGA Sketch Engine</h3>
<p>${meshes.length} entities · all DOF=0</p>
<div style="margin-top:6px">
<button class="btn on" onclick="setMode('sketch')">Sketch</button>
<button class="btn" onclick="setMode('xray')">X-Ray</button>
<button class="btn" onclick="setMode('wire')">Wire</button>
</div>
</div>
<input type="range" id="cut" min="0" max="100" value="100" oninput="setCut(this.value)">
<div id="info">Drag to orbit · Scroll to zoom · Slider to section</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
const M=${meshJSON};
const W=innerWidth,H=innerHeight;
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setSize(W,H);renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.setClearColor(0xf5f2ed);renderer.localClippingEnabled=true;
document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene();
scene.fog=new THREE.Fog(0xf5f2ed,50,90);
const cam=new THREE.PerspectiveCamera(28,W/H,.1,200);
scene.add(new THREE.AmbientLight(0xffffff,.45));
const sun=new THREE.DirectionalLight(0xFFF8EE,.55);
sun.position.set(12,25,15);sun.castShadow=true;
sun.shadow.camera.left=-20;sun.shadow.camera.right=20;
sun.shadow.camera.top=20;sun.shadow.camera.bottom=-20;
sun.shadow.mapSize.set(2048,2048);scene.add(sun);
scene.add(new THREE.HemisphereLight(0xD4E4F4,0xE8DCC8,.25));
const gnd=new THREE.Mesh(new THREE.PlaneGeometry(80,80),new THREE.MeshLambertMaterial({color:0xE8E4DC}));
gnd.rotation.x=-Math.PI/2;gnd.position.y=-.01;gnd.receiveShadow=true;scene.add(gnd);
scene.add(new THREE.GridHelper(40,40,0xd8d4cc,0xe0dcd4));
const clip=new THREE.Plane(new THREE.Vector3(0,-1,0),20);
const fills=[],edges=[];
M.forEach(m=>{
  const g=new THREE.BoxGeometry(m.dims[0],m.dims[1],m.dims[2]);
  const mat=new THREE.MeshLambertMaterial({color:new THREE.Color(m.fill),transparent:true,opacity:m.opacity,side:2,clippingPlanes:[clip]});
  const mesh=new THREE.Mesh(g,mat);
  mesh.position.set(m.position[0],m.position[1],m.position[2]);
  if(m.orient)mesh.rotation.y=m.orient*Math.PI/180;
  mesh.castShadow=m.opacity>.3;mesh.receiveShadow=true;
  scene.add(mesh);fills.push(mesh);
  const eg=new THREE.EdgesGeometry(g);
  const lm=new THREE.LineBasicMaterial({color:new THREE.Color(m.edge),transparent:true,opacity:m.opacity>.2?.65:.25,clippingPlanes:[clip]});
  const wire=new THREE.LineSegments(eg,lm);
  wire.position.copy(mesh.position);wire.rotation.copy(mesh.rotation);
  scene.add(wire);edges.push(wire);
  if(m.type.includes('room')||m.type.includes('kitchen')||m.type.includes('bedroom')||m.type.includes('corridor')||m.type.includes('bathroom')){
    const c=document.createElement('canvas');c.width=256;c.height=48;
    const x=c.getContext('2d');x.font='bold 18px system-ui';x.fillStyle='rgba(80,70,55,.5)';
    x.textAlign='center';x.fillText(m.type.replace(/_/g,' '),128,32);
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),transparent:true}));
    sp.position.set(m.position[0],.05,m.position[2]);sp.scale.set(2.5,.5,1);scene.add(sp);
  }
});
let theta=Math.PI*.28,phi=Math.PI*.18,radius=${camDist.toFixed(0)};
const tgt=new THREE.Vector3(0,2,0);
function uc(){cam.position.set(tgt.x+radius*Math.cos(phi)*Math.sin(theta),tgt.y+radius*Math.sin(phi),tgt.z+radius*Math.cos(phi)*Math.cos(theta));cam.lookAt(tgt)}
uc();
let dr=false,px=0,py=0;
renderer.domElement.addEventListener('pointerdown',e=>{dr=true;px=e.clientX;py=e.clientY;renderer.domElement.setPointerCapture(e.pointerId)});
renderer.domElement.addEventListener('pointermove',e=>{if(!dr)return;theta-=(e.clientX-px)*.006;phi=Math.max(.02,Math.min(1.4,phi+(e.clientY-py)*.006));px=e.clientX;py=e.clientY;uc()});
renderer.domElement.addEventListener('pointerup',()=>dr=false);
renderer.domElement.addEventListener('wheel',e=>{radius=Math.max(5,Math.min(70,radius+e.deltaY*.04));uc();e.preventDefault()},{passive:false});
window.addEventListener('resize',()=>{cam.aspect=innerWidth/innerHeight;cam.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
window.setMode=function(mode){
  document.querySelectorAll('.btn').forEach(b=>b.classList.remove('on'));
  event.target.classList.add('on');
  fills.forEach(m=>{m.visible=mode!=='wire';if(mode==='xray')m.material.opacity=.08;else m.material.opacity=parseFloat(m.material.userData?.origOp||m.material.opacity);});
  edges.forEach(w=>{w.material.opacity=mode==='wire'?.8:.65;w.visible=true});
};
window.setCut=function(v){clip.constant=v*.12};
(function loop(){requestAnimationFrame(loop);renderer.render(scene,cam)})();
</script></body></html>`;
}
