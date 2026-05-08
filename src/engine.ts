/**
 * engine.ts — PGA State Machine
 *
 * Each entity accumulates constraint planes via the `meet` operation.
 * When 3 independent planes are present, their intersection (triple meet)
 * yields the entity's position. Orientation is tracked separately.
 *
 * Operation set (what the Solver Agent can invoke):
 *   declare(id, type, dims, material?)  — register entity, DOF=3+1
 *   meet(entity, plane)                 — add constraint plane, DOF_pos -= 1
 *   orient(entity, angle)               — set y-rotation, DOF_orient -= 1
 */

import { Plane, meetPlanes, planesIndependent, P } from './pga';

// ─── 约束 DSL 类型 ──────────────────────────────────────────────
export type Face = 'east' | 'west' | 'north' | 'south' | 'top' | 'bottom';

export type Constraint =
  | { kind: 'on_floor' }
  | { kind: 'at_height'; y: number }
  | { kind: 'against'; of: string; face: Face; gap?: number }
  | { kind: 'on_top_of'; of: string }
  | { kind: 'centered_in'; of: string; axis: 'x' | 'z' }
  | { kind: 'aligned_face'; of: string; face: Face }
  | { kind: 'offset_from'; of: string; axis: 'x' | 'y' | 'z'; delta: number }
  | { kind: 'plane'; coeffs: Plane };   // 逃生舱

// ─── 操作扩增 ──────────────────────────────────────────────────
export type Op =
  | { op: 'declare'; id: string; type: string; dims: [number, number, number]; material?: string }
  | { op: 'meet'; entity: string; plane: Plane }                           // 保留旧方式
  | { op: 'constrain'; entity: string; constraint: Constraint }            // 新 DSL
  | { op: 'orient'; entity: string; angle: number };

  // ─── 约束解析结果 ──────────────────────────────────────────────
type Resolved =
  | { plane: Plane }
  | { defer: string }    // 被引用实体尚未解析
  | { error: string };
  
export interface Entity {
  id: string;
  type: string;
  dims: [number, number, number]; // [width_x, height_y, depth_z]
  material: string;

  /** Constraint planes accumulated via meet */
  planes: Plane[];

  /** Resolved position (null until 3 independent planes) */
  position: [number, number, number] | null;

  /** Y-rotation in degrees (null = unresolved) */
  orient: number | null;

  /** Positional DOF remaining: 3 → 2 → 1 → 0 */
  dofPos: number;

  /** Applied operations log */
  log: string[];
  /** 尚未能解析的约束（因为引用的实体还未解算） */
  deferred: Constraint[];
}

export interface EngineState {
  entities: Map<string, Entity>;
  /** Total DOF across all entities */
  totalDOF: number;
}

/** 将符号约束解析为具体平面，如果依赖的实体未就绪则返回 defer */
function resolveConstraint(
  state: EngineState,
  entityId: string,
  constraint: Constraint
): Resolved {
  const e = state.entities.get(entityId);
  if (!e) return { error: `entity ${entityId} not found` };

  // 辅助：获取一个引用实体的位置和尺寸，未声明或未解析则 defer
  const needRef = (id: string) => {
    const ref = state.entities.get(id);
    if (!ref) return { error: `ref entity ${id} not declared` };
    if (!ref.position) return { defer: id };
    return { ref };
  };

  switch (constraint.kind) {
    case 'on_floor':
      return { plane: P.y(e.dims[1] / 2) };

    case 'at_height':
      return { plane: P.y(constraint.y + e.dims[1] / 2) };

    case 'against': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error! };
      if ('defer' in needed) return { defer: needed.defer! };
      const { ref } = needed;
      const [rx, ry, rz] = ref.position!;
      const [rw, rh, rd] = ref.dims;
      const [ew, eh, ed] = e.dims;
      const g = constraint.gap ?? 0;
      // 实体放在目标面内侧：目标表面坐标 → 向内侧偏移半个宽度
      switch (constraint.face) {
        case 'east':   return { plane: P.x(rx + rw / 2 - ew / 2 - g) };
        case 'west':   return { plane: P.x(rx - rw / 2 + ew / 2 + g) };
        case 'north':  return { plane: P.z(rz + rd / 2 - ed / 2 - g) };
        case 'south':  return { plane: P.z(rz - rd / 2 + ed / 2 + g) };
        case 'top':    return { plane: P.y(ry + rh / 2 + eh / 2 + g) };
        case 'bottom': return { plane: P.y(ry - rh / 2 - eh / 2 - g) };
      }
    }

    case 'on_top_of': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error! };
      if ('defer' in needed) return { defer: needed.defer! };
      const { ref } = needed;
      
      const top = ref.position![1] + ref.dims[1] / 2;
      return { plane: P.y(top + e.dims[1] / 2) };
    }

    case 'centered_in': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error! };
      if ('defer' in needed) return { defer: needed.defer! };
      const { ref } = needed;
      
      const idx = constraint.axis === 'x' ? 0 : 2;
      const makePlane = constraint.axis === 'x' ? P.x : P.z;
      return { plane: makePlane(ref.position![idx]) };
    }

    case 'aligned_face': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error! };
      if ('defer' in needed) return { defer: needed.defer! };
      const { ref } = needed;
      
      const [rx, ry, rz] = ref.position!;
      const [rw, rh, rd] = ref.dims;
      const [ew, eh, ed] = e.dims;
      switch (constraint.face) {
        case 'east':   return { plane: P.x(rx + rw / 2 - ew / 2) };
        case 'west':   return { plane: P.x(rx - rw / 2 + ew / 2) };
        case 'north':  return { plane: P.z(rz + rd / 2 - ed / 2) };
        case 'south':  return { plane: P.z(rz - rd / 2 + ed / 2) };
        case 'top':    return { plane: P.y(ry + rh / 2 - eh / 2) };
        case 'bottom': return { plane: P.y(ry - rh / 2 + eh / 2) };
      }
    }

    case 'offset_from': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error! };
      if ('defer' in needed) return { defer: needed.defer! };
      const { ref } = needed;
      
      const idx = constraint.axis === 'x' ? 0 : constraint.axis === 'y' ? 1 : 2;
      const makePlane = constraint.axis === 'x' ? P.x : constraint.axis === 'y' ? P.y : P.z;
      return { plane: makePlane(ref.position![idx] + constraint.delta) };
    }

    case 'plane':
      return { plane: constraint.coeffs };
  }
}

/** 将一个新平面应用到实体上（独立性检查、减 DOF、尝试解位置） */
function applyPlane(
  state: EngineState,
  entity: Entity,
  plane: Plane
): string {
  // 独立性检查
  for (const existing of entity.planes) {
    if (!planesIndependent(existing, plane)) {
      return `skip: parallel plane on ${entity.id}`;
    }
  }

  entity.planes.push(plane);
  entity.dofPos--;
  state.totalDOF--;
  entity.log.push(`meet([${plane.map(v => v.toFixed(2))}]) → DOF_pos=${entity.dofPos}`);

  if (entity.planes.length >= 3 && !entity.position) {
    const pos = meetPlanes(entity.planes[0], entity.planes[1], entity.planes[2]);
    if (pos) {
      entity.position = pos;
      entity.log.push(`resolved → (${pos.map(v => v.toFixed(2))})`);
      return `ok: ${entity.id} resolved at (${pos.map(v => v.toFixed(2))})`;
    }
  }
  return `ok: ${entity.id} DOF_pos=${entity.dofPos}`;
}

/** 每次成功添加平面后，尝试处理所有实体的挂起约束 */
function flushDeferred(state: EngineState): void {
  let progress = true;
  while (progress) {
    progress = false;
    for (const e of state.entities.values()) {
      if (e.dofPos <= 0 || e.deferred.length === 0) continue;
      const remaining: Constraint[] = [];
      for (const c of e.deferred) {
        const res = resolveConstraint(state, e.id, c);
        if ('plane' in res) {
          applyPlane(state, e, res.plane);
          progress = true;
        } else if ('defer' in res) {
          remaining.push(c);   // 仍无法解析，保留
        }
        // error 则丢弃（引用实体可能被删？实际不会）
      }
      e.deferred = remaining;
    }
  }
}

// ─── Engine ─────────────────────────────────────────────────────

export function createEngine(): EngineState {
  return { entities: new Map(), totalDOF: 0 };
}

export function execute(state: EngineState, op: Op): string {
  switch (op.op) {
    case 'declare': {
      if (state.entities.has(op.id)) return `warn: ${op.id} already declared`;
            const e: Entity = {
        id: op.id,
        type: op.type,
        dims: op.dims,
        material: op.material ?? 'default',
        planes: [],
        position: null,
        orient: null,
        dofPos: 3,
        deferred: [],
        log: [`declared(${op.type}, ${op.dims})`],
      };
      state.entities.set(op.id, e);
      state.totalDOF += 4; // 3 position + 1 orientation
      return `ok: declared ${op.id}, DOF=4`;
    }
    
    case 'meet': {
      const e = state.entities.get(op.entity);
      if (!e) return `error: entity ${op.entity} not found`;
      if (e.dofPos <= 0) return `skip: ${op.entity} position already resolved`;
      return applyPlane(state, e, op.plane as Plane);
    }

    case 'orient': {
      const e = state.entities.get(op.entity);
      if (!e) return `error: entity ${op.entity} not found`;
      if (e.orient !== null) return `skip: ${op.entity} orientation already set`;

      e.orient = op.angle;
      state.totalDOF--;
      e.log.push(`orient(${op.angle}°)`);
      return `ok: ${op.entity} orient=${op.angle}°`;
    }
    
    case 'constrain': {
      const e = state.entities.get(op.entity);
      if (!e) return `error: entity ${op.entity} not found`;
      if (e.dofPos <= 0) return `skip: ${op.entity} already resolved`;

      const result = resolveConstraint(state, op.entity, op.constraint);
      if ('error' in result) return `error: ${result.error}`;
      if ('defer' in result) {
        e.deferred.push(op.constraint);
        return `defer: ${op.entity} waiting on ${result.defer}`;
      }
      // 成功解析为平面 → 应用
      const msg = applyPlane(state, e, result.plane);
      // 应用后刷新所有待处理约束（可能解锁其他实体）
      flushDeferred(state);
      return msg;
    }

    default:
      return `error: unknown operation`;
  }
}

/** Execute a batch of operations, return logs */
export function executeBatch(state: EngineState, ops: Op[]): string[] {
  return ops.map(op => execute(state, op));
}

/** 深拷贝引擎状态，用于失败回滚 */
export function cloneEngine(s: EngineState): EngineState {
  const cloned: EngineState = { entities: new Map(), totalDOF: s.totalDOF };
  for (const [id, e] of s.entities) {
    cloned.entities.set(id, {
      id: e.id,
      type: e.type,
      dims: [...e.dims] as [number, number, number],
      material: e.material,
      planes: e.planes.map(p => [...p] as Plane),
      position: e.position ? [...e.position] as [number, number, number] : null,
      orient: e.orient,
      dofPos: e.dofPos,
      deferred: [...e.deferred],
      log: [...e.log],
    });
  }
  return cloned;
}

/** 将一个引擎的状态完整写入另一个引擎 */
export function commitInto(target: EngineState, source: EngineState): void {
  target.entities.clear();
  for (const [id, e] of source.entities) {
    target.entities.set(id, e);
  }
  target.totalDOF = source.totalDOF;
}

// ─── Queries (what the Agent reads as context) ───────────────────

/** Get face-plane of a resolved entity. Returns the plane equation. */
export function facePlane(e: Entity, face: string): Plane | null {
  if (!e.position) return null;
  const [x, y, z] = e.position;
  const [w, h, d] = e.dims;

  switch (face) {
    case 'east':   return P.x(x + w / 2);
    case 'west':   return P.x(x - w / 2);
    case 'north':  return P.z(z + d / 2);
    case 'south':  return P.z(z - d / 2);
    case 'top':    return P.y(y + h / 2);
    case 'bottom': return P.y(y - h / 2);
    default:       return null;
  }
}

/** Build context string for the Solver Agent */
export function buildContext(state: EngineState): string {
  const lines: string[] = ['== ENTITY STATES =='];

  for (const [id, e] of state.entities) {
    const status = e.position
      ? `RESOLVED pos=(${e.position.map(v => v.toFixed(2))}) orient=${e.orient ?? 'free'}`
      : `UNRESOLVED dof_pos=${e.dofPos} planes=${e.planes.length}`;

    lines.push(`${id}: type=${e.type} dims=(${e.dims}) ${status}`);

    if (e.position) {
      const [x, y, z] = e.position;
      const [w, h, d] = e.dims;
      lines.push(`  faces: east=${(x + w/2).toFixed(1)} west=${(x - w/2).toFixed(1)} ` +
        `north=${(z + d/2).toFixed(1)} south=${(z - d/2).toFixed(1)} ` +
        `top=${(y + h/2).toFixed(1)} bottom=${(y - h/2).toFixed(1)}`);
    }
  }

  lines.push(`\n== TOTAL DOF = ${state.totalDOF} ==`);
  return lines.join('\n');
}

/** Fill remaining DOF with defaults (last resort after all sentences processed) */
export function fillDefaults(state: EngineState): void {
  for (const [, e] of state.entities) {
    // Fill missing position planes
    while (e.dofPos > 0 && e.planes.length < 3) {
      if (e.planes.length === 0) {
        e.planes.push(P.y(e.dims[1] / 2)); // ground
      } else if (e.planes.length === 1) {
        e.planes.push(P.x(0)); // center x
      } else {
        e.planes.push(P.z(0)); // center z
      }
      e.dofPos--;
      state.totalDOF--;
      e.log.push('default_fill');
    }

    // Resolve position
    if (!e.position && e.planes.length >= 3) {
      e.position = meetPlanes(e.planes[0], e.planes[1], e.planes[2]);
    }

    // Default orientation
    if (e.orient === null) {
      e.orient = 0;
      state.totalDOF--;
    }
  }
}

/** Export solved entities for rendering */
export function solvedEntities(state: EngineState): Array<{
  id: string; type: string; material: string;
  position: [number, number, number];
  dims: [number, number, number];
  orient: number;
  log: string[];
}> {
  const result: Array<any> = [];
  for (const [, e] of state.entities) {
    if (e.position) {
      result.push({
        id: e.id, type: e.type, material: e.material,
        position: e.position, dims: e.dims,
        orient: e.orient ?? 0, log: e.log,
      });
    }
  }
  return result;
}
