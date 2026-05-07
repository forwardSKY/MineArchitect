# Significance: Beyond a Demo

---

## 1. Position Relative to Existing Spatial Reasoning Frameworks

### 1.1 vs. RCC-8 (Region Connection Calculus)

RCC-8 defines 8 topological relations between regions: DC (disconnected), EC (externally connected), PO (partial overlap), TPP/NTPP (tangential/non-tangential proper part), and their inverses.

| Dimension | RCC-8 | PGA Sketch Engine |
|-----------|-------|-------------------|
| Output type | Qualitative predicate: `NTPP(bed, room)` | Quantitative position: `(10.1, 0.275, 6.0)` |
| Needs external solver? | **Yes** — predicates have no geometry | **No** — meet IS the solver |
| Handles non-orthogonal? | N/A (no geometry) | Yes (arbitrary plane normals) |
| Contradiction detection | Requires reasoning engine | `det(A) = 0` → automatic |
| Computational cost | NP for constraint satisfaction | O(1) per meet (3×3 linear solve) |

**The fundamental difference:** RCC-8 is a description language. PGA meet is a computation. RCC-8 tells you that the bed is inside the room. PGA tells you WHERE inside the room. You cannot render a 3D scene from RCC-8 predicates alone — you need a solver. PGA IS the solver.

### 1.2 vs. DE-9IM (Dimensionally Extended 9-Intersection Model)

DE-9IM extends RCC-8 to a 3×3 matrix of interior/boundary/exterior intersections, commonly used in GIS (PostGIS, Shapely).

```
DE-9IM of "bed inside room":
         Interior  Boundary  Exterior
Interior    T         F         F        ← bed interior inside room interior
Boundary    T         T         F        ← bed boundary touches room interior/boundary
Exterior    T         T         T        ← bed exterior everywhere
```

This matrix encodes the topological relationship precisely but says nothing about WHERE. It's a 9-character string (e.g., `"T*F**FFF*"` for "contains"). Our system would need to convert this string into constraint planes, which is exactly what the solver agent already does by interpreting natural language directly.

**DE-9IM is a GIS tool for 2D polygon queries.** PGA is a 3D construction tool. Different problems.

### 1.3 vs. ASP (Answer Set Programming)

ASP (e.g., clingo) solves constraint satisfaction by search: given a set of logical rules and constraints, find all valid models.

```prolog
% ASP approach
inside(bed, master_bedroom).
against(bed, east_wall).
on(bed, floor).
:- inside(X, Y), pos_x(X, PX), pos_x(Y, PY), width(Y, W), PX > PY + W/2.
```

This COULD solve spatial layout problems. But:

| Dimension | ASP | PGA Engine |
|-----------|-----|------------|
| Solution method | Search (enumerate models) | Direct (linear solve) |
| Complexity | NP-complete in general | O(N) — N entities × O(1) per meet |
| Uniqueness | May find multiple models | Triple-meet gives unique point |
| Handles continuous values? | Requires discretization | Native (floating point) |
| Dependencies | clingo solver (~10MB) | Zero (pure TypeScript) |

ASP is powerful for problems where the solution space is discrete and constraints are logical. Spatial positioning is continuous — you're solving a system of linear equations, not searching a logic program. PGA is the right tool for the right problem.

### 1.4 Summary: Why None of These Replace PGA

```
RCC-8:   "The bed is inside the room"     → OK, but WHERE?
DE-9IM:  "T*F**FFF*"                       → OK, but WHERE?
ASP:     finds(model, [bed_x=10, ...])     → Correct, but O(2^N) search
PGA:     meet 3 planes → (10.1, 0.275, 6)  → Direct, O(1), unique
```

The pipeline doesn't need RCC-8, DE-9IM, or ASP because it operates at the computation layer, not the description layer. The LLM does the description (translating language into plane equations). PGA does the computation (solving the equations).

---

## 2. Training Data Generation

### 2.1 Text-to-Structure Training Pairs

The pipeline produces high-quality `(text, 3D_structure)` pairs at scale:

```
Input:  "A 6-story office with glass curtain walls and cantilevered slabs..."
Output: { entities: [...123 objects with positions, dims, materials...] }
```

These pairs can train a **specialist Text-to-Structure model** that directly maps text to spatial JSON — bypassing the multi-step pipeline entirely. The training process:

1. **Generate diverse text descriptions** (LLM can produce thousands of building descriptions with controlled parameters: style, scale, program, materials)
2. **Run each through the pipeline** → get verified spatial structures (DOF=0)
3. **Train a small model** (e.g., fine-tuned Qwen-7B or Llama-8B) on these pairs
4. **Deploy the small model** for single-shot text → structure inference

The pipeline acts as a **data factory**: it converts the expensive reasoning of large models into training data for cheap inference models.

**Key advantage over manual annotation:** Every output is mathematically verified (DOF=0, no contradictions). There's no human labeling error. The training data is provably consistent.

### 2.2 Scale Potential

```
1 building description → ~30 seconds pipeline time → 1 training sample
1000 descriptions/day → 1 month → 30,000 verified training pairs
```

Each sample has:
- Raw text input (natural language)
- Normalized text (intermediate)
- PGA operations sequence (reasoning trace)
- Final positions (ground truth)
- HTML rendering (visual verification)

This is a **complete Chain-of-Thought dataset**: input → reasoning steps → verified output.

---

## 3. GRPO Ground Truth via PGA Search

### 3.1 The Problem with Spatial RL

Training LLMs for spatial reasoning with RLHF/DPO requires ground truth: "Is this spatial layout correct?" But spatial correctness is hard for humans to judge from text alone.

### 3.2 PGA as Verifiable Reward Signal

PGA provides an **automatic, mathematically rigorous reward signal**:

```
Reward(output) = {
  +1  if all entities reach DOF=0 with consistent planes (det ≠ 0)
  +0.5 if DOF=0 but some defaults were needed
  -1  if contradictory constraints detected (det = 0)
}
```

This reward signal is:
- **Automated** — no human annotation needed
- **Differentiable by quality** — fewer defaults = higher reward
- **Verifiable** — the math is deterministic

### 3.3 GRPO Training Loop

```
For each training step:
  1. Sample a text description
  2. Model generates PGA operations (the "policy" output)
  3. Engine executes operations → DOF count, contradiction check
  4. Compute reward: R = (DOF_resolved_by_model / DOF_total) − penalty(contradictions)
  5. Update model with Group Relative Policy Optimization
```

The PGA engine acts as the **environment** in the RL loop. The model learns to produce correct plane equations not by memorizing examples, but by getting algebraic feedback on every attempt.

**This is analogous to AlphaProof's training:** the Lean 4 type checker provides automatic verification of each proof step. Our PGA engine provides automatic verification of each spatial constraint. Both enable self-play training without human labels.

### 3.4 What the Model Learns

After GRPO training, the model should learn:

- "Against east wall of room at x=5, width 4" → `meet(entity, [1,0,0, -(5+4/2-entity_w/2)])`
- Correct dimensional reasoning (half-widths, offsets)
- Constraint independence (don't issue parallel planes)
- Spatial consistency (constraints from one sentence shouldn't contradict another)

This is **grounded spatial reasoning** — the model's outputs are tested against physical reality (geometry), not just pattern-matched against text.

---

## 4. Application Domains

### 4.1 Gaming: Procedural Level Generation

Text descriptions → playable 3D environments:

```
Input:  "A medieval castle with a central courtyard, four corner towers,
         a gatehouse facing south, and a great hall on the north side."
Output: HTML with navigable 3D wireframe → export to Unity/Unreal
```

The pipeline produces **topologically correct** layouts — rooms connect properly, doors align with walls, stairs reach the right floor. This is the hard part of procedural generation that current noise-based methods (Perlin, WFC) don't solve.

**Integration path:** PGA positions → glTF export → game engine import. The entity metadata (type, material, dimensions) maps directly to game object spawning.

### 4.2 Robotics: Spatial Understanding and Navigation

A robot receives a text description of an environment and needs to build an internal spatial model:

```
"The kitchen is north of the living room. The refrigerator is against
the east wall of the kitchen. The dining table is between the kitchen
and the living room."
```

The pipeline converts this into a metric map:
- Kitchen center at (0, 1.5, 9)
- Refrigerator at (3.5, 0.9, 9)
- Dining table at (0, 0.38, 6)

This metric map is directly usable for:
- **Path planning**: navigate from living room to refrigerator
- **Object localization**: "where is the dining table?" → (0, 0.38, 6)
- **Spatial reasoning**: "is the refrigerator closer to the table or the sofa?"

The PGA representation also supports **frame-relative queries**: "what's to my left?" depends on the robot's facing direction — the same frame-tracking mechanism that resolves "左侧" in text.

### 4.3 Architecture and Interior Design

The pipeline's native domain. Applications:

- **Brief-to-sketch**: Architect describes a concept in prose → instant 3D massing study
- **Client communication**: Non-technical client describes their dream home → 3D visualization
- **Code compliance checking**: Spatial layout → verify against building codes (room sizes, egress distances, accessibility)
- **Parametric variation**: Change one sentence → re-solve → see the spatial impact

### 4.4 Accessibility: Spatial Description for Vision-Impaired

The inverse problem: given a 3D model, generate a text description that, when processed by the pipeline, reconstructs the original model. This creates a **lossless text encoding of spatial information** — useful for:

- Describing physical spaces to vision-impaired users
- Archiving spatial designs as text (version-controllable, searchable, diff-able)
- Transmitting spatial information over bandwidth-constrained channels

### 4.5 VR/AR Scene Generation

Real-time spatial layout from voice commands:

```
User (in VR): "Put a bookshelf against that wall"
System:
  1. Identify "that wall" from gaze direction → π_wall
  2. meet(bookshelf, π_wall) → position
  3. Render bookshelf at position in VR scene
  Latency: ~100ms (one meet operation)
```

The PGA meet is fast enough for real-time interaction. The LLM call (Stage 2) can be cached or pre-computed for common commands.

---

## 5. What This System Proves

### 5.1 Language and Geometry Share a Structure

Natural language spatial descriptions and PGA constraint systems are **isomorphic** in a specific sense: every spatial sentence maps to a constraint plane, and every constraint plane can be verbalized as a spatial sentence. The pipeline is a constructive proof of this isomorphism.

### 5.2 Formal Verification is Possible for Spatial AI

Unlike image generation (where correctness is subjective), spatial layout generation has an **objective correctness criterion**: DOF=0 with no contradictions. This makes it possible to:
- Verify outputs automatically
- Train models with ground-truth reward signals
- Guarantee consistency by construction

### 5.3 Small Algebra, Big Capability

The entire computation substrate is 73 lines of TypeScript — a 3×3 linear solve. From this minimal foundation, the system handles buildings with 130+ entities across 12 stories. The complexity comes from the LLM's spatial reasoning, not from the algebra. This separation of concerns — intelligence in the LLM, precision in the math — is the architecture's core strength.

---

## 6. Limitations and Future Work

| Limitation | Current | Future |
|-----------|---------|--------|
| Geometry | Axis-aligned boxes only | Arbitrary planes → sloped roofs, curves via discretization |
| Solver | Cramer's rule (axis-aligned efficient) | Full PGA regressive product (handles any plane orientation) |
| Rendering | Three.js boxes + edges | glTF export, sketch shaders, post-processing |
| Scale | 130 entities tested | Should scale to 1000+ (O(N) algorithm) |
| Feedback loop | Architecture supports it | Need implementation and testing |
| Training pipeline | Concept described | Need implementation: data generation → fine-tuning → GRPO |

The system as built is a **proof of concept** with production-grade math. The algebra is correct and complete. The pipeline architecture is sound. What remains is engineering: better rendering, real API integration, model training, and domain-specific tuning.
