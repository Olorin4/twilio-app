import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, MessageSquare, Send, UserRound } from "lucide-react";
import Pagination from "./Pagination";
import { apiFetch } from "./api";

function nameFor(phone, contacts) {
  const matches = contacts.filter((contact) => contact.phone === phone);
  return matches.length === 1 ? matches[0].name : phone;
}
function time(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Date unavailable";
}
export default function Conversations({
  contacts,
  search,
  refreshRevision = 0,
  onErrorChange,
}) {
  const [list, setList] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [phone, setPhone] = useState("");
  const [localNumber, setLocalNumber] = useState("");
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [body, setBody] = useState("");
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const requestVersion = useRef(0);
  const selected = useRef({ phone, localNumber });
  const loadedOlder = useRef(false);
  selected.current = { phone, localNumber };
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const { phone: target, localNumber: targetLocal } = selected.current;
      const [listResponse, threadResponse] = await Promise.all([
        apiFetch("/conversations"),
        target
          ? apiFetch(
              `/conversation?${new URLSearchParams({ phone: target, localNumber: targetLocal })}`,
            )
          : Promise.resolve(null),
      ]);
      if (!listResponse.ok || (threadResponse && !threadResponse.ok))
        throw new Error("Could not load conversations.");
      const listData = await listResponse.json();
      const threadData = threadResponse ? await threadResponse.json() : null;
      if (version !== requestVersion.current) return;
      setList(listData);
      if (threadData) {
        setMessages((previous) => {
          const recentIds = new Set(
            threadData.messages.map((message) => message.id),
          );
          return [
            ...previous.filter(
              (message) => message._older && !recentIds.has(message.id),
            ),
            ...threadData.messages,
          ];
        });
        if (!loadedOlder.current) setHasMore(threadData.hasMore);
        const throughId = threadData.messages.reduce(
          (max, message) =>
            BigInt(message.id) > BigInt(max) ? String(message.id) : max,
          "0",
        );
        if (
          throughId !== "0" &&
          selected.current.phone === target &&
          selected.current.localNumber === targetLocal
        ) {
          const response = await apiFetch("/activity-views/conversation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              phone: target,
              localNumber: targetLocal,
              throughId: String(throughId),
            }),
          });
          if (!response.ok)
            throw new Error("Could not mark messages as viewed.");
        }
      }
      onErrorChange("");
    } catch (err) {
      if (version === requestVersion.current) onErrorChange(err.message);
    }
  }, [onErrorChange]);
  useEffect(
    () => () => {
      requestVersion.current++;
      onErrorChange("");
    },
    [onErrorChange],
  );
  useEffect(() => {
    loadedOlder.current = false;
    setMessages([]);
    setHasMore(false);
    setFeedback("");
    load();
  }, [phone, localNumber, load]);
  useEffect(() => {
    if (refreshRevision) load();
  }, [refreshRevision, load]);
  useEffect(() => {
    const stream = new EventSource("/message-events");
    stream.addEventListener("ready", load);
    stream.addEventListener("messages", load);
    const timer = setInterval(load, 60000);
    return () => {
      stream.close();
      clearInterval(timer);
    };
  }, [load]);
  const older = async () => {
    if (!messages.length) return;
    const target = phone;
    try {
      const response = await apiFetch(
        `/conversation?${new URLSearchParams({ phone: target, localNumber, before: String(messages[0].id) })}`,
      );
      if (!response.ok) throw new Error("Could not load older messages.");
      const data = await response.json();
      if (
        selected.current.phone !== target ||
        selected.current.localNumber !== localNumber
      )
        return;
      loadedOlder.current = true;
      setMessages((current) => [
        ...data.messages.map((item) => ({ ...item, _older: true })),
        ...current,
      ]);
      setHasMore(data.hasMore);
    } catch (err) {
      onErrorChange(err.message);
    }
  };
  const send = async (event) => {
    event.preventDefault();
    if (inFlight.current || !body.trim() || !phone) return;
    inFlight.current = true;
    setSending(true);
    setFeedback("");
    try {
      let response;
      try {
        response = await apiFetch("/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: phone, body, localNumber }),
        });
      } catch {
        throw new Error(
          "Could not confirm whether the message was sent. Check Twilio before retrying.",
        );
      }
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not send message.");
      setBody("");
      setFeedback(
        data.saved
          ? "Accepted by Twilio."
          : "Accepted by Twilio, but not saved to history. Check Twilio before retrying.",
      );
      load();
    } catch (err) {
      setFeedback(err.message);
    } finally {
      setSending(false);
      inFlight.current = false;
    }
  };
  const filtered = list.filter((item) =>
    `${nameFor(item.phone, contacts)} ${item.phone} ${item.body || ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  useEffect(() => setPage(1), [search]);
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const pageItems = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  return (
    <div className="conversations">
      {!phone ? (
        <>
          <div className="conversation-list">
            {!filtered.length ? (
              <div className="empty">
                <MessageSquare size={23} />
                <strong>
                  {search
                    ? "No matching conversations"
                    : "No conversations yet"}
                </strong>
              </div>
            ) : (
              pageItems.map((item) => {
                const name = nameFor(item.phone, contacts);
                return (
                  <button
                    className={`conversation-row ${Number(item.unviewed_count) > 0 ? "unviewed-row" : ""}`}
                    key={`${item.local_number}:${item.phone}`}
                    onClick={() => {
                      setLocalNumber(item.local_number);
                      setPhone(item.phone);
                    }}
                  >
                    <span
                      className={`avatar ${name !== item.phone ? "avatar-contact" : "avatar-unknown"}`}
                    >
                      {name !== item.phone ? (
                        name.charAt(0).toUpperCase()
                      ) : (
                        <UserRound size={20} />
                      )}
                    </span>
                    <span className="row-main">
                      <strong>{name}</strong>
                      <span>
                        {item.body || "[No message content]"} ·{" "}
                        {item.local_number}
                      </span>
                    </span>
                    {Number(item.unviewed_count) > 0 && (
                      <span
                        className="unviewed-count"
                        aria-label={`${item.unviewed_count} unviewed messages`}
                      >
                        {item.unviewed_count}
                      </span>
                    )}
                    <time>{time(item.timestamp)}</time>
                  </button>
                );
              })
            )}
          </div>
          <Pagination
            label="Conversations pagination"
            page={currentPage}
            pageSize={pageSize}
            hasMore={currentPage * pageSize < filtered.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPage(1);
              setPageSize(size);
            }}
          />
        </>
      ) : (
        <section
          className="thread"
          aria-label={`Conversation with ${nameFor(phone, contacts)}`}
        >
          <div className="thread-heading">
            <button
              className="icon-button"
              aria-label="Back to conversations"
              onClick={() => {
                setPhone("");
                setLocalNumber("");
              }}
            >
              <ArrowLeft size={18} />
            </button>
            <div>
              <strong>{nameFor(phone, contacts)}</strong>
              <span>
                {phone} · {localNumber}
              </span>
            </div>
          </div>
          <div className="thread-messages">
            {hasMore && (
              <button className="button button-light" onClick={older}>
                Load older messages
              </button>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={`bubble ${message.outgoing ? "outgoing" : "incoming"}`}
              >
                <div>{message.body || "[No message content]"}</div>
                <small>
                  {time(message.timestamp)}
                  {message.outgoing && message.status
                    ? ` · ${message.status}`
                    : ""}
                  {message.error_code ? ` (${message.error_code})` : ""}
                </small>
              </div>
            ))}
          </div>
          <form className="thread-compose" onSubmit={send}>
            <label htmlFor="thread-message">Reply</label>
            <textarea
              id="thread-message"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={1600}
              rows={3}
              placeholder="Write a message"
            />
            <div>
              <small>
                {body.length}/1600 · Only message consenting recipients.
              </small>
              <button
                className="button button-green"
                disabled={sending || !body.trim()}
              >
                <Send size={15} /> {sending ? "Sending…" : "Send"}
              </button>
            </div>
            {feedback && <p role="status">{feedback}</p>}
          </form>
        </section>
      )}
    </div>
  );
}
