import React, { useState } from "react";
import {
  Check,
  ChevronDown,
  History,
  PhoneOutgoing,
  UserPlus,
  X,
} from "lucide-react";
import { formatCallDate } from "./callDate.mjs";
import { isTimelinePhone } from "./timeline.mjs";
import {
  badge,
  callbackTarget,
  historyTarget,
  callerIdNote,
  carrierLine,
  leadTitle,
  promiseLine,
  unread,
} from "./leadCard.mjs";

// Old rows (agentKind null) are all Iron Wing receptionist calls.
const isReceptionist = (lead) =>
  !lead.agentKind || lead.agentKind === "receptionist";

export function Script({ lead, fallback = false }) {
  const script = lead.script || {};
  const unanswered = lead.details?.unanswered || [];
  const hasScript =
    script.opener ||
    script.next_step ||
    script.points?.length ||
    script.objections?.length;
  const placeholder = fallback && lead.outcome === "lead";
  if (!hasScript && !unanswered.length && !placeholder) return null;
  const receptionist = isReceptionist(lead);
  const persona = lead.agentPersonaName || "our assistant";
  return (
    <div className="lead-section">
      <h3>{receptionist ? "Suggested script" : "To do"}</h3>
      <ol className="lead-script">
        {!script.opener && placeholder && (
          <li>
            Hi, this is [your name]. {persona} said you called. Is now a good
            time? What would you like help with first?
          </li>
        )}
        {script.opener && (
          <li>
            <strong>Open:</strong> {script.opener}
          </li>
        )}
        {(script.points || []).map((point, index) => (
          <li key={`point-${index}`}>{point}</li>
        ))}
        {(script.objections || []).map((item, index) => (
          <li key={`objection-${index}`}>
            <strong>{item.objection}:</strong> {item.answer}
          </li>
        ))}
        {unanswered.length > 0 && (
          <li>
            <strong>Couldn&apos;t answer on the call:</strong>{" "}
            {unanswered.join("; ")}
          </li>
        )}
        {script.next_step && (
          <li>
            <strong>Ask for:</strong> {script.next_step}
          </li>
        )}
      </ol>
    </div>
  );
}

function LeadCard({ lead, timeZone, canCall, onCall, onStatus, onHistory }) {
  const [open, setOpen] = useState(false);
  const target = callbackTarget(lead);
  const historyPhone = historyTarget(lead);
  const title = leadTitle(lead);
  // Only old Iron Wing rows (no kind recorded) were all answered by Jack.
  const speaker = lead.agentPersonaName || (lead.agentKind ? "Agent" : "Jack");
  const receptionist = isReceptionist(lead);
  const turns = Array.isArray(lead.transcript) ? lead.transcript : [];
  return (
    <article
      className={unread(lead) ? "lead-card lead-unread" : "lead-card"}
      aria-label={`${badge(lead)}: ${title}`}
    >
      <header className="lead-top">
        <span className={`lead-badge lead-badge-${lead.outcome}`}>
          {badge(lead)}
        </span>
        <span className="lead-promise">{promiseLine(lead)}</span>
        <time className="lead-time">
          {formatCallDate(lead.startedAt, timeZone)}
        </time>
      </header>
      <h3 className="lead-title">{title}</h3>
      {callerIdNote(lead) && (
        <p className="lead-carrier">{callerIdNote(lead)}</p>
      )}
      {/* "No authority yet" only means something for a prospective carrier. */}
      {receptionist &&
        (lead.outcome === "lead" || lead.mcNumber || lead.usdot) && (
          <p className="lead-carrier">{carrierLine(lead)}</p>
        )}
      {lead.summary && (
        <div className="lead-section">
          <h3>Summary</h3>
          <p className="lead-summary">{lead.summary}</p>
        </div>
      )}
      <Script lead={lead} />
      {turns.length > 0 && (
        <div className="lead-section">
          <button
            className="lead-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown
              size={14}
              className={open ? "lead-chevron-open" : ""}
            />
            {open ? "Hide transcript" : "Transcript"}
          </button>
          {open && (
            <ol className="lead-transcript">
              {turns.map((turn, index) => (
                <li key={index}>
                  <strong>
                    {turn.role === "caller" ? "Caller" : speaker}:
                  </strong>{" "}
                  {turn.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <footer className="lead-actions">
        <button
          className="button lead-call"
          disabled={!target || !canCall}
          title={
            !target
              ? "The caller gave no number to call back"
              : canCall
                ? `Call ${target}`
                : "Finish the current call first"
          }
          onClick={() => onCall(target, lead)}
        >
          <PhoneOutgoing size={14} />
          {target ? `Call back ${target}` : "No callback number"}
        </button>
        {onHistory && isTimelinePhone(historyPhone) && (
          <button
            className="button button-light"
            onClick={() => onHistory(historyPhone)}
          >
            <History size={14} /> History
          </button>
        )}
        {lead.status === "new" ? (
          <>
            <button
              className="button button-light"
              onClick={() => onStatus(lead, "called")}
            >
              <Check size={14} /> Mark done
            </button>
            <button
              className="button button-light"
              onClick={() => onStatus(lead, "dismissed")}
            >
              <X size={14} /> Not a lead
            </button>
          </>
        ) : (
          <button
            className="button button-light"
            onClick={() => onStatus(lead, "new")}
          >
            {lead.status === "called" ? "Done" : "Dismissed"} · reopen
          </button>
        )}
      </footer>
    </article>
  );
}

export default function Leads({
  leads,
  loading,
  error,
  timeZone,
  canCall,
  onCall,
  onStatus,
  onHistory,
}) {
  const waiting = leads.filter(unread).length;
  return (
    <section className="activity-card card">
      <div className="activity-heading">
        <div>
          <div className="card-kicker">AI AGENTS</div>
          <h2>Leads</h2>
          <p>
            {waiting > 0
              ? `${waiting} waiting for your callback.`
              : "Calls your AI agents answered, newest first."}
          </p>
        </div>
      </div>
      {error && (
        <div className="notice error lead-notice" role="alert">
          {error}
        </div>
      )}
      {loading && leads.length === 0 ? (
        <div className="empty">Loading leads…</div>
      ) : leads.length === 0 ? (
        !error && (
          <div className="empty">
            <div className="empty-icon">
              <UserPlus size={23} />
            </div>
            <strong>No calls from your AI agents yet</strong>
            <span>
              When an AI agent answers a call, the summary and script appear
              here.
            </span>
          </div>
        )
      ) : (
        <div className="leads-list">
          {leads.map((lead) => (
            <LeadCard
              key={lead.callSid}
              lead={lead}
              timeZone={timeZone}
              canCall={canCall}
              onCall={onCall}
              onStatus={onStatus}
              onHistory={onHistory}
            />
          ))}
        </div>
      )}
    </section>
  );
}
