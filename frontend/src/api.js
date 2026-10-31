async function req(method, url, body, isForm) {
  const opts = { method }
  if (body !== undefined) {
    opts.body = isForm ? body : JSON.stringify(body)
    if (!isForm) opts.headers = { 'Content-Type': 'application/json' }
  }
  const res = await fetch(url, opts)
  if (!res.ok) {
    let detail = res.statusText
    try { detail = (await res.json()).detail ?? detail } catch {}
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return res.status === 204 ? null : res.json()
}

const f = (id) => `/api/files/${id}`
const c = (id, tid) => `${f(id)}/comments/${tid}`

export const api = {
  listFiles: () => req('GET', '/api/files'),
  upload: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return req('PUT', '/api/files', fd, true)
  },
  deleteFile: (id) => req('DELETE', f(id)),
  pdfUrl: (id) => f(id),
  snapUrl: (id, tid) => `${f(id)}/snaps/${tid}.png`,
  comments: (id) => req('GET', `${f(id)}/comments`),
  createThread: (id, anchor, text, snapPng) =>
    req('POST', `${f(id)}/comments`, { anchor, text, snap_png: snapPng }),
  reply: (id, tid, text) => req('POST', `${c(id, tid)}/replies`, { text }),
  resolve: (id, tid, resolved) => req('PATCH', c(id, tid), { resolved }),
  resetContext: (id) => req('POST', `${f(id)}/reset-context`),
  deleteThread: (id, tid) => req('DELETE', c(id, tid)),
  stop: (id, tid, mid) => req('POST', `${c(id, tid)}/messages/${mid}/stop`),
  retry: (id, tid, mid) => req('POST', `${c(id, tid)}/messages/${mid}/retry`),
  agents: (refresh) => req('GET', `/api/agents${refresh ? '?refresh=true' : ''}`),
  setSettings: (s) => req('PUT', '/api/settings', s),
  resumeProvider: (p) => req('POST', `/api/providers/${p}/resume`),
  events: (id) => new EventSource(`${f(id)}/events`),
}
