'use client'

import { type AnyNodeId, sceneRegistry, useScene, type WallNode } from '@pascal-app/core'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { type BufferGeometry, type Material, Matrix4, Mesh, type Object3D } from 'three'
import {
  applyWallBatchGroups,
  buildWallBatch,
  hideBatchedWall,
  revealBatchedWall,
  type WallBatch,
} from '../../lib/wall-batch'

// A level's walls are merged only once they stop changing. Below this many
// walls a merge is not worth the buffer, and the leftovers (a selected wall,
// a lone partition) keep drawing themselves.
const MIN_BATCH_WALLS = 8
// Quiet window after the last wall change before the merge runs. Long enough
// that a drag or a progressive import never triggers one mid-flight.
const BATCH_SETTLE_MS = 180

type WallSignature = {
  levelId: string
  material: Material | Material[]
  geometry: BufferGeometry
  visible: boolean
  x: number
  y: number
  z: number
  rotationY: number
}

type BatchRecord = {
  levelId: string
  mesh: Mesh
  batch: WallBatch
  hidden: Set<string>
  nodeIds: string[]
}

const signatures = new Map<string, WallSignature>()
const batchesByLevel = new Map<string, BatchRecord[]>()
const batchByNode = new Map<string, BatchRecord>()
const staleLevels = new Set<string>()
const EMPTY_IDS: ReadonlySet<string> = new Set()
let lastWallChangeAtMs = 0

/**
 * Batched walls are drawn by the merged mesh but still picked, measured and
 * highlighted through their own meshes, so the merged copy must stay out of
 * every raycast.
 */
function skipRaycast() {
  // intentionally empty — see the note above
}

function showOwnGeometry(nodeId: string) {
  const mesh = sceneRegistry.nodes.get(nodeId) as Mesh | undefined
  if (mesh) revealBatchedWall(mesh)
}

/** Hands a wall back to itself: the merged mesh stops drawing it, it resumes. */
function releaseWall(nodeId: string) {
  const record = batchByNode.get(nodeId)
  if (record) {
    record.hidden.add(nodeId)
    applyWallBatchGroups(record.batch, record.hidden)
    batchByNode.delete(nodeId)
  }
  showOwnGeometry(nodeId)
}

function disposeLevelBatches(levelId: string) {
  const records = batchesByLevel.get(levelId)
  if (!records) return

  for (const record of records) {
    record.mesh.removeFromParent()
    record.batch.geometry.dispose()
    for (const nodeId of record.nodeIds) {
      if (batchByNode.get(nodeId) === record) batchByNode.delete(nodeId)
      showOwnGeometry(nodeId)
    }
  }

  batchesByLevel.delete(levelId)
}

type Candidate = { nodeId: string; mesh: Mesh; materials: Material[] }

/**
 * A wall joins a batch only if its whole material set is opaque. Translucent
 * and cut-away walls depend on per-object blend ordering, which merging would
 * change — they keep the per-wall path.
 */
function toCandidate(nodeId: string, node: WallNode): Candidate | null {
  if (node.visible === false) return null

  const mesh = sceneRegistry.nodes.get(nodeId) as Mesh | undefined
  if (!mesh?.visible) return null
  if (!mesh.geometry?.getAttribute('position')) return null

  const materials = mesh.material
  if (!Array.isArray(materials) || materials.length === 0) return null
  if (materials.some((material) => material.transparent)) return null

  return { nodeId, mesh, materials }
}

function materialSetKey(materials: readonly Material[]): string {
  return materials.map((material) => material.uuid).join('|')
}

function collectCandidates(levelId: string): Map<string, Candidate[]> {
  const nodes = useScene.getState().nodes
  const level = nodes[levelId as AnyNodeId]
  const grouped = new Map<string, Candidate[]>()
  if (level?.type !== 'level') return grouped

  for (const childId of level.children) {
    const child = nodes[childId]
    if (child?.type !== 'wall') continue

    const candidate = toCandidate(childId, child as WallNode)
    if (!candidate) continue

    const key = materialSetKey(candidate.materials)
    const bucket = grouped.get(key)
    if (bucket) bucket.push(candidate)
    else grouped.set(key, [candidate])
  }

  return grouped
}

/**
 * Walls on this level that no batch currently draws.
 *
 * Editing a wall drops it out of its batch — a group-list rewrite that touches
 * no buffer — and it goes back to drawing itself. Re-sewing the level only
 * pays off once enough walls have drifted out, so a single edit leaves the
 * floor's merged mesh exactly where it was.
 */
function unbatchedWallCount(levelId: string): number {
  const nodes = useScene.getState().nodes
  const level = nodes[levelId as AnyNodeId]
  if (level?.type !== 'level') return 0

  let count = 0
  for (const childId of level.children) {
    if (batchByNode.has(childId)) continue
    const child = nodes[childId]
    if (child?.type !== 'wall') continue
    if (toCandidate(childId, child as WallNode)) count++
  }

  return count
}

const localMatrix = new Matrix4()
const rootInverse = new Matrix4()

function mergeLevel(levelId: string) {
  disposeLevelBatches(levelId)

  const root = sceneRegistry.nodes.get(levelId) as Object3D | undefined
  if (!root) return

  root.updateWorldMatrix(true, false)
  rootInverse.copy(root.matrixWorld).invert()

  const records: BatchRecord[] = []

  for (const candidates of collectCandidates(levelId).values()) {
    if (candidates.length < MIN_BATCH_WALLS) continue

    const sources = candidates.map((candidate) => {
      candidate.mesh.updateWorldMatrix(true, false)
      return {
        nodeId: candidate.nodeId,
        geometry: candidate.mesh.geometry,
        matrix: localMatrix.multiplyMatrices(rootInverse, candidate.mesh.matrixWorld).clone(),
      }
    })

    const batch = buildWallBatch(sources)
    if (!batch) continue

    const mesh = new Mesh(batch.geometry, candidates[0]!.materials)
    mesh.name = 'wall-batch'
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    mesh.raycast = skipRaycast
    root.add(mesh)

    const record: BatchRecord = {
      levelId,
      mesh,
      batch,
      hidden: new Set(),
      nodeIds: candidates.map((candidate) => candidate.nodeId),
    }
    records.push(record)

    for (const candidate of candidates) {
      hideBatchedWall(candidate.mesh)
      batchByNode.set(candidate.nodeId, record)
    }
  }

  if (records.length > 0) batchesByLevel.set(levelId, records)
}

function sameSignature(previous: WallSignature, next: WallSignature): boolean {
  return (
    previous.levelId === next.levelId &&
    previous.material === next.material &&
    previous.geometry === next.geometry &&
    previous.visible === next.visible &&
    previous.x === next.x &&
    previous.y === next.y &&
    previous.z === next.z &&
    previous.rotationY === next.rotationY
  )
}

function readSignature(mesh: Mesh, node: WallNode): WallSignature {
  return {
    levelId: node.parentId ?? '',
    material: mesh.material,
    geometry: mesh.geometry,
    visible: mesh.visible && node.visible !== false,
    x: mesh.position.x,
    y: mesh.position.y,
    z: mesh.position.z,
    rotationY: mesh.rotation.y,
  }
}

export const WallBatchSystem = () => {
  const invalidate = useThree((state) => state.invalidate)
  const wakeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useFrame(() => runBatchFrame(invalidate, wakeRef), 5)

  useEffect(
    () => () => {
      if (wakeRef.current) clearTimeout(wakeRef.current)
      for (const levelId of [...batchesByLevel.keys()]) disposeLevelBatches(levelId)
      signatures.clear()
      staleLevels.clear()
    },
    [],
  )

  return null
}

function runBatchFrame(
  invalidate: () => void,
  wakeRef: { current: ReturnType<typeof setTimeout> | null },
) {
  const wallIds = sceneRegistry.byType.wall ?? EMPTY_IDS
  const nodes = useScene.getState().nodes
  let changed = false

  for (const nodeId of wallIds) {
    const node = nodes[nodeId as AnyNodeId]
    const mesh = sceneRegistry.nodes.get(nodeId) as Mesh | undefined
    if (node?.type !== 'wall' || !mesh) continue

    const next = readSignature(mesh, node as WallNode)
    const previous = signatures.get(nodeId)
    signatures.set(nodeId, next)
    if (previous && sameSignature(previous, next)) continue

    changed = true
    if (previous) staleLevels.add(previous.levelId)
    staleLevels.add(next.levelId)
    releaseWall(nodeId)
  }

  for (const nodeId of [...signatures.keys()]) {
    if (wallIds.has(nodeId)) continue
    const previous = signatures.get(nodeId)
    signatures.delete(nodeId)
    if (previous) staleLevels.add(previous.levelId)
    releaseWall(nodeId)
    changed = true
  }

  if (changed) {
    lastWallChangeAtMs = performance.now()
    // The canvas only renders on demand, so nothing would bring us back
    // after the scene goes quiet — poke one frame once the window closes.
    if (wakeRef.current) clearTimeout(wakeRef.current)
    wakeRef.current = setTimeout(() => {
      wakeRef.current = null
      invalidate()
    }, BATCH_SETTLE_MS + 20)
    return
  }

  if (staleLevels.size === 0) return
  if (performance.now() - lastWallChangeAtMs < BATCH_SETTLE_MS) return

  for (const levelId of staleLevels) {
    if (unbatchedWallCount(levelId) >= MIN_BATCH_WALLS) mergeLevel(levelId)
  }
  staleLevels.clear()
}
