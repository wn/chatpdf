import { createContext, useEffect, useState } from 'react'
import { api } from './api.js'

// AI availability for components deep in the tree: online, paused providers, selected provider.
export const AiStatus = createContext({ online: true, paused: {}, provider: 'claude' })

// Live comment threads for one file: initial fetch + SSE updates.
// `serverUp` tracks the local backend; `online` tracks whether Claude is reachable.
export function useThreads(fileId) {
  const [threads, setThreads] = useState([])
  const [status, setStatus] = useState({ online: true, paused: {}, provider: 'claude' })
  const [serverUp, setServerUp] = useState(true)

  useEffect(() => {
    let closed = false
    const resync = () =>
      api.comments(fileId).then((r) => {
        if (closed) return
        setThreads(r.threads)
        setStatus(r.status)
      }).catch(() => {})

    const updateMsg = (tid, mid, fn) =>
      setThreads((ts) => ts.map((t) => t.id !== tid ? t : {
        ...t, messages: t.messages.map((m) => (m.id === mid ? fn(m) : m)),
      }))

    const es = api.events(fileId)
    es.onopen = () => { setServerUp(true); resync() } // also fires on reconnect
    es.onerror = () => setServerUp(false)
    const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)))
    on('status', setStatus)
    on('thread', (t) => setThreads((ts) => ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t]))
    on('thread_deleted', ({ thread_id }) => setThreads((ts) => ts.filter((t) => t.id !== thread_id)))
    on('delta', ({ thread_id, message_id, text }) =>
      updateMsg(thread_id, message_id, (m) => ({ ...m, status: 'answering', text: m.text + text, activity: null })))
    on('reset', ({ thread_id, message_id, activity }) =>
      updateMsg(thread_id, message_id, (m) => ({ ...m, text: '', activity })))

    return () => { closed = true; es.close() }
  }, [fileId])

  return { threads, setThreads, online: status.online, status, serverUp }
}
