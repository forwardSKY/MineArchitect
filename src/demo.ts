/**
 * demo.ts — End-to-End Demo
 *
 * Runs the pipeline with pre-computed operations (simulating LLM responses)
 * to demonstrate PGA constraint solving on the apartment text.
 *
 * Usage: npx ts-node src/demo.ts
 */

import { Op } from './engine';
import { runDirect, PipelineResult } from './pipeline';
import { writeFileSync } from 'fs';

// ═══════════════════════════════════════════════════════════════════
// TEST CASE 1: Apartment (from the original Chinese text)
//
// Original: "推开家门，玄关的柔和木质香味先迎了上来..."
//
// This is what Stage 1 (preprocessor) would produce.
// Each sentence is one spatial fact, all directions absolute.
// ═══════════════════════════════════════════════════════════════════

const APARTMENT_SENTENCES = [
  '[enter from south, facing north]',
  'Entrance corridor at origin, 2m wide, 2.8m tall, 3m deep, wood material.',
  'Shoe cabinet on west wall of entrance, suspended 0.3m above floor.',
  '[advance 3m north]',
  'Large living and dining room north of entrance, 8m wide, 3m tall, 8m deep, oak floor.',
  'Full-height window on south wall of living_room, glass.',
  'Island counter centered in living_room, dark stone material.',
  'Kitchen north of island, 4m wide, 3m tall, 3m deep, open to living_room.',
  'Two bar stools east of island counter.',
  '[turn east]',
  'Short corridor east of living_room, 4m long east-west, 1.5m wide.',
  'Master bedroom at east end of corridor, 4m wide, 2.8m tall, 4.5m deep, south-facing.',
  'Bay window on south wall of master_bedroom, glass.',
  'Bed against east wall of master_bedroom, headboard east.',
  'Small window on east wall of master_bedroom (implied by morning light).',
  'Walk-in closet north of bed in master_bedroom, gray sliding door.',
  'Bathroom adjacent to walk-in closet, warm tile.',
  '[return to corridor, face north]',
  'L-shaped counter against north wall of kitchen, stone.',
  'Refrigerator embedded in L-counter, steel.',
  'Pendant light above island counter, metal.',
  'Sofa against west wall of living_room, facing east.',
  'Dining table between sofa and island in living_room, wood.',
];

// ═══════════════════════════════════════════════════════════════════
// Pre-computed Solver Agent operations for each sentence.
//
// This is what Stage 2 (solver agent) would produce.
// Each entry: the agent reads context + sentence → outputs PGA ops.
//
// EVERY position is determined by 3 constraint planes via PGA meet.
// The plane values are computed from the spatial relationships described.
//
// Plane [nx,ny,nz,d]: point on plane iff nx*x + ny*y + nz*z + d = 0
// Example: floor y=0 → [0,1,0,0], center at y=1.4 → [0,1,0,-1.4]
// ═══════════════════════════════════════════════════════════════════

const APARTMENT_OPS: Op[][] = [
  // 0: "[enter from south, facing north]"
  [],

  // 1: "Entrance corridor at origin..."
  // Agent reasons: at origin → x=0, z=0. Ground → y=h/2=1.4. Center z = depth/2 = 1.5.
  [
    { op: 'declare', id: 'entrance', type: 'corridor', dims: [2, 2.8, 3], material: 'wood' },
    { op: 'meet', entity: 'entrance', plane: [0, 1, 0, -1.4] },   // y = h/2
    { op: 'meet', entity: 'entrance', plane: [1, 0, 0, 0] },       // x = 0
    { op: 'meet', entity: 'entrance', plane: [0, 0, 1, -1.5] },    // z = d/2
  ],

  // 2: "Shoe cabinet on west wall of entrance, suspended 0.3m"
  // Agent reads: entrance west face at x = 0 - 2/2 = -1
  // Cabinet depth=0.35 → center x = -1 + 0.35/2 = -0.825
  // Suspended 0.3m → center y = 0.3 + 0.7/2 = 0.65
  // Same z as entrance center = 1.5
  [
    { op: 'declare', id: 'shoe_cabinet', type: 'shoe_cabinet', dims: [1, 0.7, 0.35], material: 'wood' },
    { op: 'meet', entity: 'shoe_cabinet', plane: [0, 1, 0, -0.65] },
    { op: 'meet', entity: 'shoe_cabinet', plane: [1, 0, 0, 0.825] },
    { op: 'meet', entity: 'shoe_cabinet', plane: [0, 0, 1, -1.5] },
  ],

  // 3: "[advance 3m north]" — frame update only
  [],

  // 4: "Large living/dining room north of entrance"
  // Entrance north face at z = 1.5 + 3/2 = 3
  // Living center z = 3 + 8/2 = 7, center x = -1 (slightly west for asymmetric plan)
  [
    { op: 'declare', id: 'living_room', type: 'living_room', dims: [8, 3, 8], material: 'oak' },
    { op: 'meet', entity: 'living_room', plane: [0, 1, 0, -1.5] },  // y = 1.5
    { op: 'meet', entity: 'living_room', plane: [1, 0, 0, 1] },      // x = -1
    { op: 'meet', entity: 'living_room', plane: [0, 0, 1, -7] },     // z = 7
  ],

  // 5: "Full-height window on south wall of living_room"
  // Living south at z = 7 - 4 = 3
  [
    { op: 'declare', id: 'south_window', type: 'floor_window', dims: [5, 2.6, 0.08], material: 'glass' },
    { op: 'meet', entity: 'south_window', plane: [0, 1, 0, -1.3] },
    { op: 'meet', entity: 'south_window', plane: [1, 0, 0, 1] },
    { op: 'meet', entity: 'south_window', plane: [0, 0, 1, -3] },
  ],

  // 6: "Island counter centered in living_room"
  [
    { op: 'declare', id: 'island', type: 'island_counter', dims: [2.2, 0.9, 1], material: 'stone' },
    { op: 'meet', entity: 'island', plane: [0, 1, 0, -0.45] },
    { op: 'meet', entity: 'island', plane: [1, 0, 0, 1] },        // x = -1 (living center)
    { op: 'meet', entity: 'island', plane: [0, 0, 1, -7] },       // z = 7 (living center)
  ],

  // 7: "Kitchen north of island"
  // Island north at z = 7 + 0.5 = 7.5 → kitchen center z = 7.5 + 1.5 = 9
  [
    { op: 'declare', id: 'kitchen', type: 'kitchen', dims: [4, 3, 3], material: 'default' },
    { op: 'meet', entity: 'kitchen', plane: [0, 1, 0, -1.5] },
    { op: 'meet', entity: 'kitchen', plane: [1, 0, 0, 1] },
    { op: 'meet', entity: 'kitchen', plane: [0, 0, 1, -9.5] },
  ],

  // 8: "Two bar stools east of island"
  // Island east face at x = -1 + 1.1 = 0.1, stool center x ≈ 0.5
  [
    { op: 'declare', id: 'stool_1', type: 'bar_stool', dims: [0.38, 0.75, 0.38], material: 'wood' },
    { op: 'meet', entity: 'stool_1', plane: [0, 1, 0, -0.375] },
    { op: 'meet', entity: 'stool_1', plane: [1, 0, 0, -0.5] },
    { op: 'meet', entity: 'stool_1', plane: [0, 0, 1, -6.7] },
    { op: 'declare', id: 'stool_2', type: 'bar_stool', dims: [0.38, 0.75, 0.38], material: 'wood' },
    { op: 'meet', entity: 'stool_2', plane: [0, 1, 0, -0.375] },
    { op: 'meet', entity: 'stool_2', plane: [1, 0, 0, -0.5] },
    { op: 'meet', entity: 'stool_2', plane: [0, 0, 1, -7.3] },
  ],

  // 9: "[turn east]"
  [],

  // 10: "Short corridor east of living_room"
  // Living east at x = -1 + 4 = 3 → corridor center x = 3 + 2 = 5
  [
    { op: 'declare', id: 'corridor', type: 'corridor', dims: [4, 2.8, 1.5], material: 'default' },
    { op: 'meet', entity: 'corridor', plane: [0, 1, 0, -1.4] },
    { op: 'meet', entity: 'corridor', plane: [1, 0, 0, -5] },
    { op: 'meet', entity: 'corridor', plane: [0, 0, 1, -6.5] },
  ],

  // 11: "Master bedroom at east end of corridor"
  // Corridor east at x = 5 + 2 = 7 → bedroom center x = 7 + 2 = 9
  [
    { op: 'declare', id: 'master_bedroom', type: 'bedroom', dims: [4, 2.8, 4.5], material: 'oak' },
    { op: 'meet', entity: 'master_bedroom', plane: [0, 1, 0, -1.4] },
    { op: 'meet', entity: 'master_bedroom', plane: [1, 0, 0, -9] },
    { op: 'meet', entity: 'master_bedroom', plane: [0, 0, 1, -6] },
  ],

  // 12: "Bay window on south wall of master_bedroom"
  // Bedroom south at z = 6 - 2.25 = 3.75
  [
    { op: 'declare', id: 'bay_window', type: 'bay_window', dims: [2, 2.6, 0.5], material: 'glass' },
    { op: 'meet', entity: 'bay_window', plane: [0, 1, 0, -1.3] },
    { op: 'meet', entity: 'bay_window', plane: [1, 0, 0, -9] },
    { op: 'meet', entity: 'bay_window', plane: [0, 0, 1, -3.75] },
  ],

  // 13: "Bed against east wall of master_bedroom"
  // Bedroom east at x = 9 + 2 = 11 → bed center x = 11 - 0.9 = 10.1
  [
    { op: 'declare', id: 'bed', type: 'bed', dims: [1.8, 0.55, 2.1], material: 'fabric' },
    { op: 'meet', entity: 'bed', plane: [0, 1, 0, -0.275] },
    { op: 'meet', entity: 'bed', plane: [1, 0, 0, -10.1] },
    { op: 'meet', entity: 'bed', plane: [0, 0, 1, -6] },
    { op: 'orient', entity: 'bed', angle: -90 },
  ],

  // 14: "Small window on east wall (morning light)"
  // East wall at x = 11
  [
    { op: 'declare', id: 'east_window', type: 'window', dims: [1.2, 1.4, 0.08], material: 'glass' },
    { op: 'meet', entity: 'east_window', plane: [0, 1, 0, -1.8] },
    { op: 'meet', entity: 'east_window', plane: [1, 0, 0, -11] },
    { op: 'meet', entity: 'east_window', plane: [0, 0, 1, -6] },
  ],

  // 15: "Walk-in closet north of bed"
  // Bed north at z = 6 + 1.05 = 7.05 → closet center z ≈ 8
  [
    { op: 'declare', id: 'closet', type: 'walk_in_closet', dims: [2, 2.8, 1.8], material: 'default' },
    { op: 'meet', entity: 'closet', plane: [0, 1, 0, -1.4] },
    { op: 'meet', entity: 'closet', plane: [1, 0, 0, -10] },
    { op: 'meet', entity: 'closet', plane: [0, 0, 1, -8] },
  ],

  // 16: "Bathroom adjacent to closet"
  // Closet west face at x = 10 - 1 = 9 → bath center x = 9 - 0.1 - 1.25 = 7.65
  [
    { op: 'declare', id: 'bathroom', type: 'bathroom', dims: [2.5, 2.8, 2], material: 'tile' },
    { op: 'meet', entity: 'bathroom', plane: [0, 1, 0, -1.4] },
    { op: 'meet', entity: 'bathroom', plane: [1, 0, 0, -7.65] },
    { op: 'meet', entity: 'bathroom', plane: [0, 0, 1, -8] },
  ],

  // 17: "[return to corridor, face north]"
  [],

  // 18: "L-counter against north wall of kitchen"
  // Kitchen north at z = 9.5 + 1.5 = 11 → counter center z = 11 - 0.3 = 10.7
  [
    { op: 'declare', id: 'l_counter', type: 'L_counter', dims: [3.5, 0.9, 0.6], material: 'stone' },
    { op: 'meet', entity: 'l_counter', plane: [0, 1, 0, -0.45] },
    { op: 'meet', entity: 'l_counter', plane: [1, 0, 0, 1] },
    { op: 'meet', entity: 'l_counter', plane: [0, 0, 1, -10.7] },
  ],

  // 19: "Refrigerator embedded in L-counter"
  // L-counter west face at x = -1 - 1.75 = -2.75
  [
    { op: 'declare', id: 'fridge', type: 'refrigerator', dims: [0.85, 1.8, 0.7], material: 'steel' },
    { op: 'meet', entity: 'fridge', plane: [0, 1, 0, -0.9] },
    { op: 'meet', entity: 'fridge', plane: [1, 0, 0, 2.3] },
    { op: 'meet', entity: 'fridge', plane: [0, 0, 1, -10.5] },
  ],

  // 20: "Pendant light above island"
  [
    { op: 'declare', id: 'pendant', type: 'pendant_light', dims: [0.4, 0.2, 0.4], material: 'metal' },
    { op: 'meet', entity: 'pendant', plane: [0, 1, 0, -2.5] },
    { op: 'meet', entity: 'pendant', plane: [1, 0, 0, 1] },
    { op: 'meet', entity: 'pendant', plane: [0, 0, 1, -7] },
  ],

  // 21: "Sofa against west wall of living_room"
  // Living west at x = -1 - 4 = -5 → sofa center x = -5 + 0.45 = -4.55
  [
    { op: 'declare', id: 'sofa', type: 'sofa', dims: [2.2, 0.8, 0.9], material: 'fabric' },
    { op: 'meet', entity: 'sofa', plane: [0, 1, 0, -0.4] },
    { op: 'meet', entity: 'sofa', plane: [1, 0, 0, 4.55] },
    { op: 'meet', entity: 'sofa', plane: [0, 0, 1, -5.5] },
    { op: 'orient', entity: 'sofa', angle: -90 },
  ],

  // 22: "Dining table between sofa and island"
  [
    { op: 'declare', id: 'dining_table', type: 'dining_table', dims: [1.6, 0.76, 0.9], material: 'wood' },
    { op: 'meet', entity: 'dining_table', plane: [0, 1, 0, -0.38] },
    { op: 'meet', entity: 'dining_table', plane: [1, 0, 0, 2] },
    { op: 'meet', entity: 'dining_table', plane: [0, 0, 1, -6] },
  ],
];

// ═══════════════════════════════════════════════════════════════════
// TEST CASE 2: Suspension Bridge (structural topology)
// ═══════════════════════════════════════════════════════════════════

const BRIDGE_SENTENCES = [
  '[viewing from south, facing north]',
  'Left main tower, concrete, 0.5m wide, 8m tall, on riverbed at x=-5.',
  'Right main tower, concrete, 0.5m wide, 8m tall, on riverbed at x=5.',
  'Bridge deck spans between towers, 12m long, 0.3m thick, at height 4m.',
  'Left anchorage, concrete, at x=-8 on ground.',
  'Right anchorage, concrete, at x=8 on ground.',
];

const BRIDGE_OPS: Op[][] = [
  [],
  [
    { op: 'declare', id: 'tower_l', type: 'column', dims: [0.5, 8, 0.5], material: 'concrete' },
    { op: 'meet', entity: 'tower_l', plane: [0, 1, 0, -4] },
    { op: 'meet', entity: 'tower_l', plane: [1, 0, 0, 5] },
    { op: 'meet', entity: 'tower_l', plane: [0, 0, 1, 0] },
  ],
  [
    { op: 'declare', id: 'tower_r', type: 'column', dims: [0.5, 8, 0.5], material: 'concrete' },
    { op: 'meet', entity: 'tower_r', plane: [0, 1, 0, -4] },
    { op: 'meet', entity: 'tower_r', plane: [1, 0, 0, -5] },
    { op: 'meet', entity: 'tower_r', plane: [0, 0, 1, 0] },
  ],
  [
    { op: 'declare', id: 'deck', type: 'beam', dims: [12, 0.3, 2], material: 'concrete' },
    { op: 'meet', entity: 'deck', plane: [0, 1, 0, -4] },
    { op: 'meet', entity: 'deck', plane: [1, 0, 0, 0] },
    { op: 'meet', entity: 'deck', plane: [0, 0, 1, 0] },
  ],
  [
    { op: 'declare', id: 'anchor_l', type: 'foundation', dims: [1.5, 1, 1.5], material: 'concrete' },
    { op: 'meet', entity: 'anchor_l', plane: [0, 1, 0, -0.5] },
    { op: 'meet', entity: 'anchor_l', plane: [1, 0, 0, 8] },
    { op: 'meet', entity: 'anchor_l', plane: [0, 0, 1, 0] },
  ],
  [
    { op: 'declare', id: 'anchor_r', type: 'foundation', dims: [1.5, 1, 1.5], material: 'concrete' },
    { op: 'meet', entity: 'anchor_r', plane: [0, 1, 0, -0.5] },
    { op: 'meet', entity: 'anchor_r', plane: [1, 0, 0, -8] },
    { op: 'meet', entity: 'anchor_r', plane: [0, 0, 1, 0] },
  ],
];

// ═══════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════

function runTest(name: string, sentences: string[], ops: Op[][]): PipelineResult {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('═'.repeat(60));
  console.log(`  Sentences: ${sentences.length}`);
  console.log(`  Processing...\n`);

  const result = runDirect(sentences, ops);

  console.log(`\n  Result:`);
  console.log(`    Entities resolved: ${result.entityCount}`);
  console.log(`    Total PGA ops: ${result.totalOps}`);
  console.log(`    Final DOF: ${result.finalDOF}`);
  console.log(`    HTML size: ${result.html.length} bytes`);

  return result;
}

// Run apartment
const apt = runTest('Apartment (23 sentences, 21 entities)', APARTMENT_SENTENCES, APARTMENT_OPS);
writeFileSync('apartment.html', apt.html);
console.log('  → Wrote /mnt/user-data/outputs/apartment.html');

// Run bridge
const bridge = runTest('Bridge (6 sentences, 5 entities)', BRIDGE_SENTENCES, BRIDGE_OPS);
writeFileSync('bridge.html', bridge.html);
console.log('  → Wrote /mnt/user-data/outputs/bridge.html');

console.log(`\n${'═'.repeat(60)}`);
console.log('  Done. Open HTML files to view 3D sketches.');
console.log('═'.repeat(60));
