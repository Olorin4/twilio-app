import React, { useEffect, useState } from "react";
import { apiFetch } from "./api";

const terminal = ["completed", "failed", "busy", "no-answer", "canceled"];
const scope = (workspace) => ({ "X-Workspace-Id": workspace });
const fetchDetails = (path, workspace, signal) =>
  apiFetch(path, { headers: scope(workspace), signal });

export function useAssistEligibility(workspace, destination, enabled) {
  const [eligible, setEligible] = useState(null);
  useEffect(() => {
    setEligible(null);
    if (!enabled || !/^\+[1-9]\d{7,14}$/.test(destination)) return;
    const controller = new AbortController();
    fetchDetails(
      `/call-assist/eligibility?destination=${encodeURIComponent(destination)}`,
      workspace,
      controller.signal,
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!controller.signal.aborted)
          setEligible(data?.enabled ? { workspace, destination } : null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [workspace, destination, enabled]);
  return (
    enabled &&
    eligible?.workspace === workspace &&
    eligible.destination === destination
  );
}

export async function createCallIntent(workspace, fields) {
  const response = await apiFetch("/call-assist/intents", {
    method: "POST",
    headers: { ...scope(workspace), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(3500),
    body: JSON.stringify(fields),
  });
  if (!response.ok) throw new Error("Could not prepare call details.");
  return (await response.json()).id;
}

async function readEvents(response, receive) {
  if (!response.ok || !response.body)
    throw new Error("Live connection unavailable.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (event.startsWith("data: ") && receive(JSON.parse(event.slice(6))))
          return true;
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return false;
}

export function useCallSession(workspace, id, revision) {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const path = `/call-assist/sessions/${id}`;
    let retry;
    const receive = (data) => {
      if (!controller.signal.aborted) setSnapshot(data);
      return (
        terminal.includes(data.status) &&
        (!data.assist ||
          ["ready", "empty", "unavailable"].includes(data.summaryState))
      );
    };
    async function connect() {
      try {
        const response = await fetchDetails(path, workspace, controller.signal);
        if (response.status === 404) return;
        if (!response.ok) throw new Error("Call details unavailable.");
        if (receive(await response.json())) return;
        const events = await fetchDetails(
          `${path}/events`,
          workspace,
          controller.signal,
        );
        if (await readEvents(events, receive)) {
          const detail = await fetchDetails(path, workspace, controller.signal);
          if (detail.ok) receive(await detail.json());
          return;
        }
      } catch {
        // Keep the previous snapshot visible while reconnecting.
      }
      if (!controller.signal.aborted) retry = setTimeout(connect, 1200);
    }
    connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [workspace, id, revision]);
  return snapshot?.id === id ? snapshot : null;
}

export function LivePrompter({ session, workspace }) {
  const [pinned, setPinned] = useState(null);
  const [feedback, setFeedback] = useState("");
  const suggestion = pinned || session.suggestion;
  async function act(action) {
    setFeedback("");
    try {
      const response = await apiFetch(
        `/call-assist/sessions/${session.id}/${action}`,
        {
          method: "POST",
          headers: scope(workspace),
        },
      );
      if (!response.ok) throw new Error();
    } catch {
      setFeedback("Could not update live assist.");
    }
  }
  const label = {
    waiting: "Waiting for the caller to answer",
    listening: session.suggesting ? "Preparing a suggestion…" : "Listening",
    stopped: "Live assist stopped",
    unavailable: "Live assist unavailable",
  }[session.capture];
  return (
    <section
      className="card phone-brief live-prompter"
      aria-label="Live teleprompter"
    >
      <h3>Say next</h3>
      <p role="status">{session.stopping ? "Stopping…" : label}</p>
      {suggestion?.line && <p className="prompt-line">{suggestion.line}</p>}
      {suggestion?.hint && <p>{suggestion.hint}</p>}
      {session.suggestionFailed && (
        <p>Suggestion unavailable. The callback script is still available.</p>
      )}
      {session.suggestionLimit && (
        <p>Suggestion limit reached for this call.</p>
      )}
      {feedback && <p role="alert">{feedback}</p>}
      <div className="phone-result-actions">
        {suggestion && (
          <button
            className="button"
            aria-pressed={Boolean(pinned)}
            onClick={() => setPinned(pinned ? null : suggestion)}
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
        )}
        <button
          className="button"
          disabled={!session.canSuggest}
          onClick={() => act("suggest")}
        >
          Suggest next
        </button>
        <button
          className="button"
          disabled={
            session.stopping ||
            !["waiting", "listening"].includes(session.capture)
          }
          onClick={() => act("stop")}
        >
          Stop live assist
        </button>
      </div>
    </section>
  );
}

function CallSummary({ summary, partial }) {
  const fields = [
    ["Reason", summary.reason],
    ["Outcome", summary.outcome],
    ["Commitments", summary.commitments.join("\n")],
    ["Unanswered", summary.unanswered.join("\n")],
    ["Next action", summary.nextAction],
    ["Owner", summary.owner],
    ["Deadline", summary.deadline],
  ];
  return (
    <>
      <h4>{partial ? "Summary of partial transcript" : "Call summary"}</h4>
      <dl className="phone-summary">
        {fields
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </React.Fragment>
          ))}
      </dl>
    </>
  );
}

export function CallResult({ data, workspace, onSaved, onLeadDone, onRetry }) {
  const [notes, setNotes] = useState(data.notes || "");
  const [outcome, setOutcome] = useState(data.outcome || "");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const key = data.id ? `sessions/${data.id}` : `history/${data.callSid}`;
  async function save(event, markLead = false) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await apiFetch(`/call-assist/${key}`, {
        method: "PATCH",
        headers: { ...scope(workspace), "Content-Type": "application/json" },
        body: JSON.stringify({ notes, outcome: outcome || null }),
      });
      if (!response.ok) throw new Error();
      onSaved?.();
      const closed = markLead && (await onLeadDone());
      setFeedback(
        closed
          ? "Call result saved and lead marked done."
          : markLead
            ? "Call result saved. Could not mark the lead done."
            : "Call result saved.",
      );
    } catch {
      setFeedback("Could not save the call result.");
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    try {
      const response = await apiFetch(
        `/call-assist/sessions/${data.id}/retry`,
        {
          method: "POST",
          headers: scope(workspace),
        },
      );
      if (!response.ok) throw new Error();
      setFeedback("Summary queued.");
      onRetry?.();
    } catch {
      setFeedback("Summary retry unavailable.");
    }
  }
  return (
    <section className="card phone-brief phone-result">
      <h3>Call result</h3>
      {data.summaryState === "pending" && (
        <p role="status">Processing summary…</p>
      )}
      {data.summaryState === "unavailable" && (
        <p>
          Summary unavailable.{" "}
          <button className="button" onClick={retry}>
            Retry summary
          </button>
        </p>
      )}
      {data.summary && (
        <CallSummary summary={data.summary} partial={data.partial} />
      )}
      {data.transcript?.length > 0 && (
        <details>
          <summary>Transcript</summary>
          <ol className="lead-transcript">
            {data.transcript.map((turn, index) => (
              <li key={index}>
                <strong>{turn.speaker}:</strong> {turn.content}
              </li>
            ))}
          </ol>
        </details>
      )}
      <form onSubmit={save}>
        <label>
          Outcome
          <select
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="">Select an outcome</option>
            <option value="connected">Connected</option>
            <option value="no-answer">No answer</option>
            <option value="follow-up">Needs follow-up</option>
          </select>
        </label>
        <label>
          Notes
          <textarea
            value={notes}
            maxLength={4000}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <div className="phone-result-actions">
          <button className="button" type="submit" disabled={busy}>
            Save result
          </button>
          {onLeadDone && data.leadSid && (
            <button
              className="button"
              type="button"
              disabled={busy || outcome !== "connected"}
              onClick={(event) => save(event, true)}
            >
              Mark lead done
            </button>
          )}
        </div>
      </form>
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}

export function HistoryResult({ callSid, workspace }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    function refreshDetails() {
      fetchDetails(
        `/call-assist/history/${callSid}`,
        workspace,
        controller.signal,
      )
        .then((response) => {
          if (!response.ok) throw new Error();
          return response.json();
        })
        .then((value) => {
          if (!controller.signal.aborted) {
            setData(value);
            setError(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        });
    }
    refreshDetails();
    const timer = setInterval(refreshDetails, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [callSid, workspace, revision]);
  if (error) return <p role="alert">Call details unavailable.</p>;
  if (!data) return <p role="status">Loading call details…</p>;
  return (
    <CallResult
      data={data}
      workspace={workspace}
      onSaved={refresh}
      onRetry={refresh}
    />
  );
}
