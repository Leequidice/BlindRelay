import { useState, useEffect } from 'react'

/**
 * Returns the current Unix timestamp in seconds, updated every second.
 * Using this instead of Date.now() in render ensures buttons that are
 * gated on time (deadline, review window) appear and disappear without
 * a page refresh.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}
