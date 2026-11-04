import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowUpRight,
  AudioLines,
  ChevronDown,
  CircleHelp,
  Delete,
  Headphones,
  History,
  LayoutGrid,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useVoice } from "./useVoice";
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
const initials = (name) =>
  (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
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

function App() {
  const voice = useVoice();
  const [view, setView] = useState("calls");
  const [number, setNumber] = useState("");
  const [search, setSearch] = useState("");
  const [calls, setCalls] = useState([]);
  const [messages, setMessages] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [audioOpen, setAudioOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [callResponse, messageResponse] = await Promise.all([
        fetch("/call-logs"),
        fetch("/message-logs"),
      ]);
      if (!callResponse.ok || !messageResponse.ok)
        throw new Error("Could not load recent activity. Please try again.");
      const [callData, messageData] = await Promise.all([
        callResponse.json(),
        messageResponse.json(),
      ]);
      setCalls(callData);
      setMessages(messageData);
      setLoadError("");
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60000);
    return () => clearInterval(interval);
  }, [refresh]);
  const rows = view === "calls" ? calls : messages;
  const filtered = useMemo(
    () =>
      rows.filter((row) =>
        [displayName(row), row.from_number, row.to_number, row.body].some(
          (part) =>
            String(part || "")
              .toLowerCase()
              .includes(search.toLowerCase()),
        ),
      ),
    [rows, search],
  );
  const online = voice.connection === "online";
  const running = !!voice.call;
  const pressing = (value) => {
    if (running && voice.call.phase === "active") voice.digit(value);
    else if (!running) setNumber((n) => n + value);
  };
  const keyDown = (event) => {
    if (event.key === "Enter" && online && !running && number.trim())
      voice.dial(number);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span>IW</span>
          </div>
          <div>
            <strong>IRON WING</strong>
            <small>DISPATCHING</small>
          </div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={view === "calls" ? "nav-link selected" : "nav-link"}
            onClick={() => {
              setView("calls");
              setSearch("");
            }}
          >
            <Phone size={18} />
            <span>Phone</span>
            <span className="nav-active" />
          </button>
          <button
            className={view === "messages" ? "nav-link selected" : "nav-link"}
            onClick={() => {
              setView("messages");
              setSearch("");
            }}
          >
            <MessageSquare size={18} />
            <span>Messages</span>
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
          <div className="operator">
            <div className="avatar avatar-dark">IW</div>
            <div>
              <strong>Dispatch desk</strong>
              <span>Iron Wing Dispatching</span>
            </div>
            <ShieldCheck size={16} />
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span className="crumb-slash">/</span>
            <strong>{view === "calls" ? "Phone" : "Messages"}</strong>
          </div>
          <div className="topbar-right">
            <span className={`connection-dot ${online ? "connected" : ""}`} />
            <span>
              {online
                ? "Phone connected"
                : voice.connection === "connecting"
                  ? "Connecting"
                  : "Phone offline"}
            </span>
            <button
              className="icon-button top-settings"
              title="Audio settings"
              aria-label="Audio settings"
              onClick={() => setAudioOpen(true)}
            >
              <Settings2 size={18} />
            </button>
            <div className="avatar avatar-small">IW</div>
          </div>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-dot" /> DISPATCH WORKSPACE
              </div>
              <h1>
                {view === "calls" ? "Phone" : "Messages"}
                <span className="heading-period">.</span>
              </h1>
              <p>
                {view === "calls"
                  ? "Your calls and conversations, all in one place."
                  : "Keep up with messages coming into your number."}
              </p>
            </div>
            <div className="heading-actions">
              <button className="button button-light" onClick={refresh}>
                <RefreshCw size={15} /> Refresh
              </button>
              <button
                className="button button-outline"
                onClick={() => setAudioOpen(true)}
              >
                <Settings2 size={15} /> Audio settings
              </button>
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
          <div className="content-grid">
            <section className="dial-card card" aria-label="Phone dialer">
              <div className="card-top">
                <div>
                  <div className="card-kicker">DISPATCH PHONE</div>
                  <h2>Make a call</h2>
                </div>
                <div className="dial-icon">
                  <PhoneCall size={19} />
                </div>
              </div>
              <div className={`phone-status ${online ? "ready" : ""}`}>
                <span className="status-pulse" />
                <span>
                  {online
                    ? "Ready to make and receive calls"
                    : voice.connection === "connecting"
                      ? "Connecting to your phone…"
                      : "Connect your phone to get started"}
                </span>
              </div>
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
                  <button
                    aria-label="Add plus prefix"
                    disabled={!!number || running}
                    onClick={() => setNumber("+")}
                  >
                    +
                  </button>
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
                <span className="input-hint">
                  Include country code, e.g. +1
                </span>
              </div>
              <div
                className="keypad"
                aria-label={
                  voice.call?.phase === "active" ? "Call keypad" : "Dial pad"
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
              {running ? (
                <div className="call-actions">
                  <button className="hangup-button" onClick={voice.hangup}>
                    <PhoneOff size={18} />{" "}
                    {voice.call.direction === "incoming" &&
                    voice.call.phase === "ringing"
                      ? "Decline"
                      : "End call"}
                  </button>
                  {voice.call.phase === "active" && (
                    <button className="mute-button" onClick={voice.toggleMute}>
                      {voice.muted ? <MicOff size={17} /> : <Mic size={17} />}{" "}
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
            <section className="activity-card card">
              <div className="activity-heading">
                <div>
                  <div className="card-kicker">YOUR ACTIVITY</div>
                  <h2>
                    {view === "calls" ? "Recent calls" : "Incoming messages"}
                  </h2>
                  <p>
                    {view === "calls"
                      ? "Your latest conversations at a glance."
                      : "Recent messages received on your number."}
                  </p>
                </div>
                <div className="activity-icon">
                  {view === "calls" ? (
                    <History size={19} />
                  ) : (
                    <MessageSquare size={19} />
                  )}
                </div>
              </div>
              <div className="activity-tabs">
                <button
                  className={view === "calls" ? "active" : ""}
                  onClick={() => {
                    setView("calls");
                    setSearch("");
                  }}
                >
                  <Phone size={15} /> Calls <span>{calls.length}</span>
                </button>
                <button
                  className={view === "messages" ? "active" : ""}
                  onClick={() => {
                    setView("messages");
                    setSearch("");
                  }}
                >
                  <MessageSquare size={15} /> Messages{" "}
                  <span>{messages.length}</span>
                </button>
              </div>
              <div className="list-toolbar">
                <div>
                  <strong>
                    {view === "calls" ? "Call history" : "Message history"}
                  </strong>
                  <span>Latest 10</span>
                </div>
                <div className="search">
                  <Search size={15} />
                  <input
                    aria-label="Search activity"
                    placeholder="Search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
              {loadError && (
                <div className="list-notice" role="alert">
                  {loadError} <button onClick={refresh}>Retry</button>
                </div>
              )}
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
                        : "Messages sent to your number will appear here."}
                  </span>
                </div>
              ) : (
                <div className="activity-list">
                  {filtered.map((row, index) => {
                    const name = displayName(row);
                    return (
                      <div className="activity-row" key={row.id ?? index}>
                        <div className="avatar avatar-contact">
                          {initials(name)}
                        </div>
                        <div className="row-main">
                          <strong>{name}</strong>
                          <span>
                            {view === "calls" ? (
                              <>
                                <ArrowDownLeft size={13} />{" "}
                                {row.from_number || "Unknown"}
                                {row.company_name
                                  ? ` · ${row.company_name}`
                                  : ""}
                              </>
                            ) : (
                              row.body || "[No message content]"
                            )}
                          </span>
                        </div>
                        <div className="row-end">
                          <time>{formatDate(row.timestamp)}</time>
                          {view === "calls" && row.from_number && (
                            <button
                              className="quick-call"
                              aria-label={`Dial ${row.from_number}`}
                              onClick={() => {
                                setNumber(row.from_number);
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
              <div className="activity-foot">
                <span>Updates every minute</span>
                <span className="foot-indicator">
                  <span /> LIVE ACTIVITY
                </span>
              </div>
              {view === "messages" && (
                <div className="message-note">
                  <CircleHelp size={16} />
                  <span>
                    This inbox shows received messages. Sending messages is not
                    available yet.
                  </span>
                </div>
              )}
            </section>
          </div>
          <div className="page-footer">
            <span>© {new Date().getFullYear()} Iron Wing Dispatching</span>
            <span>
              Built for the road ahead <span className="footer-star">✦</span>
            </span>
          </div>
        </div>
      </main>
      {audioOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAudioOpen(false);
          }}
        >
          <section
            className="modal card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audio-title"
          >
            <div className="modal-title">
              <div>
                <div className="card-kicker">PHONE PREFERENCES</div>
                <h2 id="audio-title">Audio settings</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setAudioOpen(false)}
                aria-label="Close audio settings"
              >
                <X size={20} />
              </button>
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
            <button
              className="button button-outline modal-done"
              onClick={() => setAudioOpen(false)}
            >
              Done
            </button>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
