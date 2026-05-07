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
}

export interface EngineState {
  entities: Map<string, Entity>;
  /** Total DOF across all entities */
  totalDOF: number;
}

// ─── Operations (the Agent's action space) ──────────────────────

export type Op =
  | { op: 'declare'; id: string; type: string; dims: [number, number, number]; material?: string }
  | { op: 'meet'; entity: string; plane: [number, number, number, number] }
  | { op: 'orient'; entity: string; angle: number };

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

      const plane: Plane = op.plane as Plane;

      // Check independence with existing planes
      for (const existing of e.planes) {
        if (!planesIndependent(existing, plane)) {
          return `skip: plane is parallel to existing constraint on ${op.entity}`;
        }
      }

      e.planes.push(plane);
      e.dofPos--;
      state.totalDOF--;
      e.log.push(`meet([${plane.map(v => v.toFixed(2))}]) → DOF_pos=${e.dofPos}`);

      // Try to resolve position if we have 3 planes
      if (e.planes.length >= 3 && !e.position) {
        const pos = meetPlanes(e.planes[0], e.planes[1], e.planes[2]);
        if (pos) {
          e.position = pos;
          e.log.push(`resolved → (${pos.map(v => v.toFixed(2))})`);
          return `ok: ${op.entity} position resolved at (${pos.map(v => v.toFixed(2))})`;
        }
      }

      return `ok: ${op.entity} DOF_pos=${e.dofPos}`;
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
  }
}

/** Execute a batch of operations, return logs */
export function executeBatch(state: EngineState, ops: Op[]): string[] {
  return ops.map(op => execute(state, op));
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
