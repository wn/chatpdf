import { useCallback, useEffect, useMemo, useState } from 'react'

// UI preferences live in this browser only (localStorage); everything still works without it.
export function useStored(key, initial) {
  const [value, setValue] = useState(() => {
    try { const v = localStorage.getItem(key); return v === null ? initial : JSON.parse(v) } catch { return initial }
  })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }, [key, value])
  return [value, setValue]
}

export function useStoredSet(key) {
  const [arr, setArr] = useStored(key, [])
  const set = useMemo(() => new Set(arr), [arr])
  const update = useCallback((fn) => setArr((a) => [...(typeof fn === 'function' ? fn(new Set(a)) : fn)]), [setArr])
  return [set, update]
}

