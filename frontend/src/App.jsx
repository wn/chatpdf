import { Component, useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import Viewer from './Viewer.jsx'
import { Chevron } from './DocChat.jsx'
import { useStored } from './storage.js'

export default function App() {
  const [files, setFiles] = useState([])
  const [fileId, setFileId] = useState(() => location.hash.slice(1) || null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [libCollapsed, setLibCollapsed] = useStored('pdfa:libraryCollapsed', false)
  const inputRef = useRef(null)

  const refresh = useCallback(() => api.listFiles().then(setFiles).catch((e) => setError(e.message)), [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { history.replaceState(null, '', fileId ? `#${fileId}` : location.pathname) }, [fileId])

  async function upload(file) {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const meta = await api.upload(file)
      await refresh()
      setFileId(meta.file_id)
    } catch (e) {
      setError(`Upload failed: ${e.message}`)
    } finally {
      setUploading(false)
    }
  }

  async function remove(id) {
    await api.deleteFile(id)
    if (id === fileId) setFileId(null)
    setConfirmDelete(null)
    refresh()
  }

  const current = files.find((f) => f.file_id === fileId)

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files[0]) }}
    >
      {libCollapsed ? (
        <aside className="side-strip left">
          <button className="icon-btn" title="Show PDF list" onClick={() => setLibCollapsed(false)}><Chevron dir="right" /></button>
          <button className="icon-btn" title="Upload PDF" onClick={() => inputRef.current.click()}>+</button>
        </aside>
      ) : (
      <aside className="library">
        <div className="brand">
          <span className="brand-mark">◧</span> PDF Analyzer
          <button className="icon-btn collapse" title="Minimize PDF list" onClick={() => setLibCollapsed(true)}><Chevron dir="left" /></button>
        </div>
        <button className="btn primary upload" onClick={() => inputRef.current.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : '+ Upload PDF'}
        </button>
        {error && <div className="lib-error">{error}</div>}
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.file_id} className={f.file_id === fileId ? 'active' : ''} onClick={() => setFileId(f.file_id)}>
              <span className="file-icon">PDF</span>
              <span className="file-meta">
                <span className="file-name" title={f.name}>{f.name}</span>
                <span className="file-sub">
                  {f.open_count ? `${f.open_count} open comment${f.open_count > 1 ? 's' : ''}` : 'No open comments'}
                </span>
              </span>
              {confirmDelete === f.file_id ? (
                <button className="btn danger tiny" onClick={(e) => { e.stopPropagation(); remove(f.file_id) }}
                        onMouseLeave={() => setConfirmDelete(null)}>Delete?</button>
              ) : (
                <button className="icon-btn file-del" title="Delete PDF"
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(f.file_id) }}>✕</button>
              )}
            </li>
          ))}
          {!files.length && <li className="empty">No PDFs yet. Upload one or drop it anywhere.</li>}
        </ul>
      </aside>
      )}
      <input ref={inputRef} type="file" accept="application/pdf" hidden
             onChange={(e) => { upload(e.target.files[0]); e.target.value = '' }} />
      <main className="main">
        {current ? (
          <ViewerBoundary key={current.file_id}>
            <Viewer file={current} onThreadsChanged={refresh} />
          </ViewerBoundary>
        ) : (
          <div className="placeholder">
            <div className="placeholder-card">
              <h2>Ask Claude about any PDF</h2>
              <p>Upload a PDF, highlight text (or use <b>Snap</b> to box a region), and leave a comment.
                Claude replies right in the comment thread.</p>
              <button className="btn primary" onClick={() => inputRef.current.click()}>Upload PDF</button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

class ViewerBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error) { console.error('viewer crashed', error) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="placeholder">
        <div className="placeholder-card">
          <h2>Something went wrong showing this PDF</h2>
          <p>{String(this.state.error?.message || this.state.error)}</p>
          <button className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    )
  }
}
