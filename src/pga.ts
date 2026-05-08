/**
 * pga.ts — Plane intersection via Projective Geometric Algebra
 *
 * In Cl(3,0,1), a plane π = nx·e₁ + ny·e₂ + nz·e₃ + d·e₀
 * represents the locus  nx·x + ny·y + nz·z + d = 0.
 *
 * The meet (regressive product) of three independent planes
 * yields a point P (grade-3 trivector). We compute this
 * directly via Cramer's rule on the 3×3 coefficient matrix,
 * which is algebraically equivalent to the triple meet
 * P = π₁ ∧ π₂ ∧ π₃  but numerically more robust.
 *
 * (No changes from previous version — this file is already correct.)
 */

/** Plane: [nx, ny, nz, d] where nx·x + ny·y + nz·z + d = 0 */
export type Plane = [number, number, number, number];

/** Solve the triple-meet of three planes → point [x,y,z] or null if degenerate */
export function meetPlanes(p1: Plane, p2: Plane, p3: Plane): [number, number, number] | null {
  const [a1, b1, c1, d1] = p1;
  const [a2, b2, c2, d2] = p2;
  const [a3, b3, c3, d3] = p3;

  const det =
    a1 * (b2 * c3 - b3 * c2) -
    b1 * (a2 * c3 - a3 * c2) +
    c1 * (a2 * b3 - a3 * b2);

  if (Math.abs(det) < 1e-10) return null;

  const x = (
    -d1 * (b2 * c3 - b3 * c2) +
     b1 * (d2 * c3 - d3 * c2) -
     c1 * (d2 * b3 - d3 * b2)
  ) / det;

  const y = (
    -a1 * (d2 * c3 - d3 * c2) +
     d1 * (a2 * c3 - a3 * c2) -
     c1 * (a2 * d3 - a3 * d2)
  ) / det;

  const z = (
    -a1 * (b2 * d3 - b3 * d2) +
     b1 * (a2 * d3 - a3 * d2) -
     d1 * (a2 * b3 - a3 * b2)
  ) / det;

  return [x, y, z];
}

/** Check if two planes are independent (non-parallel) */
export function planesIndependent(a: Plane, b: Plane): boolean {
  const cross = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  return Math.abs(cross[0]) + Math.abs(cross[1]) + Math.abs(cross[2]) > 1e-10;
}

/** Common plane constructors */
export const P = {
  /** y = h → [0, 1, 0, -h] */
  y: (h: number): Plane => [0, 1, 0, -h],
  /** x = v → [1, 0, 0, -v] */
  x: (v: number): Plane => [1, 0, 0, -v],
  /** z = v → [0, 0, 1, -v] */
  z: (v: number): Plane => [0, 0, 1, -v],
  /** ground plane y=0 */
  floor: [0, 1, 0, 0] as Plane,
  /** arbitrary: nx*x + ny*y + nz*z + d = 0 */
  of: (nx: number, ny: number, nz: number, d: number): Plane => [nx, ny, nz, d],
};
