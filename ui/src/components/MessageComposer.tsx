import { useState, useRef, useEffect, useCallback } from 'react'
import { getMentionables, Mentionable } from '../api/client'

interface MessageComposerProps {
  channelName: string
  placeholder?: string
  onSend: (content: string) => void
  onTyping?: () => void
  disabled?: boolean
}

export default function MessageComposer({ channelName, placeholder, onSend, onTyping, disabled }: MessageComposerProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Autocomplete state
  const [mentionables, setMentionables] = useState<Mentionable[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  // Filtered list based on current @query
  const filtered = mentionQuery !== null
    ? mentionables.filter((m) =>
        m.handle.toLowerCase().startsWith(mentionQuery.toLowerCase()) ||
        m.displayName.toLowerCase().includes(mentionQuery.toLowerCase())
      ).slice(0, 8)
    : []

  // Load mentionables once on mount
  useEffect(() => {
    getMentionables()
      .then(setMentionables)
      .catch(() => { /* non-critical */ })
  }, [])

  // Reset active index when dropdown contents change
  useEffect(() => {
    setActiveIndex(0)
  }, [mentionQuery])

  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    setDropdownOpen(false)
    setMentionQuery(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (dropdownOpen && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % filtered.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(filtered[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        setDropdownOpen(false)
        setMentionQuery(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  /**
   * Detect whether the cursor is currently inside an @mention token.
   * Returns the partial handle being typed (after @), or null if not in a mention.
   */
  const detectMentionAtCursor = useCallback((value: string, cursorPos: number): string | null => {
    // Walk backwards from cursor to find a potential @mention start
    let i = cursorPos - 1
    while (i >= 0 && /[a-zA-Z0-9_-]/.test(value[i])) {
      i--
    }
    if (i >= 0 && value[i] === '@') {
      // Make sure it's not mid-word (char before @ should be space, newline, or start of string)
      if (i === 0 || /[\s\n]/.test(value[i - 1])) {
        return value.slice(i + 1, cursorPos)
      }
    }
    return null
  }, [])

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setText(newValue)

    // Auto-resize
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    }

    // Notify parent that user is typing
    if (onTyping && newValue.length > 0) {
      onTyping()
    }

    // Detect @mention
    const cursorPos = e.target.selectionStart ?? newValue.length
    const query = detectMentionAtCursor(newValue, cursorPos)
    if (query !== null) {
      setMentionQuery(query)
      setDropdownOpen(true)
    } else {
      setMentionQuery(null)
      setDropdownOpen(false)
    }
  }

  /**
   * Replace the @partial-handle at the cursor with @handle followed by a space.
   */
  const insertMention = useCallback((m: Mentionable) => {
    const el = textareaRef.current
    if (!el) return

    const cursorPos = el.selectionStart ?? text.length
    let i = cursorPos - 1
    while (i >= 0 && /[a-zA-Z0-9_-]/.test(text[i])) {
      i--
    }
    // i should be pointing at '@'
    const mentionStart = i  // position of '@'

    const before = text.slice(0, mentionStart)
    const after = text.slice(cursorPos)
    const newText = `${before}@${m.handle} ${after}`
    setText(newText)
    setDropdownOpen(false)
    setMentionQuery(null)

    // Restore focus and move cursor to after the inserted mention + space
    requestAnimationFrame(() => {
      if (el) {
        el.focus()
        const newCursor = before.length + m.handle.length + 2 // "@handle "
        el.setSelectionRange(newCursor, newCursor)
        // Re-run auto-resize
        el.style.height = 'auto'
        el.style.height = Math.min(el.scrollHeight, 200) + 'px'
      }
    })
  }, [text])

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
        {channelName.startsWith('#') ? channelName : `#${channelName}`}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || `Message #${channelName}...`}
          disabled={disabled}
          rows={1}
          style={{
            flex: 1,
            background: 'var(--bg-input)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-3) var(--space-4)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-sans)',
            fontSize: 14,
            lineHeight: 1.6,
            minHeight: 44,
            resize: 'none',
            outline: 'none',
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--accent-primary)')}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
            // Delay closing so click on dropdown item registers first
            setTimeout(() => setDropdownOpen(false), 150)
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={!text.trim()}
          style={{
            background: text.trim() ? 'var(--accent-primary)' : 'rgba(99,102,241,0.3)',
            color: 'white',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            padding: '0 var(--space-4)',
            height: 44,
            cursor: text.trim() ? 'pointer' : 'not-allowed',
            fontWeight: 500,
            fontSize: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            fontFamily: 'var(--font-sans)',
            transition: 'background 0.15s',
          }}
        >
          Send {'\u25B6'}
        </button>
      </div>

      {/* @mention autocomplete dropdown */}
      {dropdownOpen && filtered.length > 0 && (
        <div
          role="listbox"
          aria-label="Mention suggestions"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            right: 48,
            marginBottom: 4,
            background: 'var(--bg-secondary, #1e1e2e)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            overflow: 'hidden',
            zIndex: 100,
          }}
        >
          {filtered.map((m, idx) => (
            <button
              key={m.id}
              role="option"
              aria-selected={idx === activeIndex}
              onMouseDown={(e) => {
                // Use mousedown so it fires before onBlur on textarea
                e.preventDefault()
                insertMention(m)
              }}
              onMouseEnter={() => setActiveIndex(idx)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '8px 12px',
                background: idx === activeIndex ? 'rgba(99,102,241,0.2)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'var(--font-sans)',
                transition: 'background 0.1s',
              }}
            >
              {/* Kind badge */}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 5px',
                  borderRadius: 4,
                  background: m.kind === 'agent' ? 'rgba(99,102,241,0.3)' : 'rgba(34,197,94,0.2)',
                  color: m.kind === 'agent' ? 'var(--accent-primary, #6366f1)' : '#22c55e',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  flexShrink: 0,
                }}
              >
                {m.kind === 'agent' ? 'AI' : 'User'}
              </span>
              {/* Display name */}
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>
                {m.displayName}
              </span>
              {/* Handle */}
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 2 }}>
                @{m.handle}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
