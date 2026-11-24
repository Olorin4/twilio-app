import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  MessageSquare,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Sparkles,
  X,
} from "lucide-react";
import { apiFetch } from "./api";
import { relativeTime } from "./timeline.mjs";

const PAGE = 20;

function KindIcon({ entry }) {
  if (entry.kind === "text") return <MessageSquare size={16} />;
  if (entry.kind === "agent_call") return <Bot size={16} />;
  if (entry.kind === "assist") return <Sparkles size={16} />;
  if (entry.direction === "inbound") return <PhoneIncoming size={16} />;
  if (entry.direction === "outbound") return <PhoneOutgoing size={16} />;
  return <Phone size={16} />;
}

const KIND_LABEL = {
  call: "Call",
  text: "Text",
  agent_call: "AI agent call",
  assist: "Live Assist",
};

export default function Timeline({ phone, workspaceId, onClose, onOpenLink }) {
  const [contact, setContact] = useState(null);
  const [entries, setEntries] = useState([]);
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  const load = useCallback(
    async (cursor) => {
      const request = ++requestRef.current;
      setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({ limit: String(PAGE) });
        if (cursor) query.set("cursor", cursor);
        const response = await apiFetch(
          `/contacts/${encodeURIComponent(phone)}/timeline?${query}`,
          { headers: { "X-Workspace-Id": workspaceId } },
        );
        const data = await response.json().catch(() => ({}));
        if (request !== requestRef.current) return;
        if (!response.ok)
          throw new Error(data.error || "Could not load the history.");
        setContact(data.contact || null);
        setEntries((current) =>
          cursor ? [...current, ...(data.entries || [])] : data.entries || [],
        );
        setNext(data.next || null);
      } catch (err) {
        if (request === requestRef.current)
          setError(err.message || "Could not load the history.");
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [phone, workspaceId],
  );

  useEffect(() => {
    setEntries([]);
    setNext(null);
    setContact(null);
    load(null);
    return () => {
      requestRef.current++;
    };
  }, [load]);

  const title = contact?.name || phone;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal card timeline-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="timeline-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="modal-title">
          <div>
            <div className="card-kicker">HISTORY</div>
            <h2 id="timeline-title">{title}</h2>
            {contact?.name && (
              <p className="timeline-sub">
                {contact.company ? `${contact.company} · ` : ""}
                {phone}
              </p>
            )}
          </div>
          <button
            className="icon-button"
            aria-label="Close history"
            autoFocus
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {error && (
          <div className="notice error" role="alert">
            {error}{" "}
            <button
              className="button button-light"
              onClick={() => load(entries.length ? next : null)}
            >
              Try again
            </button>
          </div>
        )}
        {!error && !loading && entries.length === 0 && (
          <div className="empty">No history with this number yet.</div>
        )}
        {loading && entries.length === 0 && !error && (
          <div className="empty">Loading history…</div>
        )}
        {entries.length > 0 && (
          <ol className="timeline-list">
            {entries.map((entry) => (
              <li className="timeline-entry" key={`${entry.kind}-${entry.id}`}>
                <span
                  className="timeline-icon"
                  title={KIND_LABEL[entry.kind] || entry.kind}
                  aria-label={KIND_LABEL[entry.kind] || entry.kind}
                  role="img"
                >
                  <KindIcon entry={entry} />
                </span>
                <div className="timeline-body">
                  <div className="timeline-meta">
                    <time
                      dateTime={entry.at}
                      title={new Date(entry.at).toLocaleString()}
                    >
                      {relativeTime(entry.at)}
                    </time>
                    {entry.line && <span>{entry.line}</span>}
                  </div>
                  <div className="timeline-summary">{entry.summary}</div>
                </div>
                {entry.link && (
                  <button
                    className="button button-light"
                    onClick={() => onOpenLink(entry.link)}
                  >
                    Open
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        {next && !error && (
          <button
            className="button button-light timeline-more"
            disabled={loading}
            onClick={() => load(next)}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
    </div>
  );
}
