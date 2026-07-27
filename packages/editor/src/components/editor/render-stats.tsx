'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'

// Live render telemetry. The point is falsifiability: LOD and culling claims are
// only believable if the numbers move when the camera does. Draw calls and
// triangles come straight from the renderer's own per-frame counters, so they
// report what the GPU was actually asked to do, not what the scene graph hoped.

type RenderStatsSnapshot = {
  frame: number
  drawCalls: number
  triangles: number
  geometries: number
  textures: number
  meshes: number
  visibleMeshes: number
}

const latest: RenderStatsSnapshot = {
  frame: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  meshes: 0,
  visibleMeshes: 0,
}

type RendererInfo = {
  autoReset?: boolean
  reset?: () => void
  render?: { drawCalls?: number; triangles?: number }
  memory?: { geometries?: number; textures?: number }
}

/**
 * Mounts inside the Canvas. Priority stays at 0 on purpose: any positive
 * priority would hand the render loop to this component and nothing would draw.
 */
export function RenderStatsProbe() {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const lastCensusRef = useRef(0)

  useEffect(() => {
    ;(window as unknown as { __renderStats?: RenderStatsSnapshot }).__renderStats = latest
    // three.js clears the per-frame counters from its own animation callback,
    // which fires before this one — so by the time useFrame runs the numbers
    // are already zero. Taking ownership of the reset makes the read exact:
    // we sample what the previous frame drew, then clear for the current one.
    const info = (gl as unknown as { info?: RendererInfo }).info
    if (info) info.autoReset = false
    return () => {
      if (info) info.autoReset = true
    }
  }, [gl])

  useFrame(() => {
    latest.frame += 1

    const info = (gl as unknown as { info?: RendererInfo }).info
    if (info) {
      latest.drawCalls = info.render?.drawCalls ?? 0
      latest.triangles = info.render?.triangles ?? 0
      latest.geometries = info.memory?.geometries ?? 0
      latest.textures = info.memory?.textures ?? 0
      info.reset?.()
    }

    // Walking the graph is O(scene) — twice a second is enough to watch a floor
    // appear or disappear, and cheap enough not to become the thing it measures.
    const now = performance.now()
    if (now - lastCensusRef.current < 500) return
    lastCensusRef.current = now

    let meshes = 0
    let visibleMeshes = 0
    scene.traverse((object) => {
      if (!(object as unknown as { isMesh?: boolean }).isMesh) return
      meshes += 1
      let node: typeof object | null = object
      while (node) {
        if (!node.visible) return
        node = node.parent
      }
      visibleMeshes += 1
    })
    latest.meshes = meshes
    latest.visibleMeshes = visibleMeshes
  })

  return null
}

const numberFormatter = new Intl.NumberFormat('ru-RU')

function StatRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-white/55">{label}</span>
      <span className="font-medium tabular-nums text-white" title={hint}>
        {value}
      </span>
    </div>
  )
}

/**
 * Mounts outside the Canvas and polls the snapshot the probe writes. Frames are
 * only advanced on demand (`frameloop="never"`), so an idle scene honestly reads
 * 0 FPS instead of pretending to run at 60.
 */
export function RenderStatsOverlay() {
  const [isVisible, setIsVisible] = useState(true)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [view, setView] = useState({ ...latest, fps: 0 })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.code !== 'KeyP') return
      event.preventDefault()
      setIsVisible((current) => !current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!isVisible) return
    let previousFrame = latest.frame
    let previousTime = performance.now()
    let smoothedFps = 0
    const timer = window.setInterval(() => {
      const now = performance.now()
      const elapsed = Math.max(1, now - previousTime)
      const rawFps = ((latest.frame - previousFrame) * 1000) / elapsed
      previousFrame = latest.frame
      previousTime = now
      smoothedFps = rawFps === 0 ? 0 : smoothedFps * 0.6 + rawFps * 0.4
      setView({ ...latest, fps: Math.round(smoothedFps) })
    }, 250)
    return () => window.clearInterval(timer)
  }, [isVisible])

  if (!isVisible) return null

  const trianglesPerCall = view.drawCalls > 0 ? Math.round(view.triangles / view.drawCalls) : 0
  // Frustum culling has no counter of its own in three.js — it shows up as draw
  // calls dropping. What we *can* count exactly is the visible flag, which is
  // what floor and room filtering actually toggles.
  const hiddenMeshes = Math.max(0, view.meshes - view.visibleMeshes)

  return (
    <div className="pointer-events-none absolute bottom-16 left-3 z-30 select-none">
      <div className="pointer-events-auto w-56 rounded-lg border border-white/10 bg-black/70 px-3 py-2 font-mono text-[11px] leading-5 text-white shadow-lg backdrop-blur">
        <button
          className="flex w-full items-center justify-between text-left text-white/70 hover:text-white"
          onClick={() => setIsCollapsed((current) => !current)}
          type="button"
        >
          <span className="tracking-wide">RENDER {view.fps} FPS</span>
          <span aria-hidden>{isCollapsed ? '+' : '−'}</span>
        </button>
        {isCollapsed ? null : (
          <div className="mt-1.5 space-y-0.5 border-white/10 border-t pt-1.5">
            <StatRow
              hint="Сколько раз за кадр GPU просят что-то нарисовать"
              label="draw calls"
              value={numberFormatter.format(view.drawCalls)}
            />
            <StatRow
              hint="Треугольников отправлено на отрисовку в последнем кадре"
              label="треугольники"
              value={numberFormatter.format(view.triangles)}
            />
            <StatRow label="на вызов" value={numberFormatter.format(trianglesPerCall)} />
            <StatRow
              hint="Мешей в графе сцены / из них не скрыто флагом visible"
              label="меши"
              value={`${numberFormatter.format(view.visibleMeshes)} / ${numberFormatter.format(view.meshes)}`}
            />
            <StatRow
              hint="Меши, снятые с рендера флагом visible (этажи, фильтры)"
              label="скрыто"
              value={numberFormatter.format(hiddenMeshes)}
            />
            <StatRow
              hint="Геометрий в памяти GPU"
              label="геометрии"
              value={numberFormatter.format(view.geometries)}
            />
            <StatRow
              hint="Текстур в памяти GPU"
              label="текстуры"
              value={numberFormatter.format(view.textures)}
            />
            <div className="pt-1 text-[10px] text-white/40 leading-4">Alt+P — скрыть</div>
          </div>
        )}
      </div>
    </div>
  )
}
