"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";

type User = {
  id: number;
  username: string;
};

type Room = {
  id: number;
  name: string;
  unreadCount?: number;
};

type Conversation = {
  id: number;
  peerId: number;
  peerUsername: string;
  unreadCount: number;
};

type UploadMeta = {
  name: string;
  type: string;
  url: string;
};

type Message = {
  id: number;
  content: string;
  createdAt: string;
  senderId: number;
  senderName: string;
  roomId: number | null;
  conversationId: number | null;
  attachmentName: string | null;
  attachmentUrl: string | null;
  attachmentType: string | null;
};

type SocketPayload =
  | { type: "ready"; userId: number; onlineUserIds?: number[] }
  | { type: "presence"; onlineUserIds: number[] }
  | { type: "room-message"; message: Message }
  | { type: "direct-message"; message: Message }
  | { type: "error"; message: string };

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4000";
const TOKEN_KEY = "prodigy-chat-token";
const API_DOWN_MESSAGE = `Cannot reach the API at ${API_URL}. Start the backend with "npm run dev" or "npm run start:api".`;
const EMOJIS = ["😀", "😂", "😍", "🔥", "👍", "🎉", "❤️", "😎"];

export default function HomePage() {
  const [isMobile, setIsMobile] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("register");
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [availableRooms, setAvailableRooms] = useState<Room[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<number[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<number | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [authForm, setAuthForm] = useState({ username: "", password: "" });
  const [newRoomName, setNewRoomName] = useState("");
  const [draft, setDraft] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<UploadMeta | null>(null);
  const [status, setStatus] = useState("Create an account or sign in.");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
    try {
      const response = await fetch(input, init);
      const data = (await response.json()) as T & { error?: string };

      if (!response.ok) {
        throw new Error(data.error || "Request failed.");
      }

      return data;
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(API_DOWN_MESSAGE);
      }

      throw error;
    }
  }

  useEffect(() => {
    const savedToken = window.localStorage.getItem(TOKEN_KEY);
    if (savedToken) {
      setToken(savedToken);
    }

    const media = window.matchMedia("(max-width: 900px)");
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }

    void bootstrap(token);
  }, [token]);

  useEffect(() => {
    if (!token) {
      socketRef.current?.close();
      socketRef.current = null;
      return;
    }

    const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    socketRef.current = socket;

    socket.onopen = () => {
      setStatus("Connected.");
    };

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as SocketPayload;

      if (payload.type === "presence" || payload.type === "ready") {
        setOnlineUserIds(payload.onlineUserIds || []);
        return;
      }

      if (payload.type === "error") {
        setStatus(payload.message);
        return;
      }

      setMessages((current) => {
        const exists = current.some((item) => item.id === payload.message.id);
        return exists ? current : [...current, payload.message];
      });
    };

    socket.onclose = () => {
      socketRef.current = null;
      setStatus("Realtime connection closed. Refresh or restart the backend if sending stops.");
    };

    return () => {
      socket.close();
    };
  }, [token]);

  useEffect(() => {
    const incoming = messages[messages.length - 1];
    if (!incoming) {
      return;
    }

    const isActiveRoomMessage = incoming.roomId !== null && incoming.roomId === activeRoomId;
    const isActiveDirectMessage =
      incoming.conversationId !== null && incoming.conversationId === activeConversationId;

    if (incoming.roomId !== null && !isActiveRoomMessage && incoming.senderId !== user?.id) {
      setRooms((current) =>
        current.map((room) =>
          room.id === incoming.roomId ? { ...room, unreadCount: (room.unreadCount || 0) + 1 } : room
        )
      );
    }

    if (incoming.conversationId !== null && !isActiveDirectMessage && incoming.senderId !== user?.id) {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === incoming.conversationId
            ? { ...conversation, unreadCount: conversation.unreadCount + 1 }
            : conversation
        )
      );
    }

    if (incoming.senderId !== user?.id) {
      maybeNotify(incoming);
    }

    if (isActiveRoomMessage && incoming.roomId !== null) {
      void markRoomRead(incoming.roomId);
    }

    if (isActiveDirectMessage && incoming.conversationId !== null) {
      void markConversationRead(incoming.conversationId);
    }
  }, [messages, activeRoomId, activeConversationId, user?.id]);

  useEffect(() => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      const interval = window.setInterval(() => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          subscribeToActiveChat();
          window.clearInterval(interval);
        }
      }, 200);

      return () => window.clearInterval(interval);
    }

    subscribeToActiveChat();
  }, [activeRoomId, activeConversationId]);

  async function bootstrap(authToken: string) {
    try {
      const data = await requestJson<any>(`${API_URL}/api/bootstrap`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      setUser({ id: data.user.userId, username: data.user.username });
      setRooms(data.rooms.map((room: Room & { unread_count?: number }) => ({
        id: room.id,
        name: room.name,
        unreadCount: room.unread_count ?? room.unreadCount ?? 0,
      })));
      setAvailableRooms(data.availableRooms);
      setUsers(data.users);
      setConversations(data.conversations.map((conversation: Conversation) => ({
        ...conversation,
        unreadCount: conversation.unreadCount || 0,
      })));
      if (data.rooms[0]) {
        void openRoom(data.rooms[0].id);
      } else {
        setMessages([]);
      }
      setStatus(`Signed in as ${data.user.username}.`);
    } catch (error) {
      window.localStorage.removeItem(TOKEN_KEY);
      setToken(null);
      setStatus(error instanceof Error ? error.message : "Session expired. Sign in again.");
    }
  }

  function subscribeToActiveChat() {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    if (activeRoomId) {
      socketRef.current.send(JSON.stringify({ type: "join-room", roomId: activeRoomId }));
    }

    if (activeConversationId) {
      socketRef.current.send(
        JSON.stringify({ type: "join-conversation", conversationId: activeConversationId })
      );
    }
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const data = await requestJson<{ token: string }>(`${API_URL}/api/auth/${mode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(authForm),
      });

      if ("Notification" in window && Notification.permission === "default") {
        void Notification.requestPermission();
      }

      window.localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setAuthForm({ username: "", password: "" });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Authentication failed.");
    }
  }

  async function openRoom(roomId: number) {
    setActiveConversationId(null);
    setActiveRoomId(roomId);
    try {
      const data = await requestJson<Message[]>(`${API_URL}/api/messages/room/${roomId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      setMessages(data);
      setRooms((current) =>
        current.map((room) => (room.id === roomId ? { ...room, unreadCount: 0 } : room))
      );
      await markRoomRead(roomId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load room.");
    }
  }

  async function openConversation(conversationId: number) {
    setActiveRoomId(null);
    setActiveConversationId(conversationId);
    try {
      const data = await requestJson<Message[]>(
        `${API_URL}/api/messages/conversation/${conversationId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      setMessages(data);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation
        )
      );
      await markConversationRead(conversationId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load conversation.");
    }
  }

  async function markRoomRead(roomId: number) {
    await requestJson(`${API_URL}/api/messages/room/${roomId}/read`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  async function markConversationRead(conversationId: number) {
    await requestJson(`${API_URL}/api/messages/conversation/${conversationId}/read`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newRoomName.trim()) {
      return;
    }

    try {
      const data = await requestJson<{ id: number; name: string }>(`${API_URL}/api/rooms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newRoomName }),
      });

      const nextRooms = [...rooms, { id: data.id, name: data.name, unreadCount: 0 }].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      setRooms(nextRooms);
      setAvailableRooms((current) => current.filter((room) => room.id !== data.id));
      setNewRoomName("");
      setStatus(`Created room ${data.name}.`);
      void openRoom(data.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to create room.");
    }
  }

  async function joinRoom(roomId: number) {
    try {
      const data = await requestJson<{ room: Room | null }>(`${API_URL}/api/rooms/${roomId}/join`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!data.room) {
        throw new Error("Failed to join room.");
      }

      const joinedRoom: Room = {
        id: data.room.id,
        name: data.room.name,
        unreadCount: 0,
      };

      setRooms((current) =>
        [...current, joinedRoom].sort((a, b) => a.name.localeCompare(b.name))
      );
      setAvailableRooms((current) => current.filter((room) => room.id !== roomId));
      setStatus(`Joined room ${joinedRoom.name}.`);
      void openRoom(joinedRoom.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to join room.");
    }
  }

  async function startDirectConversation(targetUserId: number) {
    try {
      const data = await requestJson<{ id: number }>(`${API_URL}/api/conversations/direct`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ targetUserId }),
      });

      const peer = users.find((item) => item.id === targetUserId);
      if (!peer) {
        return;
      }

      setConversations((current) => {
        if (current.some((conversation) => conversation.id === data.id)) {
          return current;
        }

        return [
          { id: data.id, peerId: peer.id, peerUsername: peer.username, unreadCount: 0 },
          ...current,
        ];
      });

      void openConversation(data.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to start private chat.");
    }
  }

  async function uploadSelectedFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    setUploading(true);

    try {
      const data = await requestJson<UploadMeta>(`${API_URL}/api/uploads`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      setPendingAttachment({
        name: data.name,
        type: data.type,
        url: `${API_URL}${data.url}`,
      });
      setStatus(`Attached ${data.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setStatus("Realtime connection is not ready yet. Wait a second and try again.");
      return;
    }

    if (!content && !pendingAttachment) {
      return;
    }

    if (activeRoomId) {
      socketRef.current.send(
        JSON.stringify({
          type: "send-room-message",
          roomId: activeRoomId,
          content,
          attachment: pendingAttachment,
        })
      );
    }

    if (activeConversationId) {
      socketRef.current.send(
        JSON.stringify({
          type: "send-direct-message",
          conversationId: activeConversationId,
          content,
          attachment: pendingAttachment,
        })
      );
    }

    setDraft("");
    setPendingAttachment(null);
    setShowEmojiPicker(false);
  }

  function appendEmoji(emoji: string) {
    setDraft((current) => `${current}${emoji}`);
  }

  function maybeNotify(message: Message) {
    if (typeof window === "undefined") {
      return;
    }

    if (document.visibilityState === "visible" && (message.roomId === activeRoomId || message.conversationId === activeConversationId)) {
      return;
    }

    if ("Notification" in window && Notification.permission === "granted") {
      const title = message.roomId
        ? `#${rooms.find((room) => room.id === message.roomId)?.name || "Room"}`
        : conversations.find((conversation) => conversation.id === message.conversationId)?.peerUsername || "Direct message";

      const body = message.content || message.attachmentName || "Sent an attachment";
      new Notification(`${message.senderName} in ${title}`, { body });
      return;
    }

    setStatus(`${message.senderName}: ${message.content || message.attachmentName || "sent an attachment"}`);
  }

  function logout() {
    window.localStorage.removeItem(TOKEN_KEY);
    socketRef.current?.close();
    setToken(null);
    setUser(null);
    setRooms([]);
    setAvailableRooms([]);
    setUsers([]);
    setOnlineUserIds([]);
    setConversations([]);
    setMessages([]);
    setActiveRoomId(null);
    setActiveConversationId(null);
    setPendingAttachment(null);
    setStatus("Signed out.");
  }

  const activeTitle = activeRoomId
    ? rooms.find((room) => room.id === activeRoomId)?.name || "Room"
    : conversations.find((conversation) => conversation.id === activeConversationId)?.peerUsername || "Direct chat";

  if (!user) {
    return (
      <main style={styles.authShell}>
        <section style={{ ...styles.authCard, ...(isMobile ? styles.authCardMobile : {}) }}>
          <p style={styles.eyebrow}>Prodigy Chat</p>
          <h1 style={styles.title}>Real-time messaging with rooms, presence, notifications, and file sharing.</h1>
          <form onSubmit={handleAuthSubmit} style={styles.form}>
            <input
              value={authForm.username}
              onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
              placeholder="username"
              style={styles.input}
            />
            <input
              type="password"
              value={authForm.password}
              onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="password"
              style={styles.input}
            />
            <button type="submit" style={styles.primaryButton}>
              {mode === "register" ? "Create account" : "Sign in"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setMode((current) => (current === "register" ? "login" : "register"))}
            style={styles.secondaryButton}
          >
            {mode === "register" ? "I already have an account" : "I need a new account"}
          </button>
          <p style={styles.status}>{status}</p>
        </section>
      </main>
    );
  }

  return (
    <main style={{ ...styles.appShell, ...(isMobile ? styles.appShellMobile : {}) }}>
      <aside style={{ ...styles.sidebar, ...(isMobile ? styles.sidebarMobile : {}) }}>
        <div style={styles.sidebarSection}>
          <p style={styles.eyebrow}>Signed in</p>
          <div style={styles.userRow}>
            <div>
              <strong>{user.username}</strong>
              <div style={styles.presenceRow}>
                <span style={{ ...styles.presenceDot, ...(onlineUserIds.includes(user.id) ? styles.online : styles.offline) }} />
                <span>{onlineUserIds.includes(user.id) ? "Online" : "Offline"}</span>
              </div>
            </div>
            <button type="button" onClick={logout} style={styles.linkButton}>
              Logout
            </button>
          </div>
        </div>

        <div style={styles.sidebarSection}>
          <div style={styles.sectionHeader}>
            <strong>Rooms</strong>
          </div>
          <form onSubmit={createRoom} style={styles.inlineForm}>
            <input
              value={newRoomName}
              onChange={(event) => setNewRoomName(event.target.value)}
              placeholder="new room"
              style={styles.input}
            />
            <button type="submit" style={styles.primaryButton}>
              Add
            </button>
          </form>
          <div style={styles.list}>
            {rooms.map((room) => (
              <button
                key={room.id}
                type="button"
                onClick={() => void openRoom(room.id)}
                style={activeRoomId === room.id ? styles.listButtonActive : styles.listButton}
              >
                <span>#{room.name}</span>
                {(room.unreadCount || 0) > 0 ? <span style={styles.badge}>{room.unreadCount}</span> : null}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.sidebarSection}>
          <strong>Join a room</strong>
          <div style={styles.list}>
            {availableRooms.length === 0 ? (
              <span style={styles.emptyText}>No public rooms available.</span>
            ) : (
              availableRooms.map((room) => (
                <button key={room.id} type="button" onClick={() => void joinRoom(room.id)} style={styles.listButton}>
                  Join #{room.name}
                </button>
              ))
            )}
          </div>
        </div>

        <div style={styles.sidebarSection}>
          <strong>Direct messages</strong>
          <div style={styles.list}>
            {conversations.length === 0 ? (
              <span style={styles.emptyText}>No private chats yet.</span>
            ) : (
              conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => void openConversation(conversation.id)}
                  style={activeConversationId === conversation.id ? styles.listButtonActive : styles.listButton}
                >
                  <span>{conversation.peerUsername}</span>
                  {conversation.unreadCount > 0 ? <span style={styles.badge}>{conversation.unreadCount}</span> : null}
                </button>
              ))
            )}
          </div>
        </div>

        <div style={styles.sidebarSection}>
          <strong>Start a private chat</strong>
          <div style={styles.list}>
            {users.length === 0 ? (
              <span style={styles.emptyText}>Create another account in a second browser window.</span>
            ) : (
              users.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => void startDirectConversation(person.id)}
                  style={styles.listButton}
                >
                  <span>{person.username}</span>
                  <span style={styles.presenceRow}>
                    <span
                      style={{
                        ...styles.presenceDot,
                        ...(onlineUserIds.includes(person.id) ? styles.online : styles.offline),
                      }}
                    />
                    <span>{onlineUserIds.includes(person.id) ? "Online" : "Offline"}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </aside>

      <section style={{ ...styles.chatPanel, ...(isMobile ? styles.chatPanelMobile : {}) }}>
        <header style={styles.chatHeader}>
          <div>
            <p style={styles.eyebrow}>Active chat</p>
            <h2 style={{ ...styles.chatTitle, ...(isMobile ? styles.chatTitleMobile : {}) }}>{activeTitle}</h2>
          </div>
          <p style={styles.status}>{status}</p>
        </header>

        <div style={styles.messageList}>
          {messages.map((message) => (
            <article key={message.id} style={styles.messageCard}>
              <div style={styles.messageMeta}>
                <strong>{message.senderName}</strong>
                <span>{new Date(message.createdAt).toLocaleString()}</span>
              </div>
              {message.content ? <p style={styles.messageBody}>{message.content}</p> : null}
              {renderAttachment(message)}
            </article>
          ))}
        </div>

        <form onSubmit={sendMessage} style={{ ...styles.composer, ...(isMobile ? styles.composerMobile : {}) }}>
          <div style={styles.composerMain}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type your message..."
              rows={3}
              style={styles.textarea}
            />
            <div style={styles.emojiRow}>
              <button
                type="button"
                onClick={() => setShowEmojiPicker((current) => !current)}
                style={styles.secondaryButton}
              >
                Emoji
              </button>
              {showEmojiPicker ? (
                <div style={styles.emojiPicker}>
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => appendEmoji(emoji)}
                      style={styles.emojiButton}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {pendingAttachment ? (
              <div style={styles.attachmentChip}>
                <span>{pendingAttachment.name}</span>
                <button type="button" onClick={() => setPendingAttachment(null)} style={styles.linkButton}>
                  Remove
                </button>
              </div>
            ) : null}
          </div>
          <div style={styles.composerActions}>
            <label style={styles.secondaryButton}>
              {uploading ? "Uploading..." : "Attach file"}
              <input
                ref={fileInputRef}
                type="file"
                onChange={(event) => void uploadSelectedFile(event)}
                style={{ display: "none" }}
              />
            </label>
            <button type="submit" style={styles.primaryButton}>
              Send
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function renderAttachment(message: Message) {
  if (!message.attachmentUrl || !message.attachmentType) {
    return null;
  }

  if (message.attachmentType.startsWith("image/")) {
    return <img src={message.attachmentUrl} alt={message.attachmentName || "attachment"} style={styles.imageAttachment} />;
  }

  if (message.attachmentType.startsWith("video/")) {
    return <video controls src={message.attachmentUrl} style={styles.mediaAttachment} />;
  }

  if (message.attachmentType.startsWith("audio/")) {
    return <audio controls src={message.attachmentUrl} style={styles.audioAttachment} />;
  }

  return (
    <a href={message.attachmentUrl} target="_blank" rel="noreferrer" style={styles.fileLink}>
      {message.attachmentName || "Download attachment"}
    </a>
  );
}

const styles: Record<string, CSSProperties> = {
  authShell: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: "24px",
  },
  authCard: {
    width: "min(560px, 100%)",
    background: "var(--panel)",
    border: "1px solid var(--line)",
    boxShadow: "var(--shadow)",
    borderRadius: "28px",
    padding: "32px",
    backdropFilter: "blur(18px)",
  },
  authCardMobile: {
    padding: "24px",
  },
  appShell: {
    minHeight: "100vh",
    display: "grid",
    gridTemplateColumns: "minmax(280px, 320px) minmax(0, 1fr)",
    gap: "20px",
    padding: "20px",
    alignItems: "stretch",
    gridAutoRows: "1fr",
  },
  appShellMobile: {
    gridTemplateColumns: "1fr",
    padding: "14px",
  },
  sidebar: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: "28px",
    boxShadow: "var(--shadow)",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
  },
  sidebarMobile: {
    order: 2,
  },
  sidebarSection: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  chatPanel: {
    background: "var(--panel-strong)",
    border: "1px solid var(--line)",
    borderRadius: "28px",
    boxShadow: "var(--shadow)",
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    minHeight: "calc(100vh - 40px)",
    minWidth: 0,
  },
  chatPanelMobile: {
    minHeight: "70vh",
    order: 1,
  },
  chatHeader: {
    padding: "24px",
    borderBottom: "1px solid var(--line)",
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
  },
  chatTitle: {
    margin: "6px 0 0",
    fontSize: "2rem",
  },
  chatTitleMobile: {
    fontSize: "1.5rem",
  },
  title: {
    fontSize: "3rem",
    lineHeight: 1,
    margin: "0 0 24px",
  },
  eyebrow: {
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    fontSize: "0.72rem",
    color: "var(--muted)",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  inlineForm: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "8px",
  },
  input: {
    width: "100%",
    border: "1px solid var(--line)",
    borderRadius: "16px",
    padding: "12px 14px",
    background: "#fffdfa",
  },
  textarea: {
    width: "100%",
    border: "1px solid var(--line)",
    borderRadius: "18px",
    padding: "14px",
    resize: "vertical",
    minHeight: "84px",
  },
  primaryButton: {
    border: "none",
    borderRadius: "16px",
    padding: "12px 18px",
    background: "var(--accent)",
    color: "white",
  },
  secondaryButton: {
    border: "1px solid var(--line)",
    borderRadius: "16px",
    padding: "12px 18px",
    background: "transparent",
    textAlign: "center",
  },
  linkButton: {
    border: "none",
    background: "transparent",
    color: "var(--accent)",
    padding: 0,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "180px",
    overflowY: "auto",
  },
  listButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    textAlign: "left",
    border: "1px solid var(--line)",
    borderRadius: "16px",
    padding: "12px 14px",
    background: "#fffaf2",
  },
  listButtonActive: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    textAlign: "left",
    border: "1px solid var(--accent)",
    borderRadius: "16px",
    padding: "12px 14px",
    background: "var(--accent-soft)",
  },
  emptyText: {
    color: "var(--muted)",
    fontSize: "0.92rem",
  },
  badge: {
    minWidth: "24px",
    height: "24px",
    borderRadius: "999px",
    background: "var(--accent)",
    color: "#fff",
    display: "inline-grid",
    placeItems: "center",
    fontSize: "0.78rem",
    padding: "0 8px",
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  messageList: {
    padding: "24px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  messageCard: {
    border: "1px solid var(--line)",
    borderRadius: "18px",
    padding: "14px 16px",
    background: "#fffdfa",
  },
  messageMeta: {
    display: "flex",
    justifyContent: "space-between",
    gap: "8px",
    color: "var(--muted)",
    fontSize: "0.9rem",
  },
  messageBody: {
    margin: "8px 0 0",
    whiteSpace: "pre-wrap",
  },
  composer: {
    borderTop: "1px solid var(--line)",
    padding: "20px 24px 24px",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "12px",
    alignItems: "end",
  },
  composerMobile: {
    gridTemplateColumns: "1fr",
  },
  composerMain: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  emojiRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap",
  },
  emojiPicker: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
  emojiButton: {
    border: "1px solid var(--line)",
    borderRadius: "12px",
    padding: "8px 10px",
    background: "#fffaf2",
    fontSize: "1.1rem",
    lineHeight: 1,
  },
  composerActions: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  attachmentChip: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    border: "1px solid var(--line)",
    borderRadius: "14px",
    padding: "10px 12px",
    background: "#fffaf2",
  },
  status: {
    margin: 0,
    color: "var(--muted)",
  },
  userRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
  },
  presenceRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    color: "var(--muted)",
    fontSize: "0.86rem",
    marginTop: "6px",
  },
  presenceDot: {
    width: "10px",
    height: "10px",
    borderRadius: "999px",
    display: "inline-block",
  },
  online: {
    background: "#1d9a57",
  },
  offline: {
    background: "#a6a09a",
  },
  imageAttachment: {
    maxWidth: "min(100%, 340px)",
    borderRadius: "14px",
    marginTop: "10px",
    display: "block",
  },
  mediaAttachment: {
    maxWidth: "min(100%, 360px)",
    borderRadius: "14px",
    marginTop: "10px",
    display: "block",
  },
  audioAttachment: {
    width: "100%",
    marginTop: "10px",
  },
  fileLink: {
    display: "inline-block",
    marginTop: "10px",
    color: "var(--accent)",
  },
};
