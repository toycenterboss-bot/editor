'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ViewSettingsState {
  frameOnLoad: boolean
  showRenderStats: boolean
  setFrameOnLoad: (v: boolean) => void
  setShowRenderStats: (v: boolean) => void
  toggleRenderStats: () => void
}

const useViewSettings = create<ViewSettingsState>()(
  persist(
    (set) => ({
      frameOnLoad: true,
      showRenderStats: false,
      setFrameOnLoad: (v) => set({ frameOnLoad: v }),
      setShowRenderStats: (v) => set({ showRenderStats: v }),
      toggleRenderStats: () => set((state) => ({ showRenderStats: !state.showRenderStats })),
    }),
    {
      name: 'pascal-view-settings',
    },
  ),
)

export default useViewSettings
