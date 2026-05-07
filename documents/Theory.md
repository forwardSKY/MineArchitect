# Theory: Bayesian Spatial Inference via Projective Geometric Algebra

---

## 1. The Problem as Bayesian Inference

A 3D scene **S** is a vector in ℝ⁴ᴺ (N entities × 4 DOF). A text **T** is a sequence of sentences. The task is to compute the posterior:

```
P(S | T) ∝ P(T | S) · P(S)
```

Direct computation is intractable. The pipeline decomposes it into sequential updates.

### 1.1 Sequential Bayesian Update

Each sentence tᵢ provides partial evidence. We update belief sentence by sentence:

```
P(S | t₁...tₙ) ∝ ∏ᵢ P(tᵢ | S) · P(S)
```

In our system:

- **Likelihood P(tᵢ | S):** The sentence "bed against east wall" has high likelihood when the bed's x-coordinate equals (east_wall_x − bed_width/2). The solver agent extracts this as a constraint plane `[1, 0, 0, -10.1]`. Meet with this plane restricts the posterior to the surface x = 10.1.

- **Prior P(S):** Decomposes into three layers:
  - **World prior:** gravity (y ≥ 0), vertical walls (rx = rz = 0)
  - **Type prior:** beds are ~1.8×2.1m, counters are ~0.9m tall
  - **Spatial prior:** objects don't overlap, rooms tile

- **Posterior collapse:** After 3 independent plane constraints, the positional posterior collapses from a volume to a surface (1 plane) to a line (2 planes) to a **point** (3 planes). This is the PGA triple-meet.

### 1.2 Information Budget

```
Total DOF to determine:           4N
World priors provide:             ~1N   (gravity, verticality)
Type priors provide:              ~0.5N (default dimensions)
Text must provide:                ≥2.5N constraints

For apartment (N=21):  need ≥53,  text provides 65  → sufficient
For office (N=123):    need ≥308, text provides 369 → sufficient
```

When text provides fewer constraints than needed, residual DOF is filled by:
1. **Feedback loop** (preferred): Send remaining DOF back to LLM for common-sense reasoning
2. **Defaults** (fallback): Center unconstrained axes in parent volume

### 1.3 Why Sequential Processing Works

Natural language describes space in **observer-walk order**: you describe what you see as you move through the space. This order has a mathematical property — each sentence references only entities mentioned before (weak topological sort).

Therefore: `P(S | t₁...tᵢ₊₁) = update(P(S | t₁...tᵢ), tᵢ₊₁)` — each step only requires the previous posterior, not a global solve. This justifies the sequential agent loop.

---

## 2. Projective Geometric Algebra as Computation Substrate

### 2.1 Why Projective, Not Euclidean

In Euclidean geometry, parallel lines don't intersect. In Projective geometry (Cl(3,0,1)), they meet at an **ideal point** — a direction without position. This matters because:

- **Sunlight** is an ideal point: direction (0, −1, 0) with no finite position
- **Vanishing points** in architectural perspective are ideal points
- **Pure translation** is rotation about an ideal line (the line at infinity)

The degenerate basis element e₀ (with e₀² = 0) encodes "infinity" as a first-class object. This unification means the algebra handles both finite objects (rooms, furniture) and infinite constructions (directions, parallel lines) in the same framework.

### 2.2 The Meet Operation as Constraint

A plane in PGA is a grade-1 multivector:

```
π = nx·e₁ + ny·e₂ + nz·e₃ + d·e₀
```

The **meet** (regressive product) of three planes:

```
P = π₁ ∧ π₂ ∧ π₃
```

yields a grade-3 trivector encoding the intersection point. Coordinates are extracted:

```
x = −P[e₀₂₃] / P[e₁₂₃]
y =  P[e₀₁₃] / P[e₁₂₃]
z = −P[e₀₁₂] / P[e₁₂₃]
```

We compute this via Cramer's rule on the 3×3 coefficient matrix — algebraically equivalent to the triple meet, numerically more robust.

### 2.3 Semantic Projection

When the agent reads "bed against east wall" and outputs `meet(bed, [1,0,0,-10.1])`, it performs a **semantic projection**: the linguistic meaning of spatial language is projected into a geometric constraint plane. Each constraint plane is a hyperplane in the configuration space ℝ⁴ᴺ that eliminates one degree of freedom.

The projection is lossy — one sentence may imply multiple constraints, or the mapping may be ambiguous. But each constraint that IS correctly extracted **monotonically reduces uncertainty**. The posterior can only shrink, never grow.

### 2.4 Completeness Theorem

**Theorem:** If every entity receives 3 independent constraint planes, its position is uniquely determined.

**Proof:** Three independent planes have linearly independent normals. The coefficient matrix has rank 3. By rank-nullity, the solution space is zero-dimensional — a unique point. ∎

**Corollary:** The system is complete (DOF=0) when every entity has ≥3 positional constraints and 1 orientation constraint.

---

## 3. System 1 / System 2 Architecture

The pipeline maps directly onto Kahneman's dual-process framework:

### 3.1 System 1: Stage 1 (Preprocessor)

- **Fast, intuitive, holistic**
- Reads the entire text, understands the overall spatial layout
- Resolves ambiguity using linguistic intuition ("左侧" → "west" when facing north)
- Makes implicit entities explicit (morning light → east window)
- Strips rhetoric, keeps spatial facts
- **One pass, one call, global understanding**

This is the "intuitive grasp" of the spatial description. It doesn't compute coordinates — it translates language into a normalized form that System 2 can process.

### 3.2 System 2: Stage 2 (Solver Agent)

- **Slow, deliberate, sequential**
- Processes one sentence at a time
- Reads the current entity states (what's already solved)
- Computes specific numerical plane coefficients
- Executes PGA operations and verifies DOF reduction
- **Multi-step, verified, each step builds on the last**

This is the "careful calculation" phase. Each step has a well-defined input (context + sentence), a well-defined output (PGA operations), and a verifiable result (DOF decreased or error detected).

### 3.3 Why Both Are Needed

System 1 alone (single-shot JSON generation) is fragile — large structured outputs have high error rates, and there's no feedback mechanism to catch mistakes.

System 2 alone (raw text → per-sentence solving) struggles with ambiguity — "左侧" requires knowing the observer's facing direction, which requires global text understanding.

Together: System 1 provides the global understanding, System 2 provides the precise execution. The normalized text is the **interface** between them.

---

## 4. The AlphaProof Analogy

The pipeline mirrors the architecture of DeepMind's AlphaProof (IMO 2024):

### 4.1 Stage 1 = Autoformalization

In AlphaProof: Natural language math problem → Lean 4 formal statement

In our system: Natural language spatial description → Normalized spatial sentences

Both perform the same function: translating informal human language into a form that a formal reasoning engine can process. Neither stage solves the problem — it merely restates it.

### 4.2 Stage 2 = Formal Search / Proof

In AlphaProof: Lean 4 statement → proof search (guided by a learned value function)

In our system: Normalized sentence → PGA operation selection (guided by LLM spatial reasoning)

Both systems search for the correct sequence of formal operations to satisfy constraints. In AlphaProof, the constraint is "prove the theorem." In our system, the constraint is "reduce DOF to zero."

### 4.3 Verification = Type Checking

In AlphaProof: Lean 4's type checker verifies each proof step.

In our system: The PGA engine verifies each meet operation:
- Are the planes independent? (If not, skip — no DOF reduction)
- Do 3 planes intersect? (If not, det=0 → contradictory constraints)
- Is the resulting position finite? (If w-component ≈ 0 → ideal point → error)

Both systems have a **formal verification layer** that catches errors immediately, rather than accumulating them across steps.

### 4.4 The Key Shared Insight

> The hardest part is not the reasoning — it's the translation.

AlphaProof spends most of its compute on autoformalization (getting the Lean 4 statement right), not on proof search. Similarly, our system's quality depends primarily on Stage 1 (getting the normalized text right), not on Stage 2 (the PGA operations are deterministic once the planes are specified).

This is why Stage 1 uses the strongest model and Stage 2 can use any model — the translation requires intelligence, the execution requires only precision.

---

## 5. Convergence as Fixed-Point Iteration

The feedback loop (Stage 2 → remaining DOF → Stage 1 → Stage 2) is a fixed-point iteration:

```
S₀ = prior
Sₖ₊₁ = update(Sₖ, new_constraints_from_LLM(Sₖ))
```

**Convergence proof:**
- DOF(Sₖ) ∈ {0, 1, 2, ..., 4N} — integer-valued
- Each round: DOF(Sₖ₊₁) ≤ DOF(Sₖ) — monotonically non-increasing (new constraints only reduce DOF)
- Lower bound: DOF ≥ 0
- Therefore: the sequence converges in at most 4N rounds

In practice, convergence is much faster — typically 1-2 rounds (the first pass resolves ~75% of DOF, the second resolves most of the rest).

The feedback loop transforms "filling gaps with blind defaults" into "filling gaps with informed common-sense reasoning" — same convergence guarantee, much higher spatial accuracy.
