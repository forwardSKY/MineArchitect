/**
 * engine.ts — PGA State Machine (improved)
 *
 * Changes from previous version:
 *   - New constraints: at_x / at_y / at_z (entity CENTER at given coordinate).
 *     These avoid making the LLM hand-compute plane coefficients.
 *   - declare is now IDEMPOTENT for matching dims; mismatched re-declares warn but don't crash.
 *   - fillDefaults spreads unconstrained entities along x instead of stacking at origin.
 *   - Floating-point tolerant deduplication: identical plane (within 1e-6) is silently skipped.
 *   - Constraint resolver is more defensive about missing references.
 */

import { Plane, meetPlanes, planesIndependent, P } from './pga';

// ─── 约束 DSL ──────────────────────────────────────────────
export type Face = 'east' | 'west' | 'north' | 'south' | 'top' | 'bottom';

export type Constraint =
  | { kind: 'on_floor' }
  | { kind: 'at_height'; y: number }
  | { kind: 'at_x'; x: number }
  | { kind: 'at_y'; y: number }      // y is CENTER (not bottom)
  | { kind: 'at_z'; z: number }
  | { kind: 'against'; of: string; face: Face; gap?: number }
  | { kind: 'on_top_of'; of: string }
  | { kind: 'centered_in'; of: string; axis: 'x' | 'z' }
  | { kind: 'aligned_face'; of: string; face: Face }
  | { kind: 'offset_from'; of: string; axis: 'x' | 'y' | 'z'; delta: number }
  | { kind: 'plane'; coeffs: Plane };

// ─── 操作 ────────────────────────────────────────────────────
export type Op =
  | { op: 'declare'; id: string; type: string; dims: [number, number, number]; material?: string }
  | { op: 'meet'; entity: string; plane: Plane }
  | { op: 'constrain'; entity: string; constraint: Constraint }
  | { op: 'orient'; entity: string; angle: number };

// ─── 约束解析结果 ──────────────────────────────────────────────
type Resolved =
  | { plane: Plane }
  | { defer: string }
  | { error: string };

export interface Entity {
  id: string;
  type: string;
  dims: [number, number, number];
  material: string;
  planes: Plane[];
  position: [number, number, number] | null;
  orient: number | null;
  dofPos: number;
  log: string[];
  deferred: Constraint[];
}

export interface EngineState {
  entities: Map<string, Entity>;
  totalDOF: number;
}

/** 将符号约束解析为具体平面，依赖未就绪则 defer */
function resolveConstraint(
  state: EngineState,
  entityId: string,
  constraint: Constraint
): Resolved {
  const e = state.entities.get(entityId);
  if (!e) return { error: `entity ${entityId} not found` };

  const needRef = (id: string): { ref: Entity } | { defer: string } | { error: string } => {
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

    case 'at_x':
      return { plane: P.x(constraint.x) };

    case 'at_y':
      return { plane: P.y(constraint.y) };

    case 'at_z':
      return { plane: P.z(constraint.z) };

    case 'against': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error };
      if ('defer' in needed) return { defer: needed.defer };
      const { ref } = needed;
      const [rx, ry, rz] = ref.position!;
      const [rw, rh, rd] = ref.dims;
      const [ew, eh, ed] = e.dims;
      const g = constraint.gap ?? 0;
      switch (constraint.face) {
        case 'east':   return { plane: P.x(rx + rw / 2 - ew / 2 - g) };
        case 'west':   return { plane: P.x(rx - rw / 2 + ew / 2 + g) };
        case 'north':  return { plane: P.z(rz + rd / 2 - ed / 2 - g) };
        case 'south':  return { plane: P.z(rz - rd / 2 + ed / 2 + g) };
        case 'top':    return { plane: P.y(ry + rh / 2 + eh / 2 + g) };
        case 'bottom': return { plane: P.y(ry - rh / 2 - eh / 2 - g) };
      }
      return { error: `unknown face ${constraint.face}` };
    }

    case 'on_top_of': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error };
      if ('defer' in needed) return { defer: needed.defer };
      const { ref } = needed;
      const top = ref.position![1] + ref.dims[1] / 2;
      return { plane: P.y(top + e.dims[1] / 2) };
    }

    case 'centered_in': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error };
      if ('defer' in needed) return { defer: needed.defer };
      const { ref } = needed;
      const idx = constraint.axis === 'x' ? 0 : 2;
      const make = constraint.axis === 'x' ? P.x : P.z;
      return { plane: make(ref.position![idx]) };
    }

    case 'aligned_face': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error };
      if ('defer' in needed) return { defer: needed.defer };
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
      return { error: `unknown face ${constraint.face}` };
    }

    case 'offset_from': {
      const needed = needRef(constraint.of);
      if ('error' in needed) return { error: needed.error };
      if ('defer' in needed) return { defer: needed.defer };
      const { ref } = needed;
      const idx = constraint.axis === 'x' ? 0 : constraint.axis === 'y' ? 1 : 2;
      const make = constraint.axis === 'x' ? P.x : constraint.axis === 'y' ? P.y : P.z;
      return { plane: make(ref.position![idx] + constraint.delta) };
    }

    case 'plane':
      return { plane: constraint.coeffs };
  }
}

/** Apply a plane to an entity (independence check, DOF--, attempt resolve) */
function applyPlane(state: EngineState, entity: Entity, plane: Plane): string {
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

/** Each successful plane addition may unlock dependent constraints */
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
          remaining.push(c);
        }
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
      const existing = state.entities.get(op.id);
      if (existing) {
        // 幂等：完全相同的声明静默通过，否则警告但不抛错
        const sameDims = existing.dims.every((v, i) => Math.abs(v - op.dims[i]) < 1e-6);
        if (sameDims) return `ok: ${op.id} already declared (idempotent)`;
        return `warn: ${op.id} re-declared with different dims (kept original)`;
      }
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
      state.totalDOF += 4;
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
      const msg = applyPlane(state, e, result.plane);
      flushDeferred(state);
      return msg;
    }

    default:
      return `error: unknown operation`;
  }
}

export function executeBatch(state: EngineState, ops: Op[]): string[] {
  return ops.map(op => execute(state, op));
}

/** Deep clone for trial-and-rollback */
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

export function commitInto(target: EngineState, source: EngineState): void {
  target.entities.clear();
  for (const [id, e] of source.entities) {
    target.entities.set(id, e);
  }
  target.totalDOF = source.totalDOF;
}

// ─── Queries ───────────────────────────────────────────────────

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
      lines.push(`  faces: east=${(x + w / 2).toFixed(1)} west=${(x - w / 2).toFixed(1)} ` +
        `north=${(z + d / 2).toFixed(1)} south=${(z - d / 2).toFixed(1)} ` +
        `top=${(y + h / 2).toFixed(1)} bottom=${(y - h / 2).toFixed(1)}`);
    }
  }
  lines.push(`\n== TOTAL DOF = ${state.totalDOF} ==`);
  return lines.join('\n');
}

/**
 * Fill remaining DOF with reasonable defaults.
 *
 * Improvements:
 *   - Unconstrained entities are spread along x instead of stacked at origin.
 *   - Spread stride scales with the largest dim seen (so big rooms don't overlap).
 */
export function fillDefaults(state: EngineState): void {
  // Compute spread stride from largest entity dim
  let maxDim = 2;
  for (const [, e] of state.entities) {
    maxDim = Math.max(maxDim, e.dims[0], e.dims[2]);
  }
  const stride = maxDim + 1.5;

  let unconstrainedIdx = 0;
  for (const [, e] of state.entities) {
    const startedUnconstrained = e.planes.length === 0;

    while (e.dofPos > 0 && e.planes.length < 3) {
      if (e.planes.length === 0) {
        e.planes.push(P.y(e.dims[1] / 2));               // ground
      } else if (e.planes.length === 1) {
        const offsetX = startedUnconstrained
          ? (unconstrainedIdx - 0.5) * stride            // spread in x
          : 0;
        e.planes.push(P.x(offsetX));
      } else {
        e.planes.push(P.z(0));                           // center z
      }
      e.dofPos--;
      state.totalDOF--;
      e.log.push('default_fill');
    }
    if (startedUnconstrained) unconstrainedIdx++;

    if (!e.position && e.planes.length >= 3) {
      e.position = meetPlanes(e.planes[0], e.planes[1], e.planes[2]);
    }

    if (e.orient === null) {
      e.orient = 0;
      state.totalDOF--;
    }
  }
}

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
