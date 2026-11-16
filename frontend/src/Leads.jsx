import React, { useState } from "react";
import { Check, ChevronDown, PhoneOutgoing, UserPlus, X } from "lucide-react";
import { formatCallDate } from "./callDate.mjs";
import {
  badge,
  callbackTarget,
  callerIdNote,
  carrierLine,
  leadTitle,
  promiseLine,
  unread,
} from "./leadCard.mjs";

function Script({ lead }) {
  const script = lead.script || {};
  const unanswered = lead.details?.unanswered || [];
  const hasScript =
    script.opener ||
    script.next_step ||
    script.points?.length ||
    script.objections?.length;
  if (!hasScript && !unanswered.length) return null;
  return (
    <div className="lead-section">
      <h3>Suggested script</h3>
      <ol className="lead-script">
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

function LeadCard({ lead, timeZone, canCall, onCall, onStatus }) {
  const [open, setOpen] = useState(false);
  const target = callbackTarget(lead);
  const title = leadTitle(lead);
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
      {(lead.outcome === "lead" || lead.mcNumber || lead.usdot) && (
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
                  <strong>{turn.role === "caller" ? "Caller" : "Jack"}:</strong>{" "}
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
                : "Connect the phone and finish any current call first"
          }
          onClick={() => onCall(target)}
        >
          <PhoneOutgoing size={14} />
          {target ? `Call back ${target}` : "No callback number"}
        </button>
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
}) {
  const waiting = leads.filter(unread).length;
  return (
    <section className="activity-card card">
      <div className="activity-heading">
        <div>
          <div className="card-kicker">AI RECEPTIONIST</div>
          <h2>Leads</h2>
          <p>
            {waiting > 0
              ? `${waiting} waiting for your callback.`
              : "Callers Jack spoke to, newest first."}
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
            <strong>No calls from the receptionist yet</strong>
            <span>
              When Jack answers a call, the summary and script appear here.
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
            />
          ))}
        </div>
      )}
    </section>
  );
}
