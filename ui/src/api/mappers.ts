import type { Channel, Message, User, Reaction } from '../types';
import type { ApiChannel, ApiMessage, ApiBackendAgent, ApiReaction } from './types';

import { getToken } from './client';

function getLoggedInUser(): { id: string; name: string } {
  const token = getToken();
  if (!token) return { id: 'unknown', name: 'Unknown' };
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return { id: payload.sub || 'unknown', name: payload.sub || 'Unknown' };
  } catch {
    return { id: 'unknown', name: 'Unknown' };
  }
}

/** Map a backend agent record to UI User type */
export function mapApiAgent(api: ApiBackendAgent): User {
  return {
    id: api.id,
    name: api.name,
    isAgent: true,
    status: api.status,
    role: undefined,
    lastSeen: new Date(api.updatedAt),
  };
}

/** Map a database channel row to UI Channel type */
export function mapApiChannel(api: ApiChannel): Channel {
  let type: Channel['type'] = 'public';
  switch (api.channelType) {
    case 'private': type = 'private'; break;
    case 'dm': type = 'dm'; break;
    case 'group_dm': type = 'group_dm'; break;
    default: type = 'public';
  }

  return {
    id: api.id,
    name: api.name,
    description: api.description || undefined,
    type,
    memberCount: api.memberCount
      ?? (api.memberships
        ? api.memberships.filter((m) => !m.leftAt).length
        : 0),
    unreadCount: (api as any).unreadCount ?? 0,
    members: api.memberships
      ? api.memberships.filter((m) => !m.leftAt).map((m) => m.agentId || m.userId || '')
      : [],
    lastMessageAt: undefined,
    createdBy: undefined,
  };
}

/** Map a database message row to UI Message type */
export function mapApiMessage(
  api: ApiMessage,
  senderUser?: User | undefined,
): Message {
  const senderId = api.senderAgentId || api.senderUserId || 'unknown';
  const senderName = api.senderAgentId
    ? (api as any).senderAgentName || 'Agent'
    : api.senderUserId || 'Unknown';
  const sender: User = senderUser || {
    id: senderId,
    name: senderName.charAt(0).toUpperCase() + senderName.slice(1),
    isAgent: !!api.senderAgentId,
    status: 'available',
  }

  // Map reactions if included in the API response (now attached by backend)
  const rawReactions = (api as any).reactions as ApiReaction[] | undefined
  const reactions: Reaction[] = rawReactions
    ? rawReactions.map((r) => ({
        emoji: r.emoji,
        count: r.count,
        users: [...(r.agentIds || []), ...(r.userIds || [])],
      }))
    : []

  return {
    id: api.id,
    channelId: api.channelId,
    sender,
    content: api.content || '',
    timestamp: new Date(api.createdAt),
    parentId: api.parentId || undefined,
    reactions,
    threadCount: api.replyCount > 0 ? api.replyCount : undefined,
    isStructured: api.messageType === 'structured',
    structuredData: (api.structuredPayload || undefined) as Record<string, string | number> | undefined,
  }
}

/** The current user / actor for the frontend */
export function getCurrentActor(): User {
  const user = getLoggedInUser();
  return {
    id: user.id,
    name: user.name.charAt(0).toUpperCase() + user.name.slice(1),
    isAgent: false,
    status: 'available',
  };
}

export const currentActor: User = getCurrentActor();
