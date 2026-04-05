/// <reference types="vite/client" />

import type {
  Channel,
  FileAttachment,
  Message,
  User,
} from '../types';
import type { ApiChannel, ApiMessage } from './types';
import { mapApiChannel, mapApiMessage } from './mappers';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export function getToken(): string | null {
  return localStorage.getItem('nexus-token');
}

export function setToken(token: string): void {
  localStorage.setItem('nexus-token', token);
}

export function clearToken(): void {
  localStorage.removeItem('nexus-token');
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export async function login(username: string): Promise<{ token: string; user: { id: string; name: string } }> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(body.error || 'Login failed');
  }
  const data = await res.json();
  setToken(data.token);
  return data;
}

export async function getChannels(): Promise<Channel[]> {
  const res = await fetch(`${API_BASE}/channels`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch channels: ${res.status}`);
  const data: ApiChannel[] = await res.json();
  return data.map((c) => mapApiChannel(c));
}

export async function createChannel(
  name: string,
  description: string,
  type: 'public' | 'private',
): Promise<Channel> {
  const res = await fetch(`${API_BASE}/channels`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, description, channelType: type, memberAgentIds: [] }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create channel: ${res.status} ${body}`);
  }
  const data: ApiChannel = await res.json();
  return mapApiChannel(data);
}

export async function getMessages(
  channelId: string,
  options?: { limit?: number; parentId?: string },
): Promise<Message[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.parentId) params.set('parentId', options.parentId);

  const url = `${API_BASE}/channels/${channelId}/messages?${params}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
  const data: { messages: ApiMessage[]; hasMore: boolean } = await res.json();
  return data.messages.map((m) => mapApiMessage(m, undefined));
}

export async function sendMessage(
  channelId: string,
  content: string,
  parentId?: string,
): Promise<Message> {
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      content,
      messageType: 'plain',
      parentId: parentId || undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to send message: ${res.status} ${body}`);
  }
  const data: ApiMessage = await res.json();
  return mapApiMessage(data, undefined);
}

export async function addReaction(
  messageId: string,
  emoji: string,
): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/messages/${messageId}/reactions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ emoji }),
  });
  if (!res.ok) throw new Error(`Failed to add reaction: ${res.status}`);
  return res.json();
}

/** Send POST /api/channels/:channelId/read to mark channel as read */
export async function markChannelAsRead(channelId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/channels/${channelId}/read`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to mark channel as read: ${res.status}`);
}

export async function removeReaction(
  messageId: string,
  emoji: string,
): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to remove reaction: ${res.status}`);
  return res.json();
}

export async function getThread(
  parentMessageId: string,
  channelId: string,
): Promise<{ parent: Message; replies: Message[] }> {
  const parentRes = await fetch(
    `${API_BASE}/channels/${channelId}/messages/${parentMessageId}`,
    { headers: authHeaders() },
  );
  if (!parentRes.ok) throw new Error(`Failed to fetch thread: ${parentRes.status}`);
  const parent: ApiMessage = await parentRes.json();
  const replies = await getMessages(channelId, { parentId: parentMessageId });
  return {
    parent: mapApiMessage(parent, undefined),
    replies,
  };
}

export async function uploadFile(
  _channelId: string,
  _file: File,
): Promise<FileAttachment> {
  throw new Error('Not implemented');
}

/** Create or find a DM channel with another agent */
export async function createDM(targetAgentId: string): Promise<Channel> {
  const res = await fetch(`${API_BASE}/channels/dm`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ targetAgentId }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create DM: ${res.status} ${body}`);
  }
  const data: ApiChannel = await res.json();
  return mapApiChannel(data);
}

export interface Mentionable {
  id: string;
  handle: string;
  displayName: string;
  kind: 'agent' | 'user';
}

/** List all mentionable agents and users */
export async function getMentionables(): Promise<Mentionable[]> {
  const res = await fetch(`${API_BASE}/mentionables`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to fetch mentionables: ${res.status}`);
  return res.json();
}

/** List all agents in the company */
export async function getAgents(): Promise<User[]> {
  const res = await fetch(`${API_BASE}/agents`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
  const data: any[] = await res.json();
  return data.map((a: any) => ({
    id: a.id,
    name: a.name || a.keyName || 'Unknown Agent',
    isAgent: true,
    status: a.status || 'available',
    role: undefined,
    lastSeen: a.updatedAt ? new Date(a.updatedAt) : undefined,
  }));
}

export function createWebSocket(url?: string): WebSocket | null {
  const wsUrl = url || `${API_BASE.replace(/^http/, 'ws')}/ws`;
  try {
    return new WebSocket(wsUrl);
  } catch {
    console.warn('WebSocket connection failed, falling back to polling');
    return null;
  }
}

export interface SearchResult {
  messageId: string;
  content: string;
  channelId: string;
  channelName: string;
  senderId: string;
  senderName: string;
  createdAt: Date | string;
}

export async function searchMessages(
  query: string,
  channelId?: string,
): Promise<{ results: SearchResult[]; total: number }> {
  const params = new URLSearchParams({ q: query });
  if (channelId) params.set('channelId', channelId);
  const url = `${API_BASE}/search/messages?${params}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
}
