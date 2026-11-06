import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  AudioLines,
  ChevronDown,
  CornerDownLeft,
  Delete,
  Headphones,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneIncoming,
  PhoneOff,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  UsersRound,
  UserRound,
  X,
} from "lucide-react";
import { useVoice } from "./useVoice";
import Contacts from "./Contacts";
import Conversations from "./Conversations";
import Pagination from "./Pagination";
import ActivityTable from "./ActivityTable";
import {
  apiFetch,
  setApiWorkspace,
  getApiWorkspace,
  IRON_WING_WORKSPACE_ID,
} from "./api";
import WorkspaceSettings from "./WorkspaceSettings";
import "./styles.css";

const keypad = [
  ["1", ""],
  ["2", "ABC"],
  ["3", "DEF"],
  ["4", "GHI"],
  ["5", "JKL"],
  ["6", "MNO"],
  ["7", "PQRS"],
  ["8", "TUV"],
  ["9", "WXYZ"],
  ["*", ""],
  ["0", "+"],
  ["#", ""],
];
const normalizePhone = (value) => String(value || "").replace(/[\s().-]/g, "");
const activityNumber = (row, view) => {
  if (view === "messages")
    return row.outgoing ? row.to_number : row.from_number;
  return row.direction?.startsWith("outbound") || row.outgoing
    ? row.to_number
    : row.from_number;
};
const displayName = (row) =>
  [row.driver_first_name, row.driver_last_name].filter(Boolean).join(" ") ||
  row.company_name ||
  row.from_number ||
  "Unknown caller";
const formatDate = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Unknown date";
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return `Today, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return (
    date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    }) +
    `, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
  );
};

const formatActivityDate = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime()))
    return "Date and time unavailable";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};
const formatDuration = (value) => {
  if (value === null || value === undefined || value === "")
    return "Duration unavailable";
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "Duration unavailable";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
};

function App() {
  const [workspaceId, setWorkspaceId] = useState(IRON_WING_WORKSPACE_ID);
  const [workspaces, setWorkspaces] = useState([
    { id: IRON_WING_WORKSPACE_ID, name: "Iron Wing" },
  ]);
  const [workspaceUnread, setWorkspaceUnread] = useState({});
  const voice = useVoice(
    workspaces.find((workspace) => workspace.id === workspaceId),
  );
  const [view, setView] = useState("calls");
  const [number, setNumber] = useState("");
  const [search, setSearch] = useState("");
  const [calls, setCalls] = useState([]);
  const [messages, setMessages] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [hasMore, setHasMore] = useState({ calls: false, messages: false });
  const activityRequest = useRef(0);
  const [contacts, setContacts] = useState([]);
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsBody, setSmsBody] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const [smsFeedback, setSmsFeedback] = useState(null);
  const smsInFlight = useRef(false);
  const [loadError, setLoadError] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState("");
  const syncInFlight = useRef(false);
  const [unviewed, setUnviewed] = useState({ calls: 0, messages: 0 });
  const [loading, setLoading] = useState(true);
  const [audioOpen, setAudioOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusTime, setStatusTime] = useState(Date.now());
  const statusRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    if (!statusOpen) return;
    setStatusTime(Date.now());
    const timer = setInterval(() => setStatusTime(Date.now()), 10000);
    const dismiss = (event) => {
      if (event.type === "keydown" && event.key === "Escape")
        setStatusOpen(false);
      if (
        event.type === "pointerdown" &&
        !statusRef.current?.contains(event.target)
      )
        setStatusOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      clearInterval(timer);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [statusOpen]);

  useEffect(() => {
    if (!audioOpen) return;
    const dismiss = (event) => {
      if (
        (event.type === "keydown" && event.key === "Escape") ||
        (event.type === "pointerdown" &&
          !audioRef.current?.contains(event.target))
      )
        setAudioOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [audioOpen]);

  const refresh = useCallback(async () => {
    const requestId = ++activityRequest.current;
    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        search,
      });
      const [callResponse, messageResponse] = await Promise.all([
        apiFetch(`/call-logs?${query}`),
        apiFetch(`/message-logs?${query}`),
      ]);
      if (!callResponse.ok || !messageResponse.ok)
        throw new Error("Could not load recent activity. Please try again.");
      const [callData, messageData] = await Promise.all([
        callResponse.json(),
        messageResponse.json(),
      ]);
      if (requestId !== activityRequest.current) return;
      setCalls(callData);
      setMessages(messageData);
      setHasMore({
        calls: callResponse.headers.get("X-Has-More") === "true",
        messages: messageResponse.headers.get("X-Has-More") === "true",
      });
      setLoadError("");
    } catch (err) {
      if (requestId === activityRequest.current) setLoadError(err.message);
    } finally {
      if (requestId === activityRequest.current) setLoading(false);
    }
  }, [page, pageSize, search, workspaceId]);
  useEffect(() => {
    setLoading(true);
    refresh();
    const interval = setInterval(refresh, 60000);
    return () => clearInterval(interval);
  }, [refresh]);
  const refreshCounts = useCallback(async () => {
    const target = getApiWorkspace();
    try {
      const response = await apiFetch("/activity-counts");
      if (response.ok) {
        const data = await response.json();
        if (target === getApiWorkspace()) setUnviewed(data);
      }
    } catch {
      // Keep the last known counts until the next refresh.
    }
  }, [workspaceId]);
  const refreshWorkspaceCounts = useCallback(async () => {
    const results = await Promise.all(
      workspaces.map(async (workspace) => {
        try {
          const response = await apiFetch("/activity-counts", {
            headers: { "X-Workspace-Id": workspace.id },
          });
          if (!response.ok) return null;
          const counts = await response.json();
          return [workspace.id, counts.calls + counts.messages];
        } catch {
          return null;
        }
      }),
    );
    setWorkspaceUnread((previous) => ({
      ...previous,
      ...Object.fromEntries(results.filter(Boolean)),
    }));
  }, [workspaces]);
  useEffect(() => {
    refreshCounts();
    refreshWorkspaceCounts();
    const stream = new EventSource("/message-events");
    const update = () => {
      refreshCounts();
      refreshWorkspaceCounts();
      refresh();
    };
    stream.addEventListener("messages", update);
    stream.addEventListener("ready", refreshCounts);
    stream.addEventListener("ready", refreshWorkspaceCounts);
    const timer = setInterval(refreshCounts, 60000);
    const workspaceTimer = setInterval(refreshWorkspaceCounts, 60000);
    return () => {
      stream.close();
      clearInterval(timer);
      clearInterval(workspaceTimer);
    };
  }, [refresh, refreshCounts, refreshWorkspaceCounts]);
  const markCallViewed = async (id) => {
    try {
      const response = await apiFetch(`/activity-views/calls/${id}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error();
      refresh();
      refreshCounts();
    } catch {
      setLoadError("Could not mark the call as viewed. Please try again.");
    }
  };
  const syncActivity = async () => {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    setSyncFeedback("");
    try {
      const response = await apiFetch("/reconcile", { method: "POST" });
      if (!response.ok)
        throw new Error("Could not sync with Twilio. Please try again.");
      await Promise.all([refresh(), refreshCounts()]);
      setRefreshRevision((current) => current + 1);
      setSyncFeedback("Synced with Twilio.");
    } catch {
      setSyncFeedback("Could not sync with Twilio. Please try again.");
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  };
  useEffect(() => {
    if (!syncFeedback) return;
    const timer = setTimeout(() => setSyncFeedback(""), 5000);
    return () => clearTimeout(timer);
  }, [syncFeedback]);
  const sendMessage = async (event) => {
    if (event) event.preventDefault();
    if (smsInFlight.current) return;
    smsInFlight.current = true;
    setSmsSending(true);
    setSmsFeedback(null);
    try {
      let response;
      try {
        response = await apiFetch("/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: number,
            body: smsBody,
            ...(voice.phoneNumber ? { localNumber: voice.phoneNumber } : {}),
          }),
        });
      } catch {
        throw new Error(
          "Could not confirm if the message was sent. Check Twilio before retrying.",
        );
      }
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not send the message.");
      setSmsBody("");
      setSmsFeedback({
        success: true,
        text: data.saved
          ? "Accepted by Twilio. Delivery is not yet confirmed."
          : "Accepted by Twilio, but history could not be updated. Do not resend; check Twilio.",
      });
      refresh();
    } catch (error) {
      setSmsFeedback({
        success: false,
        text:
          error.message ||
          "Could not confirm if the message was sent. Check Twilio before retrying.",
      });
    } finally {
      smsInFlight.current = false;
      setSmsSending(false);
    }
  };
  const refreshContacts = useCallback(async () => {
    const target = getApiWorkspace();
    try {
      const response = await apiFetch("/contacts");
      if (response.ok) {
        const data = await response.json();
        if (target === getApiWorkspace()) setContacts(data);
      }
    } catch {
      // History remains usable if contacts are temporarily unavailable.
    }
  }, []);
  useEffect(() => {
    refreshContacts();
  }, [refreshContacts, view, workspaceId]);
  const loadWorkspaces = useCallback(async () => {
    const response = await apiFetch("/settings/workspaces");
    if (!response.ok) throw new Error("Could not load workspaces.");
    setWorkspaces(await response.json());
  }, []);
  useEffect(() => {
    loadWorkspaces().catch(() => {});
  }, [loadWorkspaces]);
  const switchWorkspace = (id) => {
    if (!id || id === workspaceId || !voice.canSwitch()) return;
    activityRequest.current++;
    setApiWorkspace(id);
    setWorkspaceId(id);
    setCalls([]);
    setMessages([]);
    setContacts([]);
    setUnviewed({ calls: 0, messages: 0 });
    setSearch("");
    setPage(1);
    setNumber("");
    setSmsBody("");
    setSmsOpen(false);
    setSmsFeedback(null);
  };
  const contactFor = (phone) => {
    const normalized = normalizePhone(phone);
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) return null;
    const matches = contacts.filter(
      (contact) => normalizePhone(contact.phone) === normalized,
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const rows = view === "calls" ? calls : messages;
  const filtered = rows;
  const online = voice.connection === "online";
  const token = voice.tokenStatus;
  const tokenLabel =
    token.state === "valid" && token.expiresAt && token.expiresAt <= statusTime
      ? "Expired"
      : {
          "not-issued": "Not issued",
          valid: "Active",
          refreshing: "Refreshing",
          "refresh-failed": "Refresh failed",
        }[token.state];
  const running = !!voice.call;
  useEffect(() => {
    if (running) setSmsOpen(false);
  }, [running]);
  const pressing = (value) => {
    if (running && voice.call.phase === "active") voice.digit(value);
    else if (!running) setNumber((n) => n + value);
  };
  const keyDown = (event) => {
    if (
      event.key === "Enter" &&
      !smsOpen &&
      online &&
      !running &&
      number.trim()
    )
      voice.dial(number);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span>
              {(
                workspaces.find((item) => item.id === workspaceId)?.name ||
                "Iron Wing"
              )
                .split(/\s+/)
                .slice(0, 2)
                .map((word) => word[0])
                .join("")
                .toUpperCase()}
            </span>
          </div>
          <div>
            <strong>
              {workspaces.find((item) => item.id === workspaceId)?.name ||
                "Iron Wing"}
            </strong>
            <label className="workspace-select">
              <span className="sr-only">Workspace</span>
              <select
                aria-label="Workspace"
                value={workspaceId}
                disabled={
                  !!voice.call ||
                  voice.connection === "connecting" ||
                  smsSending ||
                  syncing
                }
                onChange={(event) => switchWorkspace(event.target.value)}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                    {workspaceUnread[workspace.id]
                      ? ` (${workspaceUnread[workspace.id]})`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            {workspaces.some(
              (workspace) =>
                workspace.id !== workspaceId &&
                workspaceUnread[workspace.id] > 0,
            ) && (
              <span
                className="other-workspace-unread"
                aria-label="Other workspaces have unviewed activity"
              >
                ●
              </span>
            )}
          </div>
        </div>
        <nav aria-label="Main navigation">
          <button
            className={view === "calls" ? "nav-link selected" : "nav-link"}
            onClick={() => {
              setView("calls");
              setSearch("");
              setPage(1);
            }}
          >
            <Phone size={18} />
            <span>Calls</span>
            {unviewed.calls > 0 ? (
              <span
                className="unviewed-count"
                aria-label={`${unviewed.calls} unviewed calls`}
              >
                {unviewed.calls}
              </span>
            ) : (
              view === "calls" && <span className="nav-active" />
            )}
          </button>
          <button
            className={view === "messages" ? "nav-link selected" : "nav-link"}
            onClick={() => {
              setView("messages");
              setSearch("");
              setPage(1);
            }}
          >
            <MessageSquare size={18} />
            <span>Messages</span>
            {unviewed.messages > 0 ? (
              <span
                className="unviewed-count"
                aria-label={`${unviewed.messages} unviewed messages`}
              >
                {unviewed.messages}
              </span>
            ) : (
              view === "messages" && <span className="nav-active" />
            )}
          </button>
          <button
            className={view === "contacts" ? "nav-link selected" : "nav-link"}
            onClick={() => {
              setView("contacts");
              setSearch("");
              setPage(1);
            }}
          >
            <UsersRound size={18} />
            <span>Contacts</span>
            {view === "contacts" && <span className="nav-active" />}
          </button>
          <button
            className={view === "settings" ? "nav-link selected" : "nav-link"}
            onClick={() => {
              setView("settings");
              setSearch("");
              setPage(1);
            }}
          >
            <Settings2 size={18} />
            <span>Settings</span>
            {view === "settings" && <span className="nav-active" />}
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="side-help">
            <div className="side-help-icon">
              <Headphones size={17} />
            </div>
            <div>
              <strong>Stay connected</strong>
              <p>Keep this page open to receive calls.</p>
            </div>
          </div>
        </div>
        <div className="sidebar-copyright">
          © {new Date().getFullYear()} Iron Wing Dispatching
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-right">
            <div className="status-control" ref={statusRef}>
              <button
                className="status-trigger"
                aria-expanded={statusOpen}
                aria-controls="phone-status-details"
                onClick={() => setStatusOpen((open) => !open)}
              >
                <span
                  className={`connection-dot ${online ? "connected" : ""}`}
                />
                {online
                  ? "Phone connected"
                  : voice.connection === "connecting"
                    ? "Connecting"
                    : "Phone offline"}
                <ChevronDown size={14} />
              </button>
              {statusOpen && (
                <section
                  className="status-popover"
                  id="phone-status-details"
                  aria-label="Phone connection details"
                >
                  <div className="status-popover-heading">
                    <strong>Phone status</strong>
                    <span className={online ? "status-online" : ""}>
                      {online
                        ? "Connected"
                        : voice.connection === "connecting"
                          ? "Connecting"
                          : "Offline"}
                    </span>
                  </div>
                  <div className="status-detail">
                    <span>Access token</span>
                    <strong>{tokenLabel}</strong>
                  </div>
                  <div className="status-detail">
                    <span>Expires</span>
                    <strong>
                      {token.expiresAt ? formatDate(token.expiresAt) : "—"}
                    </strong>
                  </div>
                  <div className="status-detail">
                    <span>Last refreshed</span>
                    <strong>
                      {token.lastRefreshedAt
                        ? formatDate(token.lastRefreshedAt)
                        : "Not yet"}
                    </strong>
                  </div>
                  <p>
                    {token.state === "refresh-failed"
                      ? "Token refresh failed. Check the phone connection."
                      : "The phone refreshes its token automatically before it expires."}
                  </p>
                </section>
              )}
            </div>
            <div className="audio-control" ref={audioRef}>
              <button
                className="icon-button top-settings"
                title="Audio settings"
                aria-label="Audio settings"
                aria-expanded={audioOpen}
                aria-controls="audio-settings"
                onClick={() => setAudioOpen((open) => !open)}
              >
                <Settings2 size={18} />
              </button>
              {audioOpen && (
                <section
                  className="status-popover audio-popover"
                  id="audio-settings"
                  aria-labelledby="audio-title"
                >
                  <div className="status-popover-heading">
                    <strong id="audio-title">Audio settings</strong>
                  </div>
                  <p>Choose where you hear calls and incoming ringtones.</p>
                  {!online ? (
                    <div className="settings-empty">
                      Connect your phone to manage audio devices.
                    </div>
                  ) : (
                    <>
                      <button
                        className="button button-light"
                        onClick={voice.refreshAudio}
                      >
                        <Mic size={16} /> Allow microphone access
                      </button>
                      {voice.outputSupported ? (
                        <div className="settings-fields">
                          <label>
                            Speaker
                            <select
                              value={voice.speaker}
                              onChange={(e) =>
                                voice.chooseOutput("speaker", e.target.value)
                              }
                            >
                              <option value="default">Default device</option>
                              {voice.outputs
                                .filter((x) => x.deviceId !== "default")
                                .map((x) => (
                                  <option key={x.deviceId} value={x.deviceId}>
                                    {x.label}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <label>
                            Ringtone
                            <select
                              value={voice.ringtone}
                              onChange={(e) =>
                                voice.chooseOutput("ringtone", e.target.value)
                              }
                            >
                              <option value="default">Default device</option>
                              {voice.outputs
                                .filter((x) => x.deviceId !== "default")
                                .map((x) => (
                                  <option key={x.deviceId} value={x.deviceId}>
                                    {x.label}
                                  </option>
                                ))}
                            </select>
                          </label>
                        </div>
                      ) : (
                        <div className="settings-empty">
                          Output selection is not supported in this browser.
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}
            </div>
          </div>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <h1>
                {view === "settings"
                  ? "Settings"
                  : view === "calls"
                    ? "Calls"
                    : view === "messages"
                      ? "Messages"
                      : "Contacts"}
                <span className="heading-period">.</span>
              </h1>
              <p>
                {view === "settings"
                  ? "Manage workspaces and Twilio connections."
                  : view === "calls"
                    ? "Your calls and conversations, all in one place."
                    : view === "messages"
                      ? "Send and receive messages from your number."
                      : "Your people, one call away."}
              </p>
            </div>
          </div>
          {voice.error && (
            <div className="notice error" role="alert">
              <span>{voice.error}</span>
              <button
                aria-label="Dismiss error"
                onClick={() => voice.setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {view === "settings" && voice.call && (
            <div className="notice" role="status">
              <span>
                {voice.call.workspaceName}: {voice.call.number} ·{" "}
                {voice.call.phase}
              </span>
              {voice.call.direction === "incoming" &&
                voice.call.phase === "ringing" && (
                  <button onClick={voice.accept}>Answer</button>
                )}
              <button onClick={voice.hangup}>End call</button>
            </div>
          )}
          {view === "settings" ? (
            <WorkspaceSettings
              workspaceId={workspaceId}
              busy={
                !!voice.call ||
                voice.connection === "connecting" ||
                smsSending ||
                syncing
              }
              onWorkspaceCreated={loadWorkspaces}
              onNumberChangeStart={voice.stop}
              onNumberChangeEnd={voice.resume}
              onNumberChanged={async () => {
                setNumber("");
                setSmsBody("");
                setSmsOpen(false);
                await loadWorkspaces();
                await refreshContacts();
              }}
            />
          ) : (
            <div className="content-grid">
              <div className="communication-panel">
                <section className="dial-card card" aria-label="Phone dialer">
                  <div className={`phone-status ${online ? "ready" : ""}`}>
                    <span className="status-pulse" />
                    <span>
                      {online
                        ? "Ready to make and receive calls and messages"
                        : voice.connection === "connecting"
                          ? "Connecting to your phone…"
                          : "Connect your phone to get started"}
                    </span>
                  </div>
                  {voice.phoneNumber && (
                    <p className="selected-phone-number">
                      From {voice.phoneNumber}
                    </p>
                  )}
                  {!online && (
                    <button
                      className="connect-button"
                      disabled={voice.connection === "connecting"}
                      onClick={voice.start}
                    >
                      <AudioLines size={17} />
                      {voice.connection === "connecting"
                        ? "Connecting…"
                        : "Connect phone"}
                    </button>
                  )}
                  <div className="dial-field">
                    <label htmlFor="dial-number">PHONE NUMBER</label>
                    <div className="input-wrap">
                      {!number && (
                        <button
                          aria-label="Add plus prefix"
                          disabled={!!number || running}
                          onClick={() => setNumber("+")}
                        >
                          +
                        </button>
                      )}
                      <input
                        id="dial-number"
                        type="tel"
                        autoComplete="tel"
                        value={number}
                        disabled={running}
                        onChange={(event) => setNumber(event.target.value)}
                        onKeyDown={keyDown}
                        placeholder="Enter a phone number"
                      />
                      <button
                        aria-label="Delete last digit"
                        disabled={!number || running}
                        onClick={() => setNumber((n) => n.slice(0, -1))}
                      >
                        <Delete size={19} />
                      </button>
                    </div>
                  </div>
                  <div className="keypad-area">
                    <div
                      className="keypad"
                      inert={smsOpen ? true : undefined}
                      aria-label={
                        voice.call?.phase === "active"
                          ? "Call keypad"
                          : "Dial pad"
                      }
                    >
                      {keypad.map(([value, letters]) => (
                        <button
                          key={value}
                          type="button"
                          disabled={running && voice.call.phase !== "active"}
                          onClick={() => pressing(value)}
                          aria-label={`Digit ${value}`}
                        >
                          <span>{value}</span>
                          <small>{letters || "\u00a0"}</small>
                        </button>
                      ))}
                    </div>
                    {smsOpen && (
                      <div className="sms-editor">
                        <div className="sms-editor-heading">
                          <label htmlFor="sms-body">Message</label>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Close message editor"
                            onClick={() => setSmsOpen(false)}
                          >
                            <X size={18} />
                          </button>
                        </div>
                        <textarea
                          id="sms-body"
                          autoFocus
                          maxLength={1600}
                          value={smsBody}
                          onChange={(event) => setSmsBody(event.target.value)}
                          placeholder="Write your message"
                        />
                        <small>
                          {smsBody.length}/1600 characters · Only message
                          recipients who have consented.
                        </small>
                      </div>
                    )}
                  </div>
                  <div className="dial-buttons">
                    {running ? (
                      <div className="call-actions">
                        <button
                          className="hangup-button"
                          onClick={voice.hangup}
                        >
                          <PhoneOff size={18} />{" "}
                          {voice.call.direction === "incoming" &&
                          voice.call.phase === "ringing"
                            ? "Decline"
                            : "End call"}
                        </button>
                        {voice.call.phase === "active" && (
                          <button
                            className="mute-button"
                            onClick={voice.toggleMute}
                          >
                            {voice.muted ? (
                              <MicOff size={17} />
                            ) : (
                              <Mic size={17} />
                            )}{" "}
                            {voice.muted ? "Unmute" : "Mute"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        className="call-button"
                        disabled={!online || !number.trim()}
                        onClick={() => voice.dial(number)}
                      >
                        <Phone size={18} /> Call number
                      </button>
                    )}
                    <button
                      className="button sms-button"
                      type="button"
                      disabled={
                        smsSending ||
                        running ||
                        (smsOpen && (!number.trim() || !smsBody.trim()))
                      }
                      onClick={() =>
                        smsOpen ? sendMessage() : setSmsOpen(true)
                      }
                    >
                      <Send size={16} />{" "}
                      {smsSending ? "Sending…" : "Send message"}
                    </button>
                  </div>
                  {smsFeedback && (
                    <p
                      className={
                        smsFeedback.success
                          ? "sms-success"
                          : "contact-form-error"
                      }
                      role="status"
                    >
                      {smsFeedback.text}
                    </p>
                  )}
                  {voice.call && (
                    <div className="call-panel" role="status">
                      <div>
                        <span className="live-dot" />{" "}
                        {voice.call.direction === "incoming" &&
                        voice.call.phase === "ringing"
                          ? "INCOMING CALL"
                          : voice.call.phase === "active"
                            ? "CALL IN PROGRESS"
                            : "CONNECTING"}
                      </div>
                      <strong>{voice.call.number}</strong>
                      {voice.call.workspaceName && (
                        <span>
                          {voice.call.workspaceName}
                          {voice.call.localNumber
                            ? ` · ${voice.call.localNumber}`
                            : ""}
                        </span>
                      )}
                      {voice.call.direction === "incoming" &&
                        voice.call.phase === "ringing" && (
                          <button onClick={voice.accept}>
                            <PhoneIncoming size={15} /> Answer call
                          </button>
                        )}
                      {voice.call.phase === "active" && (
                        <div className="level-row">
                          <span>Mic</span>
                          <i>
                            <b
                              style={{
                                width: `${Math.min(100, voice.levels.input * 100)}%`,
                              }}
                            />
                          </i>
                          <span>Speaker</span>
                          <i>
                            <b
                              style={{
                                width: `${Math.min(100, voice.levels.output * 100)}%`,
                              }}
                            />
                          </i>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="dial-footer">
                    <ShieldCheck size={14} />
                    <span>Connected securely with Twilio</span>
                  </div>
                </section>
              </div>
              {view === "contacts" ? (
                <Contacts
                  key={workspaceId}
                  onDial={(phone) => {
                    setNumber(phone);
                    setView("calls");
                  }}
                />
              ) : (
                <ActivityTable
                  kicker="YOUR ACTIVITY"
                  title={view === "calls" ? "Call history" : "Message history"}
                  description={
                    view === "calls"
                      ? "Your latest conversations at a glance."
                      : "Your latest sent and received messages."
                  }
                  headingAction={
                    <button
                      className="activity-icon activity-refresh"
                      type="button"
                      aria-label={
                        syncing
                          ? "Syncing with Twilio"
                          : "Sync activity with Twilio"
                      }
                      title={
                        syncing
                          ? "Syncing with Twilio"
                          : "Sync activity with Twilio"
                      }
                      disabled={syncing}
                      onClick={syncActivity}
                    >
                      <RefreshCw
                        size={19}
                        className={syncing ? "sync-spinning" : ""}
                      />
                    </button>
                  }
                  headingNotice={
                    <>
                      {loadError && (
                        <div className="heading-notice" role="alert">
                          {loadError} <button onClick={refresh}>Retry</button>
                        </div>
                      )}
                      {view === "messages" && conversationError && (
                        <div className="heading-notice" role="alert">
                          {conversationError}{" "}
                          <button
                            onClick={() =>
                              setRefreshRevision((current) => current + 1)
                            }
                          >
                            Retry
                          </button>
                        </div>
                      )}
                      {syncFeedback && (
                        <div
                          className={`heading-notice ${syncFeedback.startsWith("Synced") ? "heading-notice-success" : ""}`}
                          role="status"
                        >
                          {syncFeedback}
                        </div>
                      )}
                    </>
                  }
                  searchLabel="Search activity"
                  searchValue={search}
                  onSearchChange={(value) => {
                    setPage(1);
                    setSearch(value);
                  }}
                >
                  {view === "messages" ? (
                    <Conversations
                      key={workspaceId}
                      contacts={contacts}
                      search={search}
                      refreshRevision={refreshRevision}
                      onErrorChange={setConversationError}
                    />
                  ) : (
                    <>
                      {loading ? (
                        <div className="empty">Loading activity…</div>
                      ) : !filtered.length ? (
                        <div className="empty">
                          <div className="empty-icon">
                            {view === "calls" ? (
                              <Phone size={23} />
                            ) : (
                              <MessageSquare size={23} />
                            )}
                          </div>
                          <strong>
                            {search
                              ? "No matching activity"
                              : view === "calls"
                                ? "No calls yet"
                                : "No messages yet"}
                          </strong>
                          <span>
                            {search
                              ? "Try a different search."
                              : view === "calls"
                                ? "Your recent calls will appear here."
                                : "Your messages will appear here."}
                          </span>
                        </div>
                      ) : (
                        <div className="activity-list">
                          {filtered.map((row, index) => {
                            const phone = activityNumber(row, view);
                            const contact = contactFor(phone);
                            const missed =
                              row.missed ||
                              (row.direction === "inbound" &&
                                !row.outgoing &&
                                ["no-answer", "busy", "canceled"].includes(
                                  row.status,
                                ));
                            const name =
                              contact?.name || phone || "Unknown number";
                            return (
                              <div
                                className={`activity-row ${row.unviewed ? "unviewed-row" : ""}`}
                                key={row.id ?? index}
                              >
                                <div
                                  className={`avatar ${contact ? "avatar-contact" : "avatar-unknown"}`}
                                >
                                  {contact ? (
                                    contact.name.trim().charAt(0).toUpperCase()
                                  ) : (
                                    <UserRound
                                      size={20}
                                      aria-label="Unknown contact"
                                    />
                                  )}
                                </div>
                                <div className="row-main">
                                  <strong>{name}</strong>
                                  <span>
                                    {view === "calls" ? (
                                      <>
                                        {missed ? (
                                          <CornerDownLeft
                                            size={13}
                                            className="missed-call-icon"
                                            aria-label="Missed call"
                                          />
                                        ) : (
                                          <ArrowDownLeft size={13} />
                                        )}{" "}
                                        {phone || "Unknown"}
                                        {row.company_name
                                          ? ` · ${row.company_name}`
                                          : ""}
                                      </>
                                    ) : (
                                      <>
                                        {row.outgoing
                                          ? "Sent · "
                                          : "Received · "}
                                        {row.body || "[No message content]"}
                                      </>
                                    )}
                                  </span>
                                </div>
                                <div className="row-end">
                                  {row.unviewed && (
                                    <button
                                      className="mark-viewed"
                                      onClick={() => markCallViewed(row.id)}
                                    >
                                      Mark viewed
                                    </button>
                                  )}
                                  <div className="activity-meta">
                                    <time>
                                      {formatActivityDate(row.timestamp)}
                                    </time>
                                    {view === "calls" && (
                                      <span>
                                        {formatDuration(row.duration)}
                                      </span>
                                    )}
                                  </div>
                                  {view === "calls" && phone && (
                                    <button
                                      className="quick-call"
                                      aria-label={`Dial ${phone}`}
                                      onClick={() => {
                                        setNumber(phone);
                                        setView("calls");
                                      }}
                                    >
                                      <Phone size={15} />
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <Pagination
                        label="Call history pagination"
                        page={page}
                        pageSize={pageSize}
                        hasMore={hasMore.calls}
                        loading={loading}
                        onPageChange={setPage}
                        onPageSizeChange={(size) => {
                          setPage(1);
                          setPageSize(size);
                        }}
                      />
                    </>
                  )}
                </ActivityTable>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
