import { useContext, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { api } from './api.js'
import { agentLabel } from './AgentPicker.jsx'
import { AiStatus } from './useThreads.js'

export default function ThreadCard({ thread, fileId, top, active, online, onActivate, onDeleted, onResolved, minimized, onToggleMinimize }) {
  const [reply, setReply] = useState('')
  const [sendError, setSendError] = useState(null)
  const [sending, setSending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { anchor } = thread
  const busy = thread.messages.some((m) => m.role === 'ai' && (m.status === 'queued' || m.status === 'answering'))

  async function sendReply() {
    const text = reply.trim()
    if (!text) return
    setSending(true)
    setSendError(null)
    try {
      await api.reply(fileId, thread.id, text)
      setReply('')
    } catch (e) {
      setSendError(e.message) // text stays in the box; user can retry
    } finally {
      setSending(false)
    }
  }

  const act = (fn) => (e) => { e.stopPropagation(); fn().catch((err) => setSendError(err.message)) }
  // A minimized thread collapses to its header, but expands while it is the active one.
  const mini = minimized && !active
  const questions = thread.messages.filter((m) => m.role === 'user').length
  const failed = thread.messages.some((m) => m.role === 'ai' && m.status === 'error')

  return (
    <div className={`card ${active ? 'active' : ''} ${thread.resolved ? 'resolved' : ''} ${mini ? 'mini' : ''}`}
         data-top={top} data-id={thread.id} onClick={() => !active && onActivate()}>
      <div className="card-head">
        <Anchor anchor={anchor} fileId={fileId} threadId={thread.id} />
        {mini && (
          <span className="mini-meta">
            {busy ? <span className="spinner" title="Claude is answering" /> : failed ? <span className="mini-err" title="An answer failed">!</span> : null}
            <span className="mini-count" title={`${questions} question${questions > 1 ? 's' : ''}`}>{questions}</span>
          </span>
        )}
        <div className="card-actions">
          <button className="icon-btn" title={minimized ? 'Expand thread' : 'Minimize thread'}
                  onClick={(e) => { e.stopPropagation(); onToggleMinimize() }}>
            {minimized ? <ExpandIcon /> : <MinimizeIcon />}
          </button>
          <button className="icon-btn" title={thread.resolved ? 'Re-open' : 'Resolve'}
                  onClick={act(async () => { await api.resolve(fileId, thread.id, !thread.resolved); if (!thread.resolved) onResolved() })}>
            {thread.resolved ? '↺' : '✓'}
          </button>
          {confirmDelete ? (
            <button className="btn danger tiny" onMouseLeave={() => setConfirmDelete(false)}
                    onClick={act(async () => { await api.deleteThread(fileId, thread.id); onDeleted() })}>Delete?</button>
          ) : (
            <button className="icon-btn" title="Delete thread" onClick={(e) => { e.stopPropagation(); setConfirmDelete(true) }}>🗑</button>
          )}
        </div>
      </div>

      {!mini && visibleMessages(thread.messages, active).map((m) => m.more
        ? <div key="more" className="more-replies">{m.more} more {m.more === 1 ? 'reply' : 'replies'}</div>
        : m.role === 'user'
        ? <UserMsg key={m.id} m={m} />
        : <AiMsg key={m.id} m={m} online={online}
                 onStop={act(() => api.stop(fileId, thread.id, m.id))}
                 onRetry={act(() => api.retry(fileId, thread.id, m.id))} />)}

      {active && (
        <div className="reply" onClick={(e) => e.stopPropagation()}>
          <Composer value={reply} onChange={setReply} onSubmit={sendReply} disabled={sending}
                    placeholder={busy ? 'Reply (queued after the current answer)…' : 'Reply or ask a follow-up…'}
                    autoFocus={false} />
          {sendError && <div className="send-error">Couldn't send: {sendError} <button className="link" onClick={sendReply}>Retry</button></div>}
          {reply.trim() && (
            <div className="composer-actions">
              <button className="btn" onClick={() => setReply('')}>Cancel</button>
              <button className="btn primary" onClick={sendReply} disabled={sending}>{sending ? 'Sending…' : 'Reply'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function DraftCard({ draft, top, onSubmit, onCancel, onTextChange }) {
  const [text, setTextState] = useState(draft.text)
  const setText = (t) => { setTextState(t); onTextChange?.(t) }
  return (
    <div className="card active draft" data-top={top} data-id="__draft">
      <div className="card-head"><Anchor anchor={draft.anchor} snapPng={draft.snapPng} /></div>
      <div className="msg">
        <Avatar who="user" />
        <div className="msg-body">
          <div className="msg-name">You</div>
          <Composer value={text} onChange={setText} onSubmit={() => text.trim() && onSubmit(text.trim())}
                    placeholder="Ask about this…" autoFocus disabled={draft.sending} />
        </div>
      </div>
      {draft.error && <div className="send-error">Couldn't send: {draft.error}. Your comment is kept — press Retry.</div>}
      <div className="composer-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!text.trim() || draft.sending} onClick={() => onSubmit(text.trim())}>
          {draft.sending ? 'Sending…' : draft.error ? 'Retry' : 'Comment'}
        </button>
      </div>
    </div>
  )
}

function MinimizeIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14" /></svg>
}

function ExpandIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
}

// Collapsed (inactive) threads show the first question and the latest reply, like Google Docs.
function visibleMessages(messages, active) {
  if (active || messages.length <= 3) return messages
  return [messages[0], { id: 'more', more: messages.length - 2 }, messages.at(-1)]
}

function Anchor({ anchor, fileId, threadId, snapPng }) {
  if (anchor.type === 'doc') return <div className="anchor doc">Whole document</div>
  if (anchor.type === 'page') {
    const src = snapPng ?? (anchor.image ? api.snapUrl(fileId, threadId) : null)
    return (
      <div className="anchor page">
        {src && <img src={src} alt={`Page ${anchor.page}`} />}
        <span>Page {anchor.page}</span>
      </div>
    )
  }
  if (anchor.type === 'snap') {
    const src = snapPng ?? api.snapUrl(fileId, threadId)
    return <div className="anchor snap"><img src={src} alt={`Snap of page ${anchor.page}`} /><span>p.{anchor.page}</span></div>
  }
  return <div className="anchor quote" title={anchor.quote}>“{anchor.quote.trim()}”</div>
}

export function UserMsg({ m }) {
  return (
    <div className="msg">
      <Avatar who="user" />
      <div className="msg-body">
        <div className="msg-name">You <span className="msg-time">{fmtTime(m.created_at)}</span></div>
        <div className="msg-text plain">{m.text}</div>
      </div>
    </div>
  )
}

export function AiMsg({ m, online, onStop, onRetry }) {
  const status = useContext(AiStatus)
  // A queued question is answered by whichever AI is selected when its turn comes.
  const provider = m.status === 'queued' ? status.provider : m.agent?.provider
  const who = provider === 'openai' ? 'OpenAI' : 'Claude'
  const paused = m.status === 'queued' ? status.paused?.[provider] : null
  let body
  if (m.status === 'queued') {
    body = <div className="ai-state"><span className="spinner" />{!online ? `Offline — ${who} will answer when you’re back online`
      : paused ? `Paused — ${pausedText(paused)}` : `Waiting for ${who}…`}
      <button className="link" onClick={onStop}>Cancel</button></div>
  } else if (m.status === 'answering') {
    body = (
      <>
        {m.text ? <div className="msg-text md"><Markdown>{m.text}</Markdown></div> : null}
        <div className="ai-state"><span className="spinner" />{m.text ? 'Writing…' : (m.activity || 'Thinking…')}
          <button className="btn tiny" onClick={onStop}>■ Stop</button></div>
      </>
    )
  } else {
    body = (
      <>
        {m.text && <div className="msg-text md"><Markdown>{m.text}</Markdown></div>}
        {m.status === 'stopped' && <div className="ai-state muted">Stopped. <button className="link" onClick={onRetry}>Ask again</button></div>}
        {m.status === 'error' && <div className="ai-state error">{who} couldn’t answer: {m.error || 'unknown error'} <button className="link" onClick={onRetry}>Retry</button></div>}
      </>
    )
  }
  return (
    <div className="msg">
      <Avatar who={m.agent?.provider === 'openai' ? 'openai' : 'ai'} />
      <div className="msg-body">
        <div className="msg-name">{who} <span className="msg-time" title={agentLabel(m.agent) ?? ''}>{agentLabel(m.agent) ? `${agentLabel(m.agent)} · ` : ''}{fmtTime(m.created_at)}</span></div>
        {body}
      </div>
    </div>
  )
}

export function Composer({ value, onChange, onSubmit, placeholder, autoFocus, disabled }) {
  const ref = useRef(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  useEffect(() => { // auto-grow
    const el = ref.current
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
  }, [value])
  return (
    <textarea ref={ref} className="composer" rows={1} value={value} placeholder={placeholder} disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit() }
              }} />
  )
}

function Avatar({ who }) {
  if (who === 'ai') return <div className="avatar ai" title="Claude">✳</div>
  if (who === 'openai') return <div className="avatar openai" title="OpenAI">◎</div>
  return <div className="avatar user" title="You">Y</div>
}

function fmtTime(ts) {
  const d = new Date(ts * 1000)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// One-line explanation of why a provider is paused and when it will be tried again.
export function pausedText(p) {
  const at = new Date(p.until * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return p.kind === 'limit' ? `${p.message} Will continue at ${at}, or switch AI in the picker.`
    : p.kind === 'auth' || p.kind === 'missing' ? `${p.message} Questions continue once you're signed in.`
    : `${p.message} Will try again at ${at}.`
}
