/**
 * pipeline.ts — End-to-End Orchestration (manifest-first)
 *
 * Stage 1 (1 LLM call): raw text → JSON manifest with `entities` + `narrative`.
 *                       All entities are pre-declared in the engine immediately.
 * Stage 2 (N LLM calls): for each narrative sentence → constrain ops.
 *                        With 1 retry on failure (fed feedback).
 * Render (no LLM):       solved entities → HTML (three.js sketch).
 *
 * Why manifest-first?
 *   The previous per-sentence-declare approach drifted on entity IDs
 *   (tower_l vs left_tower vs tower_a) and required brittle vote-merging.
 *   A single Stage 1 call locks the IDs, and Stage 2 only ever picks
 *   from a fixed list — eliminating the entire voting/alignment problem.
 */

import {
  createEngine, execute, executeBatch, fillDefaults, solvedEntities,
  cloneEngine, commitInto, EngineState, Entity, Op,
} from './engine';
import { STAGE1_PROMPT, STAGE2_PROMPT, STAGE_FILL_PROMPT } from './prompts';

export type LLMCall = (system: string, user: string) => Promise<string>;

interface EntityDecl {
  id: string;
  type: string;
  dims: [number, number, number];
  material?: string;
}

interface NarrativeItem {
  refs: string[];
  text: string;
}

export interface PipelineResult {
  normalized: string[];
  entityCount: number;
  totalOps: number;
  finalDOF: number;
  html: string;
}

// ─────────────────────────────────────────────────────────────
//  Robust JSON extraction
// ─────────────────────────────────────────────────────────────

function stripFences(s: string): string {
  return s
    .replace(/^\uFEFF/, '')
    .replace(/^\s*```(?:json|JSON)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/** Find first balanced `{...}` and parse. Tolerates trailing commas. */
function extractJsonObject(raw: string): any | null {
  const s = stripFences(raw);
  const start = s.indexOf('{');
  if (start < 0) return null;

  // Walk through, tracking string state and depth
  let depth = 0;
  let inStr: string | null = null;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.substring(start, i + 1);
        try { return JSON.parse(candidate); } catch {}
        // Repair trailing commas
        try { return JSON.parse(candidate.replace(/,(\s*[}\]])/g, '$1')); } catch {}
        return null;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
//  Stage 1 parsing (manifest + narrative, with JSONL fallback)
// ─────────────────────────────────────────────────────────────

interface Stage1Output {
  entities: EntityDecl[];
  narrative: NarrativeItem[];
}

function sanitizeEntity(raw: any): EntityDecl | null {
  if (!raw || typeof raw.id !== 'string') return null;
  const id = raw.id.trim();
  if (!id) return null;
  const dims = raw.dims;
  if (!Array.isArray(dims) || dims.length !== 3) return null;
  const numDims = dims.map((v: any) => Number(v));
  if (numDims.some(isNaN)) return null;
  return {
    id,
    type: typeof raw.type === 'string' ? raw.type : 'box',
    dims: [numDims[0], numDims[1], numDims[2]],
    material: typeof raw.material === 'string' ? raw.material : undefined,
  };
}

function parseStage1(raw: string): Stage1Output {
  // Primary path: single object with entities + narrative
  const obj = extractJsonObject(raw);
  if (obj && Array.isArray(obj.entities) && Array.isArray(obj.narrative)) {
    const entities: EntityDecl[] = [];
    const seen = new Set<string>();
    for (const e of obj.entities) {
      const cleaned = sanitizeEntity(e);
      if (cleaned && !seen.has(cleaned.id)) {
        seen.add(cleaned.id);
        entities.push(cleaned);
      }
    }
    const narrative: NarrativeItem[] = [];
    for (const n of obj.narrative) {
      if (!n || typeof n.text !== 'string' || !n.text.trim()) continue;
      narrative.push({
        refs: Array.isArray(n.refs) ? n.refs.filter((x: any) => typeof x === 'string') : [],
        text: n.text.trim(),
      });
    }
    return { entities, narrative };
  }

  // Legacy fallback: JSONL of {"entities":[...],"text":"..."}
  const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
  const narrative: NarrativeItem[] = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.text === 'string') {
        narrative.push({
          refs: Array.isArray(o.entities) ? o.entities : (Array.isArray(o.refs) ? o.refs : []),
          text: o.text,
        });
      }
    } catch { /* ignore */ }
  }
  if (narrative.length > 0) return { entities: [], narrative };

  // Last resort: split raw text into sentences
  const sentences = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 5);
  return {
    entities: [],
    narrative: sentences.map(s => ({ refs: [], text: s })),
  };
}

// ─────────────────────────────────────────────────────────────
//  Stage 2 parsing
// ─────────────────────────────────────────────────────────────

function parseOps(raw: string): Op[] {
  const obj = extractJsonObject(raw);
  if (!obj) return [];
  if (Array.isArray(obj)) return obj as Op[];
  if (Array.isArray((obj as any).ops)) return (obj as any).ops as Op[];
  if (typeof (obj as any).op === 'string') return [obj as Op];
  return [];
}

// ─────────────────────────────────────────────────────────────
//  Context builder for Stage 2
// ─────────────────────────────────────────────────────────────

function shortEntity(e: Entity): string {
  if (e.position) {
    const [x, y, z] = e.position;
    const [w, h, d] = e.dims;
    return `${e.id}: ${e.type} dims=[${e.dims.join(',')}] RESOLVED at (${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)})` +
      ` faces e=${(x + w / 2).toFixed(1)} w=${(x - w / 2).toFixed(1)}` +
      ` n=${(z + d / 2).toFixed(1)} s=${(z - d / 2).toFixed(1)}` +
      ` t=${(y + h / 2).toFixed(1)} b=${(y - h / 2).toFixed(1)}`;
  }
  return `${e.id}: ${e.type} dims=[${e.dims.join(',')}] DECLARED dof=${e.dofPos}/3`;
}

function buildPrompt(
  engine: EngineState,
  manifest: EntityDecl[],
  narrative: NarrativeItem[],
  index: number,
  feedback: string
): string {
  const current = narrative[index];
  const recent = narrative.slice(Math.max(0, index - 3), index);
  const lookahead = narrative.slice(index + 1, index + 2);

  // Entities relevant to this sentence: refs + recent refs + unresolved + sample of resolved
  const inScope = new Set<string>();
  current.refs.forEach(id => inScope.add(id));
  recent.forEach(n => n.refs.forEach(id => inScope.add(id)));
  for (const e of engine.entities.values()) {
    if (e.dofPos > 0) inScope.add(e.id);
  }

  const lines: string[] = [];

  // Manifest section: ALWAYS show the in-scope entities by ID
  lines.push('== ENTITY MANIFEST (use these IDs and dims exactly) ==');
  if (manifest.length > 0) {
    for (const m of manifest) {
      const e = engine.entities.get(m.id);
      const status = e
        ? (e.position
            ? `RESOLVED at (${e.position.map(v => v.toFixed(2)).join(',')})`
            : `DECLARED dof=${e.dofPos}/3`)
        : 'NOT YET DECLARED';
      const star = inScope.has(m.id) ? '★' : ' ';
      lines.push(`  ${star} ${m.id}: ${m.type} dims=[${m.dims.join(',')}] material=${m.material ?? 'default'} | ${status}`);
    }
  } else {
    // Fallback: show all engine entities (manifest empty when Stage 1 failed)
    for (const e of engine.entities.values()) {
      lines.push(`  ${shortEntity(e)}`);
    }
    if (engine.entities.size === 0) {
      lines.push('  (no entities yet — declare new ones as needed)');
    }
  }

  if (recent.length) {
    lines.push('\n== RECENT SENTENCES (already processed) ==');
    recent.forEach((n, i) =>
      lines.push(`  [${index - recent.length + i + 1}] (${n.refs.join(',') || '-'}) ${n.text}`));
  }

  lines.push(`\n== CURRENT SENTENCE [${index + 1}/${narrative.length}] ==`);
  lines.push(`primary refs: ${current.refs.join(', ') || '(none — infer from text)'}`);
  lines.push(`text: ${current.text}`);

  if (lookahead.length) {
    lines.push(`\n(next sentence preview: ${lookahead[0].text})`);
  }

  if (feedback) {
    lines.push(`\n== FEEDBACK FROM PREVIOUS ATTEMPT ==`);
    lines.push(feedback);
  }

  lines.push('\nProduce {"ops":[...]} for the CURRENT SENTENCE only. JSON only.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
//  Solve a single sentence with one retry
// ─────────────────────────────────────────────────────────────

async function solveSentence(
  engine: EngineState,
  manifest: EntityDecl[],
  narrative: NarrativeItem[],
  index: number,
  callLLM: LLMCall
): Promise<{ ok: boolean; logs: string[] }> {
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildPrompt(engine, manifest, narrative, index, feedback);

    let resp = '';
    try {
      resp = await callLLM(STAGE2_PROMPT, prompt);
    } catch (err: any) {
      feedback = `LLM call failed: ${err?.message ?? err}`;
      continue;
    }

    const ops = parseOps(resp);

    // Empty ops is valid for transition sentences ("I walk forward")
    if (ops.length === 0) {
      return { ok: true, logs: ['no-op'] };
    }

    const trial = cloneEngine(engine);
    const dofBefore = trial.totalDOF;
    const logs = executeBatch(trial, ops);
    const errors = logs.filter(l => l.startsWith('error'));
    const dofReduced = dofBefore - trial.totalDOF;
    const hasDeclare = ops.some(o => o.op === 'declare');

    if (errors.length === 0 && (hasDeclare || dofReduced > 0)) {
      commitInto(engine, trial);
      return { ok: true, logs };
    }

    feedback =
      `Attempt ${attempt} rejected.\n` +
      (errors.length ? `Errors: ${errors.join('; ')}\n` : '') +
      `DOF before=${dofBefore} after=${trial.totalDOF} (need decrease).\n` +
      `Common fixes: use entity IDs from the manifest exactly, use at_x/at_z instead of plane,` +
      ` ensure 3 independent constraints (one per axis).`;
  }
  return { ok: false, logs: ['gave up after 2 attempts'] };
}

// ─────────────────────────────────────────────────────────────
//  Common-sense closure round (Theory §5 fixed-point iteration)
//
//  After the main per-sentence loop, residual DOF is closed by
//  feeding unresolved entities back to the LLM for common-sense
//  placement, BEFORE falling back to blind defaults.
//
//  Convergence:
//    DOF ∈ ℤ≥0, monotone non-increasing → terminates ≤ 4N rounds.
//    In practice 1–2 rounds suffice.
// ─────────────────────────────────────────────────────────────

interface FillResult { rounds: number; resolvedDOF: number; }

function buildFillPrompt(engine: EngineState): string {
  const lines: string[] = [];
  const resolved: Entity[] = [];
  const unresolved: Entity[] = [];
  for (const e of engine.entities.values()) {
    (e.dofPos > 0 ? unresolved : resolved).push(e);
  }

  // Show resolved entities so LLM can reason relative to them.
  // For very large scenes, cap to avoid prompt bloat.
  const RESOLVED_LIMIT = 60;
  lines.push('== RESOLVED ENTITIES (use as anchors) ==');
  const shown = resolved.slice(0, RESOLVED_LIMIT);
  for (const e of shown) {
    const [x, y, z] = e.position!;
    lines.push(`  ${e.id}: ${e.type} at (${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}) dims=[${e.dims.join(',')}]`);
  }
  if (resolved.length > RESOLVED_LIMIT) {
    lines.push(`  … and ${resolved.length - RESOLVED_LIMIT} more resolved entities (omitted for brevity).`);
  }

  lines.push('\n== UNRESOLVED ENTITIES (place these now) ==');
  for (const e of unresolved) {
    lines.push(`  ${e.id}: ${e.type} dims=[${e.dims.join(',')}] dof_remaining=${e.dofPos}/3 planes_so_far=${e.planes.length}`);
  }

  lines.push('\nProduce constrain ops to bring every unresolved entity to dof=0.');
  lines.push('Use entity IDs exactly as listed. JSON only.');
  return lines.join('\n');
}

async function commonSenseFillRound(
  engine: EngineState,
  callLLM: LLMCall,
  maxRounds = 2
): Promise<FillResult> {
  let totalResolved = 0;
  let round = 0;

  for (round = 1; round <= maxRounds; round++) {
    const unresolvedCount = [...engine.entities.values()].filter(e => e.dofPos > 0).length;
    if (unresolvedCount === 0) break;

    const prompt = buildFillPrompt(engine);

    let resp = '';
    try {
      resp = await callLLM(STAGE_FILL_PROMPT, prompt);
    } catch (err: any) {
      console.warn(`  fill round ${round} LLM error: ${err?.message ?? err}`);
      break;
    }

    const ops = parseOps(resp);
    if (ops.length === 0) break;

    const trial = cloneEngine(engine);
    const before = trial.totalDOF;
    executeBatch(trial, ops);
    const reduction = before - trial.totalDOF;

    if (reduction > 0) {
      commitInto(engine, trial);
      totalResolved += reduction;
    } else {
      // No progress — abort to avoid infinite loops on pathological responses
      break;
    }
  }
  return { rounds: round - 1, resolvedDOF: totalResolved };
}

// ─────────────────────────────────────────────────────────────
//  Information budget (Theory §1.2)
// ─────────────────────────────────────────────────────────────

function reportBudget(engine: EngineState, narrativeLen: number): void {
  let totalDeclared = 0;
  let posResolved = 0;
  let posUnresolved = 0;
  for (const e of engine.entities.values()) {
    totalDeclared++;
    if (e.position) posResolved++;
    else posUnresolved += e.dofPos;
  }
  const posDOFNeeded = totalDeclared * 3;
  const posDOFProvided = posDOFNeeded - posUnresolved;
  console.log(
    `  Info budget: positional DOF ${posDOFProvided}/${posDOFNeeded} ` +
    `(${posResolved}/${totalDeclared} entities resolved) ` +
    `from ${narrativeLen} sentences`
  );
}

// ─────────────────────────────────────────────────────────────
//  Pre-declare manifest entities into engine
// ─────────────────────────────────────────────────────────────

function preDeclareManifest(engine: EngineState, manifest: EntityDecl[]): number {
  let count = 0;
  for (const m of manifest) {
    const result = execute(engine, {
      op: 'declare',
      id: m.id,
      type: m.type,
      dims: m.dims,
      material: m.material,
    });
    if (result.startsWith('ok')) count++;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────
//  Main pipeline
// ─────────────────────────────────────────────────────────────

export async function run(
  input: string,
  callLLM: LLMCall
): Promise<PipelineResult> {
  // Stage 1
  const stage1Resp = await callLLM(STAGE1_PROMPT, input);
  const { entities: manifest, narrative } = parseStage1(stage1Resp);

  console.log(`  Stage 1: ${manifest.length} entities declared, ${narrative.length} sentences`);

  // Engine setup — pre-declare everything from the manifest
  const engine = createEngine();
  preDeclareManifest(engine, manifest);

  // Stage 2 — one call per narrative sentence (with retry)
  let totalOps = 0;
  let okCount = 0;
  for (let i = 0; i < narrative.length; i++) {
    const result = await solveSentence(engine, manifest, narrative, i, callLLM);
    totalOps += result.logs.length;
    if (result.ok) okCount++;
  }
  console.log(`  Stage 2: ${okCount}/${narrative.length} sentences solved`);
  reportBudget(engine, narrative.length);

  // Common-sense closure rounds (Theory §5 fixed-point iteration)
  const fill = await commonSenseFillRound(engine, callLLM);
  if (fill.rounds > 0) {
    console.log(`  Common-sense fill: ${fill.resolvedDOF} DOF resolved across ${fill.rounds} round(s)`);
    reportBudget(engine, narrative.length);
  }

  // Last resort: blind defaults for anything still unresolved
  fillDefaults(engine);

  // Render
  const entities = solvedEntities(engine);
  const html = renderHTML(entities);

  return {
    normalized: narrative.map(n => n.text),
    entityCount: entities.length,
    totalOps,
    finalDOF: engine.totalDOF,
    html,
  };
}

// ═══════════════════════════════════════════════════════════════════
// HTML RENDERER — Architectural sketch aesthetic (unchanged)
// ═══════════════════════════════════════════════════════════════════

interface RenderEntity {
  id: string; type: string; material: string;
  position: [number, number, number];
  dims: [number, number, number];
  orient: number; log: string[];
}

const MAT_COLORS: Record<string, [string, string, number]> = {
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
  const meshes = entities.map(e => {
    const [fill, edge, opacity] = MAT_COLORS[e.material] || MAT_COLORS.default;
    return { ...e, fill, edge, opacity };
  });

  let maxR = 10;
  for (const m of meshes) {
    const r = Math.sqrt(m.position[0] ** 2 + m.position[2] ** 2) + Math.max(...m.dims);
    if (r > maxR) maxR = r;
  }
  const camDist = Math.min(maxR * 1.8, 200);
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
scene.fog=new THREE.Fog(0xf5f2ed,80,160);
const cam=new THREE.PerspectiveCamera(28,W/H,.1,400);
scene.add(new THREE.AmbientLight(0xffffff,.45));
const sun=new THREE.DirectionalLight(0xFFF8EE,.55);
sun.position.set(12,25,15);sun.castShadow=true;
sun.shadow.camera.left=-30;sun.shadow.camera.right=30;
sun.shadow.camera.top=30;sun.shadow.camera.bottom=-30;
sun.shadow.mapSize.set(2048,2048);scene.add(sun);
scene.add(new THREE.HemisphereLight(0xD4E4F4,0xE8DCC8,.25));
const gnd=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshLambertMaterial({color:0xE8E4DC}));
gnd.rotation.x=-Math.PI/2;gnd.position.y=-.01;gnd.receiveShadow=true;scene.add(gnd);
scene.add(new THREE.GridHelper(80,80,0xd8d4cc,0xe0dcd4));
const clip=new THREE.Plane(new THREE.Vector3(0,-1,0),50);
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
renderer.domElement.addEventListener('wheel',e=>{radius=Math.max(5,Math.min(200,radius+e.deltaY*.06));uc();e.preventDefault()},{passive:false});
window.addEventListener('resize',()=>{cam.aspect=innerWidth/innerHeight;cam.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
window.setMode=function(mode){
  document.querySelectorAll('.btn').forEach(b=>b.classList.remove('on'));
  event.target.classList.add('on');
  fills.forEach(m=>{m.visible=mode!=='wire';if(mode==='xray')m.material.opacity=.08;else m.material.opacity=parseFloat(m.material.userData?.origOp||m.material.opacity);});
  edges.forEach(w=>{w.material.opacity=mode==='wire'?.8:.65;w.visible=true});
};
window.setCut=function(v){clip.constant=v*.5};
(function loop(){requestAnimationFrame(loop);renderer.render(scene,cam)})();
</script></body></html>`;
}
