import { useState, useCallback, useEffect, useRef, useLayoutEffect } from 'react'
import { Channel, Message } from '../types'
import SearchModal from './SearchModal'
import ChannelSidebar from './ChannelSidebar'
import ChannelHeader from './ChannelHeader'
import MessageBubble from './MessageBubble'
import MessageComposer from './MessageComposer'
import ThreadView from './ThreadView'
import CreateChannelModal from './CreateChannelModal'
import DateSeparator from './DateSeparator'
import AgentPicker from './AgentPicker'
import TypingIndicator from './TypingIndicator'
import { useThread } from '../hooks/useMessages'
import { sendMessage as apiSendMessage, createDM as apiCreateDM } from '../api/client'
import { currentActor } from '../api/mappers'
import type { WSConnectionState } from '../hooks/useWebSocket'

interface SlackAppProps {
  channels: Channel[]
  messages: Message[]
  activeChannelId: string | null
  activeChannel: Channel | null
  loadingMessages: boolean
  typingUsers: string[]
  userNames: Record<string, string>
  presenceMap: Record<string, string>
  connectionState: WSConnectionState
  onChannelSelect: (channelId: string) => void
  onCreateChannel: (name: string, description: string, type: 'public' | 'private') => Promise<Channel>
  onSendMessage: (content: string) => Promise<Message | undefined>
  onReaction: (messageId: string, emoji: string) => void
  onUserTyping?: () => void
  setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>
  setChannels?: React.Dispatch<React.SetStateAction<Channel[]>>
}

export default function SlackApp({
  channels,
  messages,
  activeChannelId,
  activeChannel,
  loadingMessages,
  typingUsers,
  userNames,
  presenceMap,
  connectionState,
  onChannelSelect,
  onCreateChannel,
  onSendMessage,
  onReaction,
  onUserTyping,
  setMessages,
  setChannels,
}: SlackAppProps) {
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { openThread, loading: threadLoading, open: openThreadFn, close: closeThreadFn, setOpenThread } = useThread()

  // ── Auto-scroll logic ──────────────────────────────────────────
  const messageListRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const prevMessageCountRef = useRef(0)

  // Track whether user is near the bottom of the scroll container
  const handleScroll = useCallback(() => {
    const el = messageListRef.current
    if (!el) return
    const threshold = 150
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    isNearBottomRef.current = nearBottom
    if (nearBottom) setHasNewMessages(false)
  }, [])

  // Auto-scroll to bottom when messages change, if user was near bottom
  useLayoutEffect(() => {
    const el = messageListRef.current
    if (!el) return
    const newCount = messages.length
    const hadMessages = prevMessageCountRef.current > 0

    if (isNearBottomRef.current || !hadMessages) {
      el.scrollTop = el.scrollHeight
      setHasNewMessages(false)
    } else if (newCount > prevMessageCountRef.current) {
      setHasNewMessages(true)
    }
    prevMessageCountRef.current = newCount
  }, [messages])

  // Scroll to bottom when switching channels
  useEffect(() => {
    isNearBottomRef.current = true
    setHasNewMessages(false)
    prevMessageCountRef.current = 0
    const el = messageListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeChannelId])

  const scrollToBottom = useCallback(() => {
    const el = messageListRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
      isNearBottomRef.current = true
      setHasNewMessages(false)
    }
  }, [])

  // Keyboard shortcut: Ctrl+K / Cmd+K opens search modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setShowSearch(prev => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Group messages: collapse consecutive messages from same sender
  // Also insert date separators when messages span different days
  const groupedMessages = messages.map((msg, i) => {
    const prev = messages[i - 1]
    const isGrouped = prev && prev.sender.id === msg.sender.id
    // Check if we need a date separator
    let dateSeparator = ''
    if (!isGrouped && prev) {
      const prevDay = new Date(prev.timestamp).toDateString()
      const currDay = new Date(msg.timestamp).toDateString()
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(yesterday.getDate() - 1)

      if (currDay === now.toDateString()) {
        dateSeparator = 'Today'
      } else if (currDay === yesterday.toDateString()) {
        dateSeparator = 'Yesterday'
      } else {
        dateSeparator = new Date(msg.timestamp).toLocaleDateString(undefined, {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      }
    }

    return { msg, grouped: !!isGrouped, dateSeparator }
  })

  // Thread handling
  const handleThreadClick = useCallback(async (messageId: string) => {
    if (!activeChannel) return
    try {
      openThreadFn(messageId, activeChannelId!)
    } catch (err) {
      console.error('Failed to fetch thread:', err)
    }
  }, [activeChannel, activeChannelId, openThreadFn])

  const handleThreadMessage = useCallback(async (content: string) => {
    if (!openThread || !activeChannel) return
    try {
      const newReply = await apiSendMessage(activeChannel.id, content, openThread.parentId)
      // Update parent message reply count and append to messages list
      setMessages((prev) => {
        const channelMsgs = prev[openThread.channelId]
        if (channelMsgs) {
          const updated = channelMsgs.map((m) =>
            m.id === openThread.parentId
              ? { ...m, threadCount: (m.threadCount || 0) + 1 }
              : m
          )
          return {
            ...prev,
            [openThread.channelId]: [...updated, newReply],
          }
        }
        return prev
      })
      // Update local thread state
      setOpenThread((prev) => prev ? { ...prev, replies: [...prev.replies, newReply] } : null)
    } catch (err) {
      console.error('Failed to send thread message:', err)
    }
  }, [openThread, activeChannel, setMessages, setOpenThread])

  // Send message
  const handleSend = useCallback(async (content: string) => {
    if (!activeChannelId) return
    try {
      await onSendMessage(content)
    } catch (err) {
      console.error('Failed to send message:', err)
    }
  }, [activeChannelId, onSendMessage])

  // Create channel
  const handleCreateChannel = useCallback(async (name: string, description: string, type: 'public' | 'private') => {
    setCreatingChannel(true)
    try {
      await onCreateChannel(name, description, type)
      setShowCreateChannel(false)
    } catch (err) {
      console.error('Failed to create channel:', err)
    } finally {
      setCreatingChannel(false)
    }
  }, [onCreateChannel])

  // Start a DM with an agent
  const handleSelectAgent = useCallback(async (targetAgentId: string) => {
    setShowAgentPicker(false)
    try {
      const dmChannel = await apiCreateDM(targetAgentId)
      setChannels?.((prev) => [...prev, dmChannel])
      onChannelSelect(dmChannel.id)
    } catch (err) {
      console.error('Failed to create/find DM:', err)
    }
  }, [onChannelSelect, setChannels])

  // Reaction
  const handleReactionClick = useCallback(async (messageId: string, emoji: string) => {
    onReaction(messageId, emoji)
  }, [onReaction])

  // Map thread messages for display
  const threadReplies = openThread && activeChannel
    ? [...openThread.replies]
    : []
  const threadParent = openThread && activeChannel
    ? messages.find((m) => m.id === openThread.parentId)
    : null

  const handleMenuClick = useCallback(() => {
    setSidebarOpen(true)
    setSidebarCollapsed(false)
  }, [])

  const handleChannelSelect = useCallback((channelId: string) => {
    onChannelSelect(channelId)
    setSidebarOpen(false)
  }, [onChannelSelect])

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      {/* Mobile sidebar overlay — only rendered when sidebar is open on mobile */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <ChannelSidebar
        className={`sidebar${sidebarOpen ? ' open' : ''}`}
        channels={channels}
        users={[currentActor]}
        activeChannelId={activeChannelId}
        onChannelSelect={handleChannelSelect}
        onCreateChannel={() => setShowCreateChannel(true)}
        onOpenDM={() => setShowAgentPicker(true)}
        presenceMap={presenceMap}
        userNames={userNames}
        collapsed={sidebarCollapsed}
        onCollapse={() => setSidebarCollapsed(true)}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
        {activeChannel ? (
          <>
            <ChannelHeader
              channel={activeChannel}
              users={[currentActor]}
              presenceMap={presenceMap}
              onSearch={() => setShowSearch(true)}
              onMenuClick={handleMenuClick}
              sidebarCollapsed={sidebarCollapsed}
            />

            {/* Message list */}
            <div
              ref={messageListRef}
              onScroll={handleScroll}
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 'var(--space-4) 0',
                position: 'relative',
              }}
            >
              {loadingMessages ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)' }}>
                  Loading messages...
                </div>
              ) : groupedMessages.length === 0 ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <div style={{ fontSize: 48, marginBottom: 16 }}>
                    {'\u{1F4AC}'}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
                    Welcome to #{activeChannel.name}!
                  </div>
                  <div style={{ fontSize: 14 }}>
                    {activeChannel.description || 'This is the start of the channel.'}
                  </div>
                </div>
              ) : (
                <>
                  {groupedMessages.map(({ msg: m, grouped: g, dateSeparator: ds }, idx) => (
                    <div key={m.id}>
                      {ds && <DateSeparator label={ds} />}
                      <MessageBubble
                        message={m}
                        groupedWithPrevious={g}
                        onThreadClick={() => handleThreadClick(m.id)}
                        onReaction={handleReactionClick}
                        onReplyClick={() => handleThreadClick(m.id)}
                      />
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* New messages indicator */}
            {hasNewMessages && (
              <button
                onClick={scrollToBottom}
                style={{
                  position: 'absolute',
                  bottom: 120,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 20,
                  padding: '6px 16px',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  zIndex: 10,
                  boxShadow: 'var(--shadow-md)',
                }}
              >
                {'\u2193'} New messages
              </button>
            )}

            {/* Typing indicator */}
            <TypingIndicator users={typingUsers} visible={typingUsers.length > 0} />

            {/* Connection state indicator */}
            {connectionState === 'disconnected' && (
              <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--warning)', padding: '2px 0' }}>
                Disconnected — attempting to reconnect...
              </div>
            )}

            {/* Message input */}
            <div
              style={{
                borderTop: '1px solid rgba(255,255,255,0.06)',
                padding: 'var(--space-4) var(--space-4)',
              }}
            >
              <MessageComposer
                channelName={activeChannel.name}
                onSend={handleSend}
                onTyping={onUserTyping}
                disabled={sendingMessage}
              />
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            {/* Mobile-only top bar so the hamburger is always reachable */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                minHeight: 52,
              }}
            >
              <button
                className="mobile-header"
                onClick={handleMenuClick}
                aria-label="Open sidebar"
                style={{
                  display: sidebarCollapsed ? 'flex' : 'none',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: 'var(--radius-md)',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <rect y="3" width="18" height="2" rx="1" fill="currentColor"/>
                  <rect y="8" width="18" height="2" rx="1" fill="currentColor"/>
                  <rect y="13" width="18" height="2" rx="1" fill="currentColor"/>
                </svg>
              </button>
            </div>
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              Select a channel or create one to get started
            </div>
          </div>
        )}
      </div>

      {/* Thread panel */}
      {openThread && activeChannel && threadParent && (
        <ThreadView
          parentMessage={threadParent}
          replies={threadReplies}
          channel={activeChannel}
          currentUserId={currentActor.id}
          onClose={closeThreadFn}
          onSendMessage={handleThreadMessage}
        />
      )}

      {/* Create channel modal */}
      {showCreateChannel && (
        <CreateChannelModal
          onClose={() => setShowCreateChannel(false)}
          onSubmit={handleCreateChannel}
          loading={creatingChannel}
        />
      )}

      {/* Agent picker modal for DM */}
      {showAgentPicker && (
        <AgentPicker
          currentAgentId={currentActor.id}
          onSelect={handleSelectAgent}
          onClose={() => setShowAgentPicker(false)}
        />
      )}

      {/* Search modal */}
      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          onSelectChannel={(channelId) => {
            onChannelSelect(channelId)
            setShowSearch(false)
          }}
          activeChannelId={activeChannelId}
        />
      )}
    </div>
  )
}
