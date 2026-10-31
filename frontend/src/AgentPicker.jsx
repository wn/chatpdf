import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { pausedText } from './ThreadCard.jsx'

// Toolbar dropdown: which AI (provider, model, effort) answers new questions.
export default function AgentPicker() {
  const [catalog, setCatalog] = useState(null)
  const [paused, setPaused] = useState({})
  const [settings, setSettings] = useState(null)
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(null)
  const ref = useRef(null)

  const load = (refresh = false) => {
    setChecking(refresh)
    return api.agents(refresh)
      .then((r) => { setCatalog(r.providers); setSettings(r.settings); setPaused(r.paused || {}); setError(null) })
      .catch((e) => setError(e.message))
      .finally(() => setChecking(false))
  }
  useEffect(() => { load() }, [])
  useEffect(() => { if (open) load() }, [open])
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  async function choose(next) {
    try {
      setSettings(await api.setSettings({ ...settings, ...next }))
    } catch (e) {
      setError(e.message)
    }
  }

  if (!catalog || !settings) return <button className="btn" disabled>AI…</button>
  const prov = catalog[settings.provider]
  const model = prov.models.find((m) => m.id === settings.model) ?? prov.models[0]

  return (
    <div className="picker" ref={ref}>
      <button className={`btn picker-btn ${prov.logged_in ? '' : 'warn'}`} onClick={() => setOpen((o) => !o)}
              title="Which AI answers new questions">
        <span className={`prov-dot ${settings.provider}`} />
        {prov.label} · {model.label}{settings.effort ? ` · ${settings.effort}` : ''}
        {!prov.logged_in && <span className="warn-badge" title="Not logged in">!</span>}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="picker-pop">
          <div className="picker-label">Provider</div>
          <div className="seg">
            {Object.entries(catalog).map(([id, p]) => (
              <button key={id} className={id === settings.provider ? 'on' : ''}
                      onClick={() => choose({ provider: id, model: null, effort: null })}>
                <span className={`prov-dot ${id}`} /> {p.label}
              </button>
            ))}
          </div>
          <div className={`login ${prov.logged_in ? 'ok' : 'bad'}`}>
            {prov.logged_in ? `✓ Logged in · ${prov.detail}` : `✕ ${prov.detail}`}
            <button className="link" onClick={() => load(true)} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
          </div>
          {!prov.logged_in && <div className="login-hint">{prov.hint.replace(', then press Retry', '')}</div>}
          {paused[settings.provider] && (
            <div className="login-hint">
              Paused: {pausedText(paused[settings.provider])} Waiting questions stay queued.{' '}
              <button className="link" onClick={() => api.resumeProvider(settings.provider).then(() => load(true))}>Try again now</button>
            </div>
          )}

          <div className="picker-label">Model</div>
          <select value={model.id} onChange={(e) => choose({ model: e.target.value, effort: null })}>
            {prov.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>

          <div className="picker-label">Effort</div>
          {model.efforts.length ? (
            <div className="seg wrap">
              {model.efforts.map((e) => (
                <button key={e} className={e === settings.effort ? 'on' : ''} onClick={() => choose({ effort: e })}>{e}</button>
              ))}
            </div>
          ) : <div className="picker-note">This model has no effort setting.</div>}
          <div className="picker-note">Applies to questions not answered yet. Runs on your {prov.label === 'Claude' ? 'Claude' : 'ChatGPT'} subscription.</div>
          {error && <div className="send-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

export function agentLabel(agent) {
  if (!agent) return null
  const name = agent.provider === 'openai' ? agent.model || 'Codex' : `Claude ${cap(agent.model || '')}`.trim()
  return agent.effort ? `${name} · ${agent.effort}` : name
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
