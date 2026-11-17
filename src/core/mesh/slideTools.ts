import { EditableMesh, MeshFace, Vec3 } from './EditableMesh';

export type SlideMode = 'vertex' | 'edge';

export interface VertexRailOption {
  edgeId: string;
  neighborId: string;
  startPos: Vec3;
  targetPos: Vec3;
  dir3D: Vec3;
  length: number;
}

export interface VertexSlidePlan {
  valid: boolean;
  reason?: string;
  vertexIds: string[];
  railsByVertex: Map<string, VertexRailOption[]>;
  guideSegments: [Vec3, Vec3][];
}

export interface VertexSlideSelection {
  vertexId: string;
  edgeId: string;
  neighborId: string;
  startPos: Vec3;
  targetPos: Vec3;
  factor: number; // clamped >= 0 when clamp=true, signed when clamp=false
}

export interface EdgeSlideRail {
  vertexId: string;
  startPos: Vec3;
  railA: Vec3 | null;
  railB: Vec3 | null;
}

export interface EdgeSlidePlan {
  valid: boolean;
  reason?: string;
  edgeIds: string[];
  railsByVertex: Map<string, EdgeSlideRail>;
  avgDirA: Vec3;
  avgDirB: Vec3;
  avgLenA: number;
  avgLenB: number;
  guideSegments: [Vec3, Vec3][];
}

export interface SlideApplyResult {
  mesh: EditableMesh;
  movedVertexIds: Set<string>;
  appliedFactor: number;
  clamped: boolean;
}

function subVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function lenVec(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normVec(a: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 {
  const l = lenVec(a);
  if (l < 1e-8) return fallback;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function dotVec(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/* ============================================================================
 * 1. VERTEX SLIDE — Deslizamiento topológico a lo largo de aristas conectadas
 * ========================================================================== */

/**
 * Inspects selected vertices and collects valid connected edges along which each vertex can slide.
 */
export function buildVertexSlidePlan(
  mesh: EditableMesh,
  selectedIds: ReadonlySet<string>,
): VertexSlidePlan {
  const vertexIds: string[] = [];
  const railsByVertex = new Map<string, VertexRailOption[]>();
  const guideSegments: [Vec3, Vec3][] = [];
  const seenEdges = new Set<string>();

  for (const vid of selectedIds) {
    const v = mesh.getVertex(vid);
    if (!v) continue;

    const incEdgeIds = mesh.getEdgesForVertex(vid);
    const options: VertexRailOption[] = [];
    for (const eid of incEdgeIds) {
      const edge = mesh.getEdge(eid);
      if (!edge) continue;
      const neighborId = edge.v0 === vid ? edge.v1 : edge.v0;
      const neighbor = mesh.getVertex(neighborId);
      if (!neighbor) continue;

      const delta = subVec(neighbor.position, v.position);
      const length = lenVec(delta);
      if (length < 1e-7) continue;

      options.push({
        edgeId: eid,
        neighborId,
        startPos: [...v.position],
        targetPos: [...neighbor.position],
        dir3D: normVec(delta),
        length,
      });

      if (!seenEdges.has(eid)) {
        seenEdges.add(eid);
        guideSegments.push([[...v.position], [...neighbor.position]]);
      }
    }

    if (options.length > 0) {
      vertexIds.push(vid);
      railsByVertex.set(vid, options);
    }
  }

  if (vertexIds.length === 0) {
    return {
      valid: false,
      reason:
        'Selecciona al menos un vértice conectado a una arista para usar Vertex Slide.',
      vertexIds: [],
      railsByVertex,
      guideSegments: [],
    };
  }

  return {
    valid: true,
    vertexIds,
    railsByVertex,
    guideSegments,
  };
}

/**
 * Pure 3D Vertex Slide along a target direction vector (picks the best aligned incident edge per vertex).
 * Supports bidirectional sliding when connected edges exist on opposite sides or when clamp=false.
 */
export function applyVertexSlideAlongDirection(
  sourceMesh: EditableMesh,
  plan: VertexSlidePlan,
  worldDirLocal: Vec3,
  factor: number,
  clamp = true,
): SlideApplyResult {
  const mesh = sourceMesh.clone();
  const movedVertexIds = new Set<string>();
  if (!plan.valid || Math.abs(factor) < 1e-6) {
    return { mesh, movedVertexIds, appliedFactor: 0, clamped: false };
  }

  const dir = normVec(worldDirLocal, [1, 0, 0]);
  const signedDir: Vec3 =
    factor >= 0 ? dir : [-dir[0], -dir[1], -dir[2]];
  const mag = Math.abs(factor);
  const clampedFactor = clamp ? Math.min(0.98, mag) : Math.min(1.5, mag);
  const wasClamped = clampedFactor !== mag;

  for (const vid of plan.vertexIds) {
    const options = plan.railsByVertex.get(vid);
    const v = mesh.getVertex(vid);
    if (!options || options.length === 0 || !v) continue;

    let bestPosOpt: VertexRailOption | null = null;
    let bestPosDot = 0.08;
    let bestAbsOpt = options[0];
    let bestAbsDot = -1;

    for (const opt of options) {
      const d = dotVec(signedDir, opt.dir3D);
      if (d > bestPosDot) {
        bestPosDot = d;
        bestPosOpt = opt;
      }
      if (Math.abs(d) > bestAbsDot) {
        bestAbsDot = Math.abs(d);
        bestAbsOpt = opt;
      }
    }

    if (bestPosOpt) {
      v.position = lerpVec(bestPosOpt.startPos, bestPosOpt.targetPos, clampedFactor);
      movedVertexIds.add(vid);
    } else if (!clamp) {
      const sign = dotVec(signedDir, bestAbsOpt.dir3D) >= 0 ? 1 : -1;
      v.position = lerpVec(
        bestAbsOpt.startPos,
        bestAbsOpt.targetPos,
        sign * clampedFactor,
      );
      movedVertexIds.add(vid);
    }
  }

  mesh.clearCustomNormals();
  return {
    mesh,
    movedVertexIds,
    appliedFactor: (factor >= 0 ? 1 : -1) * clampedFactor,
    clamped: wasClamped,
  };
}

/**
 * Applies screen-space gesture Vertex Slide using projected 2D edge vectors from each vertex.
 */
export function applyVertexSlideFromScreenSelections(
  sourceMesh: EditableMesh,
  selections: VertexSlideSelection[],
  clamp = true,
): SlideApplyResult {
  const mesh = sourceMesh.clone();
  const movedVertexIds = new Set<string>();
  let maxApplied = 0;
  let anyClamped = false;

  for (const sel of selections) {
    const v = mesh.getVertex(sel.vertexId);
    if (!v) continue;
    let t = sel.factor;
    if (clamp) {
      if (t < 0) {
        t = 0;
        anyClamped = true;
      } else if (t > 0.98) {
        t = 0.98;
        anyClamped = true;
      }
    } else {
      if (t < -1.5) {
        t = -1.5;
        anyClamped = true;
      } else if (t > 1.5) {
        t = 1.5;
        anyClamped = true;
      }
    }
    if (Math.abs(t) < 1e-5) continue;
    v.position = lerpVec(sel.startPos, sel.targetPos, t);
    movedVertexIds.add(sel.vertexId);
    if (Math.abs(t) > Math.abs(maxApplied)) maxApplied = t;
  }

  mesh.clearCustomNormals();
  return {
    mesh,
    movedVertexIds,
    appliedFactor: maxApplied,
    clamped: anyClamped,
  };
}

/* ============================================================================
 * 2. EDGE SLIDE — Deslizamiento topológico a través de caras adyacentes
 * ========================================================================== */

function findRailNeighborInFace(
  face: MeshFace,
  edgeV0: string,
  edgeV1: string,
  vertexId: string,
): string | null {
  const verts = face.vertexIds;
  const n = verts.length;
  if (n < 3) return null;
  const idx = verts.indexOf(vertexId);
  if (idx === -1) return null;
  const prevV = verts[(idx - 1 + n) % n];
  const nextV = verts[(idx + 1) % n];
  const otherEdgeVert = vertexId === edgeV0 ? edgeV1 : edgeV0;
  if (prevV === otherEdgeVert && nextV !== vertexId && nextV !== otherEdgeVert) {
    return nextV;
  }
  if (nextV === otherEdgeVert && prevV !== vertexId && prevV !== otherEdgeVert) {
    return prevV;
  }
  return null;
}

/**
 * Checks if two faces incident to `pivotV` lie on the same side of a selected edge chain
 * (i.e., connected in the vertex face-fan without crossing any selected edge).
 */
function facesConnectedWithoutCrossingSelected(
  mesh: EditableMesh,
  pivotV: string,
  faceSeedId: string,
  targetFaceId: string,
  selectedEdgeSet: ReadonlySet<string>,
): boolean {
  if (faceSeedId === targetFaceId) return true;
  const incFaces = new Set(mesh.getFacesForVertex(pivotV));
  if (!incFaces.has(faceSeedId) || !incFaces.has(targetFaceId)) return false;

  const visited = new Set<string>([faceSeedId]);
  const queue = [faceSeedId];

  while (queue.length > 0) {
    const fid = queue.shift()!;
    const edges = mesh.getEdgesForFace(fid);
    for (const eid of edges) {
      if (selectedEdgeSet.has(eid)) continue;
      const e = mesh.getEdge(eid);
      if (!e || (e.v0 !== pivotV && e.v1 !== pivotV)) continue;
      for (const nfId of mesh.getFacesForEdge(eid)) {
        if (!incFaces.has(nfId) || visited.has(nfId)) continue;
        if (nfId === targetFaceId) return true;
        visited.add(nfId);
        queue.push(nfId);
      }
    }
  }
  return false;
}

/**
 * Builds a consistent bidirectional Edge Slide plan across selected edges and adjacent faces.
 * Supports single edges, open edge chains, closed edge loops, quads, triangles, and n-gons.
 */
export function buildEdgeSlidePlan(
  mesh: EditableMesh,
  selectedIds: ReadonlySet<string>,
): EdgeSlidePlan {
  const validEdgeIds: string[] = [];
  for (const eid of selectedIds) {
    const edge = mesh.getEdge(eid);
    if (!edge) continue;
    const adj = mesh.getFacesForEdge(eid);
    if (adj.length >= 1 && adj.length <= 2) {
      validEdgeIds.push(eid);
    }
  }

  if (validEdgeIds.length === 0) {
    return {
      valid: false,
      reason:
        'Selecciona una o más aristas pertenecientes a caras para usar Edge Slide.',
      edgeIds: [],
      railsByVertex: new Map(),
      avgDirA: [1, 0, 0],
      avgDirB: [-1, 0, 0],
      avgLenA: 1,
      avgLenB: 1,
      guideSegments: [],
    };
  }

  const selectedEdgeSet = new Set(validEdgeIds);
  // Per selected edge, track which adjacent face is Side A and which is Side B
  const edgeSides = new Map<string, { sideA: string | null; sideB: string | null }>();

  for (const seedEid of validEdgeIds) {
    if (edgeSides.has(seedEid)) continue;
    const seedAdj = mesh.getFacesForEdge(seedEid);
    if (seedAdj.length === 0) continue;

    edgeSides.set(seedEid, {
      sideA: seedAdj[0] ?? null,
      sideB: seedAdj[1] ?? null,
    });

    const queue = [seedEid];
    while (queue.length > 0) {
      const currEid = queue.shift()!;
      const currEdge = mesh.getEdge(currEid);
      const currInfo = edgeSides.get(currEid);
      if (!currEdge || !currInfo) continue;

      for (const pivotV of [currEdge.v0, currEdge.v1]) {
        for (const incEid of mesh.getEdgesForVertex(pivotV)) {
          if (incEid === currEid || !selectedEdgeSet.has(incEid) || edgeSides.has(incEid)) {
            continue;
          }
          const nextAdj = mesh.getFacesForEdge(incEid);
          if (nextAdj.length === 0) continue;

          let sideA: string | null = null;
          let sideB: string | null = null;

          const f0 = nextAdj[0];
          const f1 = nextAdj[1] ?? null;

          if (
            (currInfo.sideA &&
              facesConnectedWithoutCrossingSelected(
                mesh,
                pivotV,
                currInfo.sideA,
                f0,
                selectedEdgeSet,
              )) ||
            (currInfo.sideB &&
              f1 &&
              facesConnectedWithoutCrossingSelected(
                mesh,
                pivotV,
                currInfo.sideB,
                f1,
                selectedEdgeSet,
              ))
          ) {
            sideA = f0;
            sideB = f1;
          } else if (
            (currInfo.sideB &&
              facesConnectedWithoutCrossingSelected(
                mesh,
                pivotV,
                currInfo.sideB,
                f0,
                selectedEdgeSet,
              )) ||
            (currInfo.sideA &&
              f1 &&
              facesConnectedWithoutCrossingSelected(
                mesh,
                pivotV,
                currInfo.sideA,
                f1,
                selectedEdgeSet,
              ))
          ) {
            sideA = f1;
            sideB = f0;
          } else {
            sideA = f0;
            sideB = f1;
          }

          edgeSides.set(incEid, { sideA, sideB });
          queue.push(incEid);
        }
      }
    }
  }

  // Gather per-vertex slide targets on Side A and Side B
  const accumA = new Map<string, Vec3[]>();
  const accumB = new Map<string, Vec3[]>();
  const allVertIds = new Set<string>();

  for (const eid of validEdgeIds) {
    const edge = mesh.getEdge(eid);
    const sides = edgeSides.get(eid);
    if (!edge || !sides) continue;
    allVertIds.add(edge.v0);
    allVertIds.add(edge.v1);

    for (const vid of [edge.v0, edge.v1]) {
      if (sides.sideA) {
        const faceA = mesh.getFace(sides.sideA);
        if (faceA) {
          const targetVid = findRailNeighborInFace(faceA, edge.v0, edge.v1, vid);
          const targetV = targetVid ? mesh.getVertex(targetVid) : undefined;
          if (targetV) {
            if (!accumA.has(vid)) accumA.set(vid, []);
            accumA.get(vid)!.push([...targetV.position]);
          }
        }
      }
      if (sides.sideB) {
        const faceB = mesh.getFace(sides.sideB);
        if (faceB) {
          const targetVid = findRailNeighborInFace(faceB, edge.v0, edge.v1, vid);
          const targetV = targetVid ? mesh.getVertex(targetVid) : undefined;
          if (targetV) {
            if (!accumB.has(vid)) accumB.set(vid, []);
            accumB.get(vid)!.push([...targetV.position]);
          }
        }
      }
    }
  }

  const avgPoints = (pts: Vec3[] | undefined): Vec3 | null => {
    if (!pts || pts.length === 0) return null;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const p of pts) {
      sx += p[0];
      sy += p[1];
      sz += p[2];
    }
    return [sx / pts.length, sy / pts.length, sz / pts.length];
  };

  const railsByVertex = new Map<string, EdgeSlideRail>();
  const guideSegments: [Vec3, Vec3][] = [];
  let sumDirA: Vec3 = [0, 0, 0];
  let sumDirB: Vec3 = [0, 0, 0];
  let sumLenA = 0;
  let countA = 0;
  let sumLenB = 0;
  let countB = 0;

  for (const vid of allVertIds) {
    const v = mesh.getVertex(vid);
    if (!v) continue;
    const pA = avgPoints(accumA.get(vid));
    const pB = avgPoints(accumB.get(vid));
    if (!pA && !pB) continue;

    railsByVertex.set(vid, {
      vertexId: vid,
      startPos: [...v.position],
      railA: pA,
      railB: pB,
    });

    if (pA) {
      const dA = subVec(pA, v.position);
      const lA = lenVec(dA);
      if (lA > 1e-7) {
        sumDirA = addVec(sumDirA, normVec(dA));
        sumLenA += lA;
        countA++;
        guideSegments.push([[...v.position], [...pA]]);
      }
    }
    if (pB) {
      const dB = subVec(pB, v.position);
      const lB = lenVec(dB);
      if (lB > 1e-7) {
        sumDirB = addVec(sumDirB, normVec(dB));
        sumLenB += lB;
        countB++;
        guideSegments.push([[...v.position], [...pB]]);
      }
    }
  }

  if (railsByVertex.size === 0) {
    return {
      valid: false,
      reason:
        'Las aristas seleccionadas no tienen caras vecinas válidas para deslizar.',
      edgeIds: validEdgeIds,
      railsByVertex,
      avgDirA: [1, 0, 0],
      avgDirB: [-1, 0, 0],
      avgLenA: 1,
      avgLenB: 1,
      guideSegments: [],
    };
  }

  const avgDirA = normVec(sumDirA, [1, 0, 0]);
  const avgDirB: Vec3 =
    countB > 0
      ? normVec(sumDirB, [-avgDirA[0], -avgDirA[1], -avgDirA[2]])
      : [-avgDirA[0], -avgDirA[1], -avgDirA[2]];

  return {
    valid: true,
    edgeIds: validEdgeIds,
    railsByVertex,
    avgDirA,
    avgDirB,
    avgLenA: countA > 0 ? sumLenA / countA : countB > 0 ? sumLenB / countB : 1,
    avgLenB: countB > 0 ? sumLenB / countB : countA > 0 ? sumLenA / countA : 1,
    guideSegments,
  };
}

/**
 * Slides the selected edge(s) smoothly across adjacent faces by `factor` in [-1, 1].
 * Positive factor slides toward Side A; negative factor slides toward Side B.
 * Clamps inside [-0.97, 0.97] to avoid collapsing faces or creating degenerate geometry.
 */
export function applyEdgeSlide(
  sourceMesh: EditableMesh,
  plan: EdgeSlidePlan,
  factor: number,
  clamp = true,
): SlideApplyResult {
  const mesh = sourceMesh.clone();
  const movedVertexIds = new Set<string>();
  if (!plan.valid || Math.abs(factor) < 1e-6) {
    return { mesh, movedVertexIds, appliedFactor: 0, clamped: false };
  }

  const maxBound = clamp ? 0.97 : 1.5;
  const fClamped = Math.max(-maxBound, Math.min(maxBound, factor));
  const wasClamped = Math.abs(fClamped - factor) > 1e-6;

  for (const [vid, rail] of plan.railsByVertex) {
    const v = mesh.getVertex(vid);
    if (!v) continue;

    if (fClamped > 0) {
      if (rail.railA) {
        v.position = lerpVec(rail.startPos, rail.railA, fClamped);
        movedVertexIds.add(vid);
      } else if (!clamp && rail.railB) {
        // Boundary edge: extend opposite to Side B when clamp is disabled
        v.position = lerpVec(rail.startPos, rail.railB, -fClamped);
        movedVertexIds.add(vid);
      }
    } else if (fClamped < 0) {
      const mag = Math.abs(fClamped);
      if (rail.railB) {
        v.position = lerpVec(rail.startPos, rail.railB, mag);
        movedVertexIds.add(vid);
      } else if (!clamp && rail.railA) {
        // Boundary edge: extend opposite to Side A when clamp is disabled
        v.position = lerpVec(rail.startPos, rail.railA, -mag);
        movedVertexIds.add(vid);
      }
    }
  }

  mesh.clearCustomNormals();
  return {
    mesh,
    movedVertexIds,
    appliedFactor: fClamped,
    clamped: wasClamped,
  };
}
