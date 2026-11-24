import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowUpRight,
  AudioLines,
  ChevronDown,
  CornerDownLeft,
  Delete,
  Grid3x3,
  Headphones,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  Power,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  UsersRound,
  UserPlus,
  UserRound,
  X,
} from "lucide-react";
import { useVoice } from "./useVoice";
import Contacts from "./Contacts";
import Leads, { Script } from "./Leads";
import PhoneDrawer from "./PhoneDrawer";
import AssistantSettings, { useAssistantSettings } from "./AssistantSettings";
import {
  CallResult,
  HistoryResult,
  LivePrompter,
  createCallIntent,
  useAssistEligibility,
  useCallSession,
} from "./CallAssist";
import { leadTitle } from "./leadCard.mjs";
import Conversations from "./Conversations";
import Pagination from "./Pagination";
import ActivityTable from "./ActivityTable";
import { formatCallDate } from "./callDate.mjs";
import { callCost } from "./callCost.mjs";
import { messageTargetForCall } from "./callMessage.mjs";
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
const clockZones = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Los_Angeles", "Pacific"],
  ["Europe/Athens", "Greece"],
];

function TimeClock({ zone, onZoneChange }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const clockRef = useRef(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => {
      if (
        event.key === "Escape" ||
        (event.type === "pointerdown" &&
          !clockRef.current?.contains(event.target))
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open]);
  const abbreviation = (value) =>
    new Intl.DateTimeFormat(value === "Europe/Athens" ? "en-GB" : "en-US", {
      timeZone: value,
      timeZoneName: "short",
    })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value;
  return (
    <div className="time-clock" ref={clockRef}>
      <button
        className="status-trigger clock-trigger"
        type="button"
        aria-label={`Clock time zone: ${clockZones.find(([value]) => value === zone)[1]}, ${abbreviation(zone)}`}
        aria-expanded={open}
        aria-controls="clock-zones"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{abbreviation(zone)}</span>
        <time dateTime={new Date(now).toISOString()}>
          {new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hour: "numeric",
            minute: "2-digit",
          }).format(now)}
        </time>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          className="status-popover clock-popover"
          id="clock-zones"
          aria-label="Clock time zones"
        >
          {clockZones.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={
                zone === value ? "clock-option selected" : "clock-option"
              }
              aria-label={`${label}: ${abbreviation(value)}`}
              aria-pressed={zone === value}
              onClick={() => {
                onZoneChange(value);
                setOpen(false);
              }}
            >
              {abbreviation(value)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
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

const isMissedCall = (row) =>
  row.announcement?.kind === "missed" ||
  row.missed ||
  (row.direction === "inbound" &&
    !row.outgoing &&
    ["no-answer", "busy", "canceled"].includes(row.status));
const callOutcome = (row) => {
  if (row.announcement?.kind === "closed") return "After hours";
  if (isMissedCall(row)) return "Missed";
  if (row.status === "completed" && row.answered) return "Answered";
  const labels = {
    completed: "Completed",
    "no-answer": "No answer",
    busy: "Busy",
    failed: "Failed",
    canceled: "Canceled",
    "in-progress": "In progress",
    ringing: "Ringing",
    queued: "Queued",
    initiated: "Connecting",
  };
  return labels[row.status] || "Unknown status";
};
const announcementLabel = (row) => {
  if (!row.announcement)
    return isMissedCall(row) ? "Automated message status unknown" : "";
  const name =
    row.announcement.kind === "closed" ? "Closed message" : "Automated message";
  if (row.announcement.completed) return `${name} completed`;
  return `${name} initiated · completion unknown`;
};
// The call's cost, once known; hovering shows what it is made of.
function CallCost({ row }) {
  const cost = callCost(row);
  if (!cost) return null;
  return (
    <>
      {" · "}
      <span className="call-cost" title={cost.breakdown}>
        {cost.label}
      </span>
    </>
  );
}
function CallDirection({ row }) {
  return isMissedCall(row) ? (
    <CornerDownLeft
      size={13}
      className="missed-call-icon"
      aria-label="Missed call"
    />
  ) : row.outgoing ? (
    <ArrowUpRight size={13} aria-label="Outgoing call" />
  ) : (
    <ArrowDownLeft size={13} aria-label="Incoming call" />
  );
}

function App() {
  const [timeZone, setTimeZone] = useState("America/New_York");
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
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [callKeypadOpen, setCallKeypadOpen] = useState(false);
  const [phoneContext, setPhoneContext] = useState(null);
  const [assistSelected, setAssistSelected] = useState(true);
  const [sessionId, setSessionId] = useState(null);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const assistantSettings = useAssistantSettings(workspaceId);
  const assistEligible = useAssistEligibility(
    workspaceId,
    normalizePhone(number),
    assistantSettings.preferences.liveAssist,
  );
  const callSession = useCallSession(workspaceId, sessionId, sessionRevision);
  const [search, setSearch] = useState("");
  const [calls, setCalls] = useState([]);
  const [expandedCalls, setExpandedCalls] = useState({});
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
  const [conversationList, setConversationList] = useState(null);
  const [conversationTarget, setConversationTarget] = useState(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState("");
  const syncInFlight = useRef(false);
  const [unviewed, setUnviewed] = useState({ calls: 0, messages: 0 });
  const [leads, setLeads] = useState([]);
  const [leadCount, setLeadCount] = useState(0);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [leadError, setLeadError] = useState("");
  const announcedLeads = useRef(null);
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
        apiFetch(`/call-logs?${query}&grouped=true`),
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
  // Calls the AI receptionist answered: the cards and the unread number.
  const refreshLeads = useCallback(async () => {
    const target = getApiWorkspace();
    try {
      const [list, count] = await Promise.all([
        apiFetch("/leads"),
        apiFetch("/leads/count"),
      ]);
      if (target !== getApiWorkspace()) return;
      if (!list.ok) throw new Error();
      setLeads(await list.json());
      if (count.ok) setLeadCount((await count.json()).leads || 0);
      setLeadError("");
    } catch {
      if (target === getApiWorkspace())
        setLeadError("Could not load leads. Please try again.");
    } finally {
      if (target === getApiWorkspace()) setLeadsLoading(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    refreshCounts();
    refreshWorkspaceCounts();
    refreshLeads();
    const stream = new EventSource("/message-events");
    const update = () => {
      refreshCounts();
      refreshWorkspaceCounts();
      refreshLeads();
      refresh();
    };
    stream.addEventListener("messages", update);
    stream.addEventListener("ready", refreshCounts);
    stream.addEventListener("ready", refreshWorkspaceCounts);
    stream.addEventListener("ready", refreshLeads);
    const timer = setInterval(refreshCounts, 60000);
    const workspaceTimer = setInterval(refreshWorkspaceCounts, 60000);
    const leadTimer = setInterval(refreshLeads, 60000);
    return () => {
      stream.close();
      clearInterval(timer);
      clearInterval(workspaceTimer);
      clearInterval(leadTimer);
    };
  }, [refresh, refreshCounts, refreshWorkspaceCounts, refreshLeads]);
  // Tell the operator about a new lead even when this tab is in the
  // background. The first count after loading is the baseline, not news.
  useEffect(() => {
    const previous = announcedLeads.current;
    announcedLeads.current = leadCount;
    if (previous === null || leadCount <= previous) return;
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    const newest = leads.find((lead) => lead.status === "new");
    new Notification("New lead", {
      body: newest ? leadTitle(newest) : "A caller is waiting for a callback.",
    });
  }, [leadCount, leads]);
  const setLeadStatus = async (lead, status) => {
    try {
      const response = await apiFetch(`/leads/${lead.callSid}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error();
      refreshLeads();
      return true;
    } catch {
      setLeadError("Could not update the lead. Please try again.");
      return false;
    }
  };
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
    setExpandedCalls({});
    setMessages([]);
    setContacts([]);
    setConversationList(null);
    setConversationTarget(null);
    setUnviewed({ calls: 0, messages: 0 });
    setSearch("");
    setPage(1);
    setNumber("");
    setPhoneOpen(false);
    setAssistSelected(true);
    setSessionId(null);
    setPhoneContext(null);
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
  const live = voice.call?.phase === "active";
  useEffect(() => {
    if (!live) setCallKeypadOpen(false);
  }, [live]);
  const ringing =
    voice.call?.direction === "incoming" && voice.call.phase === "ringing";
  const phoneState = ringing
    ? "ringing"
    : live
      ? "live"
      : running
        ? "connecting"
        : "idle";
  const launcherLabel = {
    idle: "Open phone",
    ringing: "Incoming call, open phone",
    connecting: "Call connecting, open phone",
    live: "Live call, open phone",
  }[phoneState];
  const launcherStatus = {
    ringing: "Ringing",
    connecting: "Dialing",
    live: "Live",
  }[phoneState];
  const LauncherIcon =
    phoneState === "ringing"
      ? PhoneIncoming
      : phoneState === "live"
        ? PhoneCall
        : Phone;
  useEffect(() => {
    if (ringing) setPhoneOpen(true);
  }, [ringing]);
  const editNumber = (value) => {
    setNumber(value);
    if (value === number) return;
    setPhoneContext(null);
    setSessionId(null);
    setAssistSelected(true);
    setSmsBody("");
    setSmsFeedback(null);
  };
  const openPhone = (phone, context = null) => {
    if (!running && !preparingRef.current) {
      setSessionId(null);
      setAssistSelected(true);
      editNumber(phone);
      setPhoneContext(context);
    }
    setPhoneOpen(true);
  };
  const openCallDetails = (sid) => {
    if (!running && !preparingRef.current) setPhoneContext({ history: sid });
    setPhoneOpen(true);
  };
  const dial = async () => {
    if (preparingRef.current || !online || running || !number.trim()) return;
    preparingRef.current = true;
    setPreparing(true);
    const destination = normalizePhone(number);
    let intent;
    setSessionId(null);
    try {
      if (/^\+[1-9]\d{7,14}$/.test(destination)) {
        intent = await createCallIntent(workspaceId, {
          destination,
          leadSid: phoneContext?.lead?.callSid,
          assist: assistEligible && assistSelected,
        });
      }
    } catch {
      setPhoneContext((current) => ({
        ...current,
        notice: "Call details unavailable. The phone will dial normally.",
      }));
    } finally {
      if (getApiWorkspace() === workspaceId) {
        setSessionId(intent || null);
        voice.dial(number, intent);
        setAssistSelected(true);
      }
      preparingRef.current = false;
      setPreparing(false);
    }
  };
  const pressing = (value) => {
    if (live && callKeypadOpen) voice.digit(value);
    else if (!running) editNumber(number + value);
  };
  const keyDown = (event) => {
    if (
      event.key === "Enter" &&
      !smsOpen &&
      online &&
      !running &&
      number.trim()
    )
      dial();
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
                  preparing ||
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
              setConversationTarget(null);
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
            className={view === "leads" ? "nav-link selected" : "nav-link"}
            onClick={() => {
              setView("leads");
              setSearch("");
              setPage(1);
              refreshLeads();
              // Asking from a click is the only time browsers allow it.
              if (
                "Notification" in window &&
                Notification.permission === "default"
              )
                Notification.requestPermission().catch(() => {});
            }}
          >
            <UserPlus size={18} />
            <span>Leads</span>
            {leadCount > 0 ? (
              <span
                className="unviewed-count"
                aria-label={`${leadCount} leads waiting for a callback`}
              >
                {leadCount}
              </span>
            ) : (
              view === "leads" && <span className="nav-active" />
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
            <TimeClock zone={timeZone} onZoneChange={setTimeZone} />
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
                    <span
                      className={`connection-status ${online ? "status-online" : ""}`}
                    >
                      <button
                        type="button"
                        className="connection-toggle"
                        aria-label={
                          online
                            ? "Disconnect phone in all workspaces"
                            : "Connect phone"
                        }
                        title={
                          !voice.canSwitch()
                            ? "Unavailable during a call or while connecting"
                            : online
                              ? "Disconnect phone in all workspaces"
                              : "Connect phone"
                        }
                        disabled={
                          !voice.canSwitch() ||
                          voice.connection === "connecting"
                        }
                        onClick={online ? voice.stop : voice.start}
                      >
                        <Power size={15} />
                      </button>
                      {online
                        ? "Connected"
                        : voice.connection === "connecting"
                          ? "Connecting"
                          : "Offline"}
                    </span>
                  </div>
                  <div className="status-detail">
                    <span>Phone number</span>
                    <strong>{voice.phoneNumber || "—"}</strong>
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
                title="Phone settings"
                aria-label="Phone settings"
                aria-expanded={audioOpen}
                aria-controls="phone-settings"
                onClick={() => setAudioOpen((open) => !open)}
              >
                <Settings2 size={18} />
              </button>
              {audioOpen && (
                <section
                  className="status-popover audio-popover"
                  id="phone-settings"
                  aria-labelledby="phone-settings-title"
                >
                  <div className="status-popover-heading">
                    <strong id="phone-settings-title">Phone settings</strong>
                  </div>
                  <AssistantSettings settings={assistantSettings} />
                  <h3 className="audio-settings-title">Audio devices</h3>
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
            <h1>
              {view === "settings"
                ? "Settings"
                : view === "calls"
                  ? "Calls"
                  : view === "messages"
                    ? "Messages"
                    : view === "leads"
                      ? "Leads"
                      : "Contacts"}
              <span className="heading-period">.</span>
            </h1>
            <button
              type="button"
              className="phone-launcher"
              data-phone-opener
              data-call-state={phoneState}
              aria-label={launcherLabel}
              aria-expanded={phoneOpen}
              aria-controls="phone-drawer"
              onClick={() => setPhoneOpen((value) => !value)}
            >
              <LauncherIcon size={24} aria-hidden="true" />
              {launcherStatus && (
                <span className="phone-launcher-status" aria-hidden="true">
                  {launcherStatus}
                </span>
              )}
            </button>
            <p>
              {view === "settings"
                ? "Manage workspaces and Twilio connections."
                : view === "calls"
                  ? "Your calls and conversations, all in one place."
                  : view === "messages"
                    ? "Send and receive messages from your number."
                    : view === "leads"
                      ? "Callers the AI receptionist spoke to, ready for your callback."
                      : "Your people, one call away."}
            </p>
          </div>
          {voice.error && !phoneOpen && (
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
          {view === "settings" ? (
            <WorkspaceSettings
              workspaceId={workspaceId}
              busy={
                !!voice.call ||
                preparing ||
                voice.connection === "connecting" ||
                smsSending ||
                syncing
              }
              workspaceName={
                workspaces.find((item) => item.id === workspaceId)?.name
              }
              canArchive={voice.canSwitch()}
              onWorkspaceCreated={loadWorkspaces}
              onWorkspaceRenamed={loadWorkspaces}
              onWorkspaceArchived={async () => {
                await loadWorkspaces();
                switchWorkspace(IRON_WING_WORKSPACE_ID);
              }}
              onNumberChangeStart={voice.stop}
              onNumberChangeEnd={voice.resume}
              onNumberChanged={async () => {
                setNumber("");
                setPhoneContext(null);
                setSessionId(null);
                setAssistSelected(true);
                setSmsBody("");
                setSmsOpen(false);
                await loadWorkspaces();
                await refreshContacts();
              }}
            />
          ) : (
            <div className="content-grid">
              {view === "contacts" ? (
                <Contacts
                  key={workspaceId}
                  onDial={(phone) => openPhone(phone)}
                />
              ) : view === "leads" ? (
                <Leads
                  leads={leads}
                  loading={leadsLoading}
                  error={leadError}
                  timeZone={timeZone}
                  canCall={!running && !preparing}
                  onCall={(phone, lead) => openPhone(phone, { lead })}
                  onStatus={setLeadStatus}
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
                      initialConversation={conversationTarget}
                      activeNumber={voice.phoneNumber}
                      timeZone={timeZone}
                      contacts={contacts}
                      search={search}
                      list={conversationList}
                      onListChange={setConversationList}
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
                          {filtered.map((group) => {
                            const row = group.calls[0];
                            const phone = activityNumber(row, "calls");
                            const messageTarget = messageTargetForCall(
                              phone,
                              row.local_number,
                              voice.phoneNumber,
                            );
                            const contact = contactFor(phone);
                            const name =
                              contact?.name || phone || "Unknown number";
                            const expanded = Boolean(
                              expandedCalls[group.group_key],
                            );
                            const hasUnviewed = group.calls.some(
                              (call) => call.unviewed,
                            );
                            return (
                              <div className="call-group" key={group.group_key}>
                                <div
                                  className={`activity-row call-group-row ${expanded ? "call-group-row-expanded" : ""} ${hasUnviewed ? "unviewed-row" : ""}`}
                                >
                                  <button
                                    type="button"
                                    className="call-row-toggle"
                                    aria-expanded={expanded}
                                    aria-controls={`call-details-${row.id}`}
                                    aria-label={`${expanded ? "Hide" : "Show"} call history for ${name}`}
                                    onClick={() =>
                                      setExpandedCalls((current) => ({
                                        ...current,
                                        [group.group_key]:
                                          !current[group.group_key],
                                      }))
                                    }
                                  />
                                  <div
                                    className={`avatar ${contact ? "avatar-contact" : "avatar-unknown"}`}
                                  >
                                    {contact ? (
                                      contact.name
                                        .trim()
                                        .charAt(0)
                                        .toUpperCase()
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
                                      <CallDirection row={row} />{" "}
                                      {phone || "Unknown"} · {callOutcome(row)}
                                      {announcementLabel(row) &&
                                        ` · ${announcementLabel(row)}`}
                                    </span>
                                    {group.calls.length > 1 && (
                                      <span>
                                        {group.calls.length} calls
                                        {hasUnviewed ? " · Unviewed call" : ""}
                                      </span>
                                    )}
                                  </div>
                                  <div className="row-end">
                                    {group.calls.length === 1 &&
                                      row.unviewed && (
                                        <button
                                          className="mark-viewed"
                                          onClick={() => markCallViewed(row.id)}
                                        >
                                          Mark viewed
                                        </button>
                                      )}
                                    <div className="activity-meta">
                                      <time>
                                        {formatCallDate(
                                          row.timestamp,
                                          timeZone,
                                        )}
                                      </time>
                                      <span>
                                        {formatDuration(row.duration)}
                                      </span>
                                    </div>
                                    {phone && (
                                      <button
                                        type="button"
                                        className="quick-call"
                                        aria-label={`Message ${phone}`}
                                        title={
                                          messageTarget
                                            ? "Open messages"
                                            : "A valid recipient and sending number are required"
                                        }
                                        disabled={!messageTarget}
                                        onClick={() => {
                                          setConversationTarget(messageTarget);
                                          setSearch("");
                                          setPage(1);
                                          setView("messages");
                                        }}
                                      >
                                        <MessageSquare size={15} />
                                      </button>
                                    )}
                                    {phone && (
                                      <button
                                        className="quick-call"
                                        aria-label={`Dial ${phone}`}
                                        onClick={() =>
                                          openPhone(phone, {
                                            missed: isMissedCall(row),
                                          })
                                        }
                                      >
                                        <Phone size={15} />
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div
                                  id={`call-details-${row.id}`}
                                  className={`call-timeline-reveal ${expanded ? "call-timeline-reveal-open" : ""}`}
                                  aria-hidden={!expanded}
                                  inert={!expanded ? true : undefined}
                                >
                                  <div className="call-timeline-clip">
                                    <div
                                      className="call-timeline"
                                      aria-label={`Call history for ${name}`}
                                    >
                                      {group.calls.map((call) => (
                                        <div
                                          className={`call-timeline-item ${call.unviewed ? "unviewed-row" : ""}`}
                                          key={call.id}
                                        >
                                          <CallDirection row={call} />
                                          <div className="call-timeline-detail">
                                            <strong>
                                              {call.outgoing
                                                ? "Outgoing"
                                                : "Incoming"}{" "}
                                              · {callOutcome(call)}
                                              {announcementLabel(call) &&
                                                ` · ${announcementLabel(call)}`}
                                              <CallCost row={call} />
                                            </strong>
                                            <div className="call-timeline-meta">
                                              <time>
                                                {formatCallDate(
                                                  call.timestamp,
                                                  timeZone,
                                                )}
                                              </time>
                                              {call.unviewed && (
                                                <button
                                                  type="button"
                                                  className="mark-viewed"
                                                  onClick={() =>
                                                    markCallViewed(call.id)
                                                  }
                                                >
                                                  Mark viewed
                                                </button>
                                              )}
                                            </div>
                                          </div>
                                          <span className="call-timeline-duration">
                                            {formatDuration(call.duration)}
                                          </span>
                                          {call.call_sid && (
                                            <button
                                              type="button"
                                              className="button button-light call-timeline-result"
                                              onClick={() =>
                                                openCallDetails(call.call_sid)
                                              }
                                            >
                                              {call.call_result === "summary"
                                                ? "Summary"
                                                : "Details"}
                                            </button>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
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
      <PhoneDrawer
        open={phoneOpen}
        ringing={ringing}
        onClose={() => setPhoneOpen(false)}
        callControls={
          running && (
            <div className="phone-live-controls">
              {ringing && (
                <button
                  className="button"
                  data-answer-call
                  onClick={voice.accept}
                >
                  <PhoneIncoming size={15} /> Answer
                </button>
              )}
              <button className="hangup-button" onClick={voice.hangup}>
                <PhoneOff size={16} /> {ringing ? "Decline" : "End call"}
              </button>
            </div>
          )
        }
      >
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
        {voice.call && (
          <div className="call-panel" role="status">
            <div>
              <span className="live-dot" />{" "}
              {ringing
                ? "Incoming call"
                : phoneState === "live"
                  ? "Call in progress"
                  : "Connecting"}
            </div>
            <strong>{voice.call.number}</strong>
            {[
              voice.call.workspaceName,
              voice.call.lineLabel,
              voice.call.localNumber,
            ].some(Boolean) && (
              <span>
                {[
                  voice.call.workspaceName,
                  voice.call.lineLabel,
                  voice.call.localNumber,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
          </div>
        )}
        {phoneContext?.notice && (
          <p className="notice" role="status">
            {phoneContext.notice}
          </p>
        )}
        {callSession?.assist &&
          running &&
          voice.call?.direction === "outgoing" && (
            <LivePrompter
              key={callSession.id}
              session={callSession}
              workspace={workspaceId}
            />
          )}
        {phoneContext?.lead && voice.call?.direction !== "incoming" && (
          <section className="card phone-brief">
            <h3>Callback preparation</h3>
            <p>
              {phoneContext.lead.callbackPromise || "No callback time promised"}
            </p>
            {phoneContext.lead.from &&
              normalizePhone(phoneContext.lead.from) !==
                normalizePhone(number) && (
                <p>Caller ID {phoneContext.lead.from}</p>
              )}
            {phoneContext.lead.summary && <p>{phoneContext.lead.summary}</p>}
            <Script lead={phoneContext.lead} fallback />
          </section>
        )}
        {phoneContext?.missed && voice.call?.direction !== "incoming" && (
          <section className="card phone-brief">
            <h3>Missed call script</h3>
            <p>
              Hi, this is [your name] from Iron Wing Dispatching. I’m returning
              your call. How can I help?
            </p>
          </section>
        )}
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
          {voice.member && voice.lines.length > 1 && (
            <div className="dial-field">
              <label htmlFor="caller-id">CALL AND TEXT FROM</label>
              <select
                id="caller-id"
                className="caller-id-select"
                value={voice.lineId}
                disabled={running || preparing || smsSending}
                onChange={(event) => voice.chooseLine(event.target.value)}
              >
                {voice.lines.map((line) => (
                  <option key={line.numberId} value={line.numberId}>
                    {line.label
                      ? `${line.label} · ${line.phoneNumber}`
                      : line.phoneNumber}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="dial-field">
            <label htmlFor="dial-number">PHONE NUMBER</label>
            <div className="input-wrap">
              {!number && (
                <button
                  aria-label="Add plus prefix"
                  disabled={!!number || running || preparing}
                  onClick={() => editNumber("+")}
                >
                  +
                </button>
              )}
              <input
                id="dial-number"
                type="tel"
                autoComplete="tel"
                value={number}
                disabled={running || preparing}
                onChange={(event) => editNumber(event.target.value)}
                onKeyDown={keyDown}
                placeholder="Enter a phone number"
              />
              <button
                aria-label="Delete last digit"
                disabled={!number || running || preparing}
                onClick={() => editNumber(number.slice(0, -1))}
              >
                <Delete size={19} />
              </button>
            </div>
          </div>
          {live && (
            <div className="call-actions">
              <button
                type="button"
                className="call-action-button"
                onClick={voice.toggleMute}
              >
                {voice.muted ? <MicOff size={17} /> : <Mic size={17} />}
                {voice.muted ? "Unmute" : "Mute"}
              </button>
              <button
                type="button"
                className="call-action-button"
                aria-expanded={callKeypadOpen}
                aria-controls="phone-keypad"
                onClick={() => setCallKeypadOpen((open) => !open)}
              >
                <Grid3x3 size={17} />
                {callKeypadOpen ? "Hide keypad" : "Keypad"}
              </button>
            </div>
          )}
          <div className="keypad-area">
            <div
              id="phone-keypad"
              className="keypad"
              hidden={live && !callKeypadOpen}
              inert={smsOpen ? true : undefined}
              aria-label={live ? "Call keypad" : "Dial pad"}
            >
              {keypad.map(([value, letters]) => (
                <button
                  key={value}
                  type="button"
                  disabled={
                    preparing || (running && voice.call.phase !== "active")
                  }
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
                  {smsBody.length}/1600 characters · Only message recipients who
                  have consented.
                </small>
              </div>
            )}
          </div>
          {!running && assistEligible && (
            <label className="phone-assist-toggle">
              <input
                type="checkbox"
                checked={assistSelected}
                disabled={preparing}
                onChange={(event) => setAssistSelected(event.target.checked)}
              />
              Live assist
            </label>
          )}
          <div className="dial-buttons">
            {!running && (
              <button
                className="call-button"
                disabled={!online || !number.trim() || preparing}
                onClick={dial}
              >
                <Phone size={18} /> {preparing ? "Preparing…" : "Call number"}
              </button>
            )}
            <button
              className="button sms-button"
              type="button"
              disabled={
                smsSending ||
                running ||
                preparing ||
                (smsOpen && (!number.trim() || !smsBody.trim()))
              }
              onClick={() => (smsOpen ? sendMessage() : setSmsOpen(true))}
            >
              <Send size={16} /> {smsSending ? "Sending…" : "Send message"}
            </button>
          </div>
          {smsFeedback && (
            <p
              className={
                smsFeedback.success ? "sms-success" : "contact-form-error"
              }
              role="status"
            >
              {smsFeedback.text}
            </p>
          )}
          <div className="dial-footer">
            <ShieldCheck size={14} />
            <span>Connected securely with Twilio</span>
          </div>
        </section>
        {phoneContext?.history && !ringing && (
          <HistoryResult
            key={phoneContext.history}
            callSid={phoneContext.history}
            workspace={workspaceId}
          />
        )}
        {!running && callSession?.callSid && !phoneContext?.history && (
          <CallResult
            key={callSession.id}
            data={callSession}
            workspace={workspaceId}
            onRetry={() => setSessionRevision((value) => value + 1)}
            onLeadDone={
              phoneContext?.lead?.callSid === callSession.leadSid &&
              phoneContext?.lead?.status === "new"
                ? async () => {
                    const saved = await setLeadStatus(
                      phoneContext.lead,
                      "called",
                    );
                    if (saved) setPhoneContext(null);
                    return saved;
                  }
                : undefined
            }
          />
        )}
      </PhoneDrawer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
