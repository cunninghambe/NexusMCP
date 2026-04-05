import React, { useState, useCallback } from 'react'
import Avatar from './Avatar'
import EmojiPicker from './EmojiPicker'
import ToolCallBlock from './ToolCallBlock'
import MessageToolbar from './MessageToolbar'
import { Message } from '../types'
import { formatTimeAgo, formatTimestamp } from '../utils'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeBlock from './CodeBlock'

/**
 * Walk a React children tree and highlight any @mention tokens inside text nodes.
 * Non-string children are passed through untouched.
 */
function renderWithMentions(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child !== 'string') return child
    // Split on @mentions, keeping the delimiter in the array
    const parts = child.split(/(@[a-zA-Z0-9_-]+)/g)
    if (parts.length === 1) return child
    return parts.map((part, i) => {
      if (/^@[a-zA-Z0-9_-]+$/.test(part)) {
        return (
          <span
            key={i}
            style={{
              background: 'rgba(99,102,241,0.18)',
              color: 'var(--accent-primary, #6366f1)',
              borderRadius: 4,
              padding: '0 3px',
              fontWeight: 600,
              fontSize: '0.95em',
            }}
          >
            {part}
          </span>
        )
      }
      return part
    })
  })
}

interface MessageBubbleProps {
  message: Message
  groupedWithPrevious: boolean
  onThreadClick?: () => void
  onReaction?: (messageId: string, emoji: string) => void
  onReplyClick?: () => void
  currentUserId?: string
}

export default function MessageBubble({ message, groupedWithPrevious, onThreadClick, onReaction, onReplyClick, currentUserId }: MessageBubbleProps) {
  const isAgent = message.sender.isAgent
  const [showPicker, setShowPicker] = useState(false)
  const [hovering, setHovering] = useState(false)

  const avatar = !groupedWithPrevious ? (
    <div style={{ width: 36, marginRight: 12, paddingTop: 2 }}>
      <Avatar user={message.sender} size="md" showStatus />
    </div>
  ) : (
    <div style={{ width: 36, marginRight: 12 }} />
  )

  const bgStyle = isAgent ? { background: 'var(--agent-bg)', borderRadius: 'var(--radius-md)', padding: 'var(--space-2)', borderLeft: '2px solid var(--agent-border)' } : {}

  const handleReactionSelect = useCallback((emoji: string) => {
    setShowPicker(false)
    if (onReaction) {
      onReaction(message.id, emoji)
    }
  }, [onReaction, message.id])

  const handleReactionClick = useCallback((emoji: string) => {
    if (onReaction) {
      // Toggle: if user already reacted with this emoji, send it again to remove; otherwise to add
      onReaction(message.id, emoji)
    }
  }, [onReaction, message.id])

  // Check if current user already reacted with a given emoji
  const userReacted = useCallback((r: Message['reactions'][0]) => {
    if (!currentUserId) return false
    return r.users.includes(currentUserId)
  }, [currentUserId])

  return (
    <article
      role="article"
      aria-label={`Message from ${message.sender.name} at ${formatTimestamp(message.timestamp)}: ${message.content?.substring(0, 80) ?? 'No text content'}`}
      data-message-id={message.id}
      style={{
        display: 'flex',
        padding: groupedWithPrevious ? '2px var(--space-6)' : 'var(--space-4) var(--space-6) var(--space-2)',
        gap: 0,
        transition: 'background 0.1s',
        ...bgStyle,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = isAgent ? 'var(--agent-bg)' : 'rgba(255,255,255,0.02)'
        setHovering(true)
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isAgent ? 'var(--agent-bg)' : 'transparent'
        setHovering(false)
      }}
    >
      {avatar}

      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {hovering && (onReplyClick || onReaction) && (
          <MessageToolbar
            onReply={() => onReplyClick?.()}
            onReact={() => setShowPicker((p) => !p)}
          />
        )}
        {!groupedWithPrevious && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              {message.sender.name}
            </span>
            <time style={{ fontSize: 12, color: 'var(--text-tertiary)' }} title={formatTimestamp(message.timestamp)}>
              {formatTimeAgo(message.timestamp)}
            </time>
          </div>
        )}

        {/* Structured data block */}
        {message.isStructured && message.structuredData && (
          <div
            style={{
              background: 'var(--structured-bg)',
              border: '1px solid var(--structured-border)',
              borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-4)',
              marginBottom: 'var(--space-2)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 'var(--space-3)', color: 'var(--text-primary)' }}>
              {'\\uD83D\\uDCCA'} {message.sender.name} — Summary
            </div>
            {Object.entries(message.structuredData).map(([key, value]) => (
              <div
                key={key}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  padding: 'var(--space-1) 0',
                  gap: 'var(--space-4)',
                }}
              >
                <span>{key}:</span>
                <span style={{ color: 'var(--text-primary)' }}>{String(value)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.map((tc) => (
          <ToolCallBlock key={tc.id} toolCall={tc} agentName={message.sender.name} />
        ))}

        {/* Text content - Markdown */}
        {message.content && (
          <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-primary)' }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ inline, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '')
                  if (!inline && match) {
                    return <CodeBlock language={match[1]}>{String(children).replace(/\n$/, '')}</CodeBlock>
                  }
                  return <code className={className} {...props}>{children}</code>
                },
                pre({ children }) {
                  return <>{children}</>
                },
                // Render @mentions with a highlighted chip
                p({ children }) {
                  return <p>{renderWithMentions(children)}</p>
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}

        {/* Reactions */}
        {message.reactions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'var(--space-2)', alignItems: 'center' }}>
            {message.reactions.map((r, idx) => (
              <button
                key={idx}
                role="button"
                aria-label={`${r.count} ${r.emoji} reactions`}
                style={{
                  background: userReacted(r) ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
                  border: userReacted(r) ? '1px solid var(--accent, #4a9eff)' : '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 12,
                  padding: '2px 8px',
                  fontSize: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = userReacted(r) ? 'var(--accent, #4a9eff)' : 'rgba(255,255,255,0.08)')}
                onClick={() => handleReactionClick(r.emoji)}
              >
                <span>{r.emoji}</span>
                <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{r.count}</span>
              </button>
            ))}
          </div>
        )}
        {/* Emoji picker (shown via toolbar) */}
        {showPicker && (
          <div style={{ position: 'relative' }}>
            <EmojiPicker onSelect={handleReactionSelect} onClose={() => setShowPicker(false)} />
          </div>
        )}
        {/* Thread link */}
        {message.threadCount && message.threadCount > 0 && (
          <button
            onClick={onThreadClick}
            aria-label={`View thread with ${message.threadCount} ${message.threadCount === 1 ? 'reply' : 'replies'}`}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--accent-primary)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
              padding: 'var(--space-1) 0',
              marginTop: 'var(--space-1)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {message.threadCount} {message.threadCount === 1 ? 'reply' : 'replies'} — View thread {'\u2192'}
          </button>
        )}
      </div>
    </article>
  )
}
