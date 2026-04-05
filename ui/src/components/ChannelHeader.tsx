import { useState, useEffect, useRef, useCallback } from 'react'
import { Channel, User } from '../types'
import Avatar from './Avatar'
import { getChannelMembers, ChannelMember } from '../api/client'

interface ChannelHeaderProps {
  channel: Channel
  users: User[]
  presenceMap?: Record<string, string>
  onSearch?: () => void
  onMenuClick?: () => void
}

// Status dot color for agent/user status values
function statusColor(status: string): string {
  switch (status) {
    case 'running':
    case 'working':
    case 'available':
      return 'var(--accent, #22c55e)'
    case 'idle':
      return 'var(--warning, #f59e0b)'
    case 'busy':
      return '#ef4444'
    case 'offline':
    default:
      return 'var(--text-tertiary, #6b7280)'
  }
}

// Human-readable status label
function statusLabel(status: string): string {
  switch (status) {
    case 'running':   return 'running'
    case 'working':   return 'working'
    case 'available': return 'online'
    case 'idle':      return 'idle'
    case 'busy':      return 'busy'
    case 'offline':   return 'offline'
    default:          return status
  }
}

function MemberListPanel({
  channelId,
  onClose,
}: {
  channelId: string
  onClose: () => void
}) {
  const [members, setMembers] = useState<ChannelMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getChannelMembers(channelId)
      .then((data) => {
        if (!cancelled) {
          setMembers(data)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError('Failed to load members')
          setLoading(false)
          console.error('getChannelMembers error:', err)
        }
      })
    return () => { cancelled = true }
  }, [channelId])

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const agents = members.filter((m) => m.kind === 'agent')
  const users  = members.filter((m) => m.kind === 'user')

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Channel members"
      style={{
        position: 'absolute',
        top: 52,
        right: 12,
        zIndex: 200,
        width: 280,
        maxHeight: 420,
        overflowY: 'auto',
        background: 'var(--bg-elevated, #1e1e2e)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 'var(--radius-lg, 12px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        padding: '12px 0',
      }}
    >
      <div style={{ padding: '0 16px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          Members {!loading && !error && `(${members.length})`}
        </span>
      </div>

      {loading && (
        <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
          Loading…
        </div>
      )}

      {error && (
        <div style={{ padding: '16px', textAlign: 'center', color: '#ef4444', fontSize: 13 }}>
          {error}
        </div>
      )}

      {!loading && !error && members.length === 0 && (
        <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
          No members yet
        </div>
      )}

      {!loading && !error && agents.length > 0 && (
        <MemberSection title="Agents" members={agents} />
      )}

      {!loading && !error && users.length > 0 && (
        <MemberSection title="Users" members={users} />
      )}
    </div>
  )
}

function MemberSection({ title, members }: { title: string; members: ChannelMember[] }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{
        padding: '6px 16px 4px',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-tertiary)',
      }}>
        {title} — {members.length}
      </div>
      {members.map((m) => (
        <MemberRow key={m.membershipId} member={m} />
      ))}
    </div>
  )
}

function MemberRow({ member }: { member: ChannelMember }) {
  const initials = member.name
    .split(' ')
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase()

  const color = statusColor(member.status)
  const label = statusLabel(member.status)
  const isAgent = member.kind === 'agent'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 16px',
        cursor: 'default',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Avatar with status dot */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <div style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: isAgent ? 'rgba(99,102,241,0.25)' : 'rgba(34,197,94,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          color: isAgent ? '#a5b4fc' : '#86efac',
        }}>
          {initials || (isAgent ? 'A' : 'U')}
        </div>
        {/* Status dot */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: color,
          border: '2px solid var(--bg-elevated, #1e1e2e)',
        }} />
      </div>

      {/* Name + status */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {member.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
          {/* Kind badge */}
          <span style={{
            fontSize: 10,
            padding: '1px 5px',
            borderRadius: 4,
            background: isAgent ? 'rgba(99,102,241,0.15)' : 'rgba(34,197,94,0.12)',
            color: isAgent ? '#a5b4fc' : '#86efac',
            fontWeight: 600,
            letterSpacing: '0.03em',
          }}>
            {isAgent ? 'agent' : 'user'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{label}</span>
        </div>
      </div>
    </div>
  )
}

export default function ChannelHeader({
  channel,
  users,
  presenceMap = {},
  onSearch,
  onMenuClick,
}: ChannelHeaderProps) {
  const [showMembers, setShowMembers] = useState(false)

  const userMap = new Map<string, User>()
  for (const u of users) userMap.set(u.id, u)

  const typeIcon = channel.type === 'public' ? '#' : channel.type === 'private' ? '\u{1F512}' : ''

  const toggleMembers = useCallback(() => setShowMembers((v) => !v), [])
  const closeMembers  = useCallback(() => setShowMembers(false), [])

  return (
    <div
      style={{
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 52,
        position: 'relative',
      }}
    >
      {/* Hamburger — only visible on mobile via CSS */}
      {onMenuClick && (
        <button
          className="mobile-header"
          onClick={onMenuClick}
          aria-label="Open sidebar"
          style={{
            display: 'none', /* overridden to flex by .mobile-header media query */
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: 'var(--radius-md)',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
            marginRight: 4,
            padding: 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <rect y="3" width="18" height="2" rx="1" fill="currentColor"/>
            <rect y="8" width="18" height="2" rx="1" fill="currentColor"/>
            <rect y="13" width="18" height="2" rx="1" fill="currentColor"/>
          </svg>
        </button>
      )}

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {typeIcon && (
            <span style={{
              fontSize: 16,
              color: channel.type === 'private' ? 'var(--warning)' : 'var(--text-tertiary)',
            }}>
              {typeIcon}
            </span>
          )}
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>{channel.name}</h2>
        </div>
        {channel.description && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            {channel.description}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {onSearch && (
          <button
            onClick={onSearch}
            title="Search messages (Ctrl+K)"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 'var(--radius-md, 8px)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '6px 10px',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
            }}
          >
            &#x1f50d;
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Ctrl+K</span>
          </button>
        )}

        {/* Member count badge — clickable to open member list */}
        <button
          onClick={toggleMembers}
          aria-expanded={showMembers}
          aria-haspopup="dialog"
          title="Show channel members"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            background: showMembers
              ? 'rgba(99,102,241,0.2)'
              : 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 'var(--radius-md, 8px)',
            color: showMembers ? '#a5b4fc' : 'var(--text-secondary)',
            cursor: 'pointer',
            padding: '5px 10px',
            fontSize: 13,
            fontFamily: 'inherit',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            if (!showMembers) e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
          }}
          onMouseLeave={(e) => {
            if (!showMembers) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
          }}
        >
          {/* People icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {channel.memberCount} members
        </button>

        {/* Member avatars (show up to 3) */}
        <div style={{ display: 'flex', gap: -4, overflow: 'hidden' }}>
          {channel.members.slice(0, 3).map((memberId) => {
            const user = userMap.get(memberId)
            if (!user) return null
            const liveStatus = presenceMap[memberId] || user.status
            return (
              <div key={memberId} style={{ marginLeft: -4 }}>
                <Avatar user={{ ...user, status: liveStatus }} size="sm" showStatus />
              </div>
            )
          })}
          {channel.members.length > 3 && (
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: 'var(--bg-elevated)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-secondary)',
                marginLeft: -4,
                border: '2px solid var(--bg-secondary)',
              }}
            >
              +{channel.members.length - 3}
            </div>
          )}
        </div>
      </div>

      {/* Member list panel (dropdown) */}
      {showMembers && (
        <MemberListPanel
          channelId={channel.id}
          onClose={closeMembers}
        />
      )}
    </div>
  )
}
