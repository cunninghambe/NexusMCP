interface TypingIndicatorProps {
  users: string[]
  visible: boolean
}

export default function TypingIndicator({ users, visible }: TypingIndicatorProps) {
  if (!visible || users.length === 0) return null

  const name =
    users.length === 1
      ? `${users[0]} is typing`
      : `${users.length} people are typing`

  return (
    <div
      style={{
        padding: '4px var(--space-6)',
        fontSize: 12,
        color: 'var(--text-tertiary)',
        minHeight: 24,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
        <span className="typing-dot" style={{ animationDelay: '0ms' }} />
        <span className="typing-dot" style={{ animationDelay: '200ms' }} />
        <span className="typing-dot" style={{ animationDelay: '400ms' }} />
      </span>
      <span>{name}</span>
    </div>
  )
}
