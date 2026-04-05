import { Channel, User } from '../types'
import StatusDot from './StatusDot'
import Avatar from './Avatar'

interface SidebarProps {
  channels: Channel[]
  users: User[]
  activeChannelId: string | null
  onChannelSelect: (channelId: string) => void
  onCreateChannel: () => void
  onOpenDM?: () => void
  presenceMap?: Record<string, string>
  userNames?: Record<string, string>
  className?: string
  collapsed?: boolean
  onCollapse?: () => void
}

export default function ChannelSidebar({
  channels,
  users,
  activeChannelId,
  onChannelSelect,
  onCreateChannel,
  onOpenDM,
  presenceMap = {},
  userNames = {},
  className,
  collapsed = false,
  onCollapse,
}: SidebarProps) {
  const publicChannels = channels.filter((c) => c.type === 'public')
  const privateChannels = channels.filter((c) => c.type === 'private')
  const dmChannels = channels.filter((c) => c.type === 'dm' || c.type === 'group_dm')

  // Build user lookup for DMs
  const userMap = new Map<string, User>()
  for (const u of users) userMap.set(u.id, u)

  function getDMUser(channel: Channel): User | undefined {
    // Find the other member besides self
    const otherId = channel.members.find((m) => m !== 'current-user')
    if (!otherId) return undefined
    const baseUser = userMap.get(otherId)
    if (!baseUser) {
      // Fallback: create from presence data
      const name = userNames[otherId] || otherId.slice(0, 8)
      const status = presenceMap[otherId] || 'offline'
      return { id: otherId, name, isAgent: true, status }
    }
    // Override status with presence if available
    const liveStatus = presenceMap[otherId]
    if (liveStatus && liveStatus !== baseUser.status) {
      return { ...baseUser, status: liveStatus }
    }
    return baseUser
  }

  const typeIcon = (channel: Channel) => {
    if (channel.type === 'public') return '#'
    if (channel.type === 'private') return '\u{1F512}'
    if (channel.type === 'dm') return ''
    return '\u{1F465}'
  }

  const renderChannelItem = (channel: Channel) => {
    const isActive = channel.id === activeChannelId
    const isDM = channel.type === 'dm' || channel.type === 'group_dm'
    const dmUser = isDM ? getDMUser(channel) : undefined

    const baseStyle: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      height: 32,
      padding: '0 var(--space-2)',
      borderRadius: 'var(--radius-sm)',
      cursor: 'pointer',
      gap: 6,
      transition: 'background 0.1s',
      borderLeft: isActive ? '3px solid var(--accent-primary)' : '3px solid transparent',
      paddingLeft: isActive ? 'calc(var(--space-2) - 3px)' : 'var(--space-2)',
      background: isActive ? 'rgba(99,102,241,0.15)' : 'transparent',
    }

    const nameStyle: React.CSSProperties = {
      fontSize: 14,
      fontWeight: channel.unreadCount > 0 || isActive ? 500 : 400,
      color: channel.unreadCount > 0 || isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      flex: 1,
    }

    return (
      <div
        key={channel.id}
        style={baseStyle}
        onClick={() => onChannelSelect(channel.id)}
        onMouseEnter={(e) => {
          if (!isActive) (e.currentTarget.style.background = 'rgba(99,102,241,0.08)')
        }}
        onMouseLeave={(e) => {
          if (!isActive) (e.currentTarget.style.background = 'transparent')
        }}
      >
        <span style={{ fontSize: 14, color: channel.type === 'private' ? 'var(--warning)' : 'var(--text-tertiary)', width: 16, textAlign: 'center', flexShrink: 0 }}>
          {isDM ? '' : typeIcon(channel)}
        </span>
        {dmUser && (
          <Avatar user={dmUser} size="sm" showStatus />
        )}
        <span style={nameStyle}>{channel.name}</span>
        {channel.unreadCount > 0 && (
          <span
            style={{
              background: 'var(--accent-primary)',
              color: 'white',
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 'var(--radius-full)',
              padding: '0 6px',
              minWidth: 18,
              height: 18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {channel.unreadCount}
          </span>
        )}
      </div>
    )
  }

  const Section = ({ title, items }: { title: string; items: Channel[] }) => (
    <div style={{ marginBottom: 'var(--space-3)' }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          padding: 'var(--space-2) var(--space-2)',
        }}
      >
        {title}
      </div>
      {items.map(renderChannelItem)}
    </div>
  )

  return (
    <div
      className={className}
      style={{
        width: collapsed ? 0 : 260,
        minWidth: collapsed ? 0 : 260,
        height: '100%',
        background: 'var(--bg-secondary)',
        borderRight: collapsed ? 'none' : '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 0.25s ease, min-width 0.25s ease',
      }}
    >
      <div
        style={{
          padding: 'var(--space-4)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h2
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          AI Workspace
        </h2>
        {onCollapse && (
          <button
            className="sidebar-collapse-btn"
            onClick={onCollapse}
            title="Collapse sidebar"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: 4,
              fontSize: 16,
              lineHeight: 1,
              borderRadius: 'var(--radius-sm)',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            &#x00AB;
          </button>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--space-3) 0',
        }}
      >
        {publicChannels.length > 0 && <Section title="Channels" items={publicChannels} />}
        {privateChannels.length > 0 && <Section title="Private" items={privateChannels} />}
        {dmChannels.length > 0 && <Section title="Direct Messages" items={dmChannels} />}
      </div>

      <div
        style={{
          borderTop: '1px solid rgba(255,255,255,0.06)',
          padding: 'var(--space-3)',
        }}
      >
        <button
          onClick={onCreateChannel}
          style={{
            width: '100%',
            padding: 'var(--space-2) var(--space-3)',
            background: 'transparent',
            color: 'var(--accent-primary)',
            border: '1px dashed rgba(99,102,241,0.3)',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: 13,
            fontFamily: 'var(--font-sans)',
            marginBottom: 'var(--space-2)',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(99,102,241,0.08)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          + New Channel
        </button>
        {onOpenDM && (
          <button
            onClick={onOpenDM}
            style={{
              width: '100%',
              padding: 'var(--space-2) var(--space-3)',
              background: 'transparent',
              color: 'var(--accent-primary)',
              border: '1px dashed rgba(99,102,241,0.3)',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: 13,
              fontFamily: 'var(--font-sans)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(99,102,241,0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            + New DM
          </button>
        )}
      </div>
    </div>
  )
}
