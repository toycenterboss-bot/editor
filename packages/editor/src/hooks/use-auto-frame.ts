'use client'

import { emitter, useScene } from '@pascal-app/core'
import { useEffect, useRef } from 'react'
import { computeSceneBoundsXZ } from '../lib/scene-bounds'

/**
 * Auto-frame the camera onto a freshly loaded scene.
 *
 * Motivation: when the MCP `setScene` tool (or any other entry point) swaps
 * the scene graph while the default camera is pointing at empty space, the
 * user sees a black viewport. Opening a saved scene by URL has the same
 * problem from the other direction: the graph is already in the store before
 * this hook mounts, so there is no transition to react to and the camera
 * keeps its default pose — which the 3D→2D sync bridge then publishes to the
 * floorplan, handing it an absurd zoom before it can fit itself.
 *
 * So there are two triggers: an empty → non-empty transition, and a scene
 * that was already populated at mount. Both are one-shot.
 *
 * Mount in exactly ONE component (the Editor).
 */
export function useAutoFrame(): void {
  // Track the previous node count so we can detect the empty → non-empty edge.
  const wasEmptyRef = useRef(true)
  const hasFramedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let rafId = 0

    // `<CustomCameraControls />` lives inside the Canvas and only registers its
    // listener once the WebGPU device is up — seconds after this hook mounts.
    // Emitting into the void would silently do nothing, so wait until someone
    // is actually listening. The deadline keeps an empty editor (no scene, so
    // no controls to wait for) from polling forever.
    const emitWhenListening = (nodes: ReturnType<typeof useScene.getState>['nodes']) => {
      const deadline = performance.now() + 15_000
      const attempt = () => {
        if (cancelled) return
        const listeners = emitter.all.get('camera-controls:fit-scene')
        if (!listeners || listeners.length === 0) {
          if (performance.now() > deadline) return
          rafId = requestAnimationFrame(attempt)
          return
        }
        const bounds = computeSceneBoundsXZ(nodes)
        emitter.emit('camera-controls:fit-scene', bounds ? { bounds } : {})
      }
      attempt()
    }

    const initialNodes = useScene.getState().nodes
    wasEmptyRef.current = Object.keys(initialNodes).length === 0
    if (!wasEmptyRef.current) {
      hasFramedRef.current = true
      emitWhenListening(initialNodes)
    }

    const unsubscribe = useScene.subscribe((state) => {
      const isEmpty = Object.keys(state.nodes).length === 0
      const wasEmpty = wasEmptyRef.current
      wasEmptyRef.current = isEmpty

      // Only react to empty → non-empty transitions. Normal edits keep both
      // flags false; a `clearScene()` goes non-empty → empty and is ignored.
      if (!wasEmpty || isEmpty || hasFramedRef.current) return

      hasFramedRef.current = true
      emitWhenListening(state.nodes)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      unsubscribe()
    }
  }, [])
}
