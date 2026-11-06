import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BookUser, Mail, Pencil, Phone, Plus, Trash2, X } from "lucide-react";
import Pagination from "./Pagination";
import ActivityTable from "./ActivityTable";
import { apiFetch } from "./api";

const emptyContact = { name: "", phone: "", company: "", email: "", notes: "" };
const initialLetters = (name) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

async function request(url, options) {
  const response = await apiFetch(url, options);
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data.error || "Could not update contacts. Please try again.",
    );
  return data;
}

export default function Contacts({ onDial }) {
  const [contacts, setContacts] = useState([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyContact);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    try {
      setContacts(await request("/contacts"));
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return contacts.filter((c) =>
      [c.name, c.phone, c.company, c.email].some((value) =>
        (value || "").toLowerCase().includes(term),
      ),
    );
  }, [contacts, query]);
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const pageContacts = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const openEditor = (contact) => {
    setEditing(contact || { id: null });
    setForm(
      contact
        ? Object.fromEntries(
            Object.keys(emptyContact).map((key) => [key, contact[key] || ""]),
          )
        : { ...emptyContact },
    );
    setFormError("");
  };
  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError("");
    try {
      const saved = await request(
        editing.id ? `/contacts/${editing.id}` : "/contacts",
        {
          method: editing.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        },
      );
      setContacts((items) =>
        [...items.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setEditing(null);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async (contact) => {
    if (!window.confirm(`Delete ${contact.name} from your contacts?`)) return;
    setDeleting(contact.id);
    setError("");
    try {
      await request(`/contacts/${contact.id}`, { method: "DELETE" });
      setContacts((items) => items.filter((item) => item.id !== contact.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <ActivityTable
        kicker="YOUR ADDRESS BOOK"
        title={
          <>
            Contacts <span className="contacts-count">{contacts.length}</span>
          </>
        }
        description="Keep the people you call close at hand."
        headingAction={
          <button
            className="button button-green"
            onClick={() => openEditor(null)}
          >
            <Plus size={16} /> Add contact
          </button>
        }
        headingNotice={
          error && (
            <div className="heading-notice" role="alert">
              {error} <button onClick={load}>Retry</button>
            </div>
          )
        }
        searchLabel="Search contacts"
        searchPlaceholder="Search contacts"
        searchValue={query}
        onSearchChange={(value) => {
          setQuery(value);
          setPage(1);
        }}
      >
        {loading ? (
          <div className="empty">Loading contacts…</div>
        ) : error && contacts.length === 0 ? null : filtered.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <BookUser size={23} />
            </div>
            <strong>
              {query ? "No matching contacts" : "Your address book is empty"}
            </strong>
            <span>
              {query
                ? "Try a different search."
                : "Add a contact to find their number quickly."}
            </span>
            {!query && (
              <button
                className="button button-light empty-add"
                onClick={() => openEditor(null)}
              >
                <Plus size={15} /> Add your first contact
              </button>
            )}
          </div>
        ) : (
          <div className="contacts-list">
            {pageContacts.map((contact) => (
              <article className="contact-row" key={contact.id}>
                <div className="avatar avatar-contact">
                  {initialLetters(contact.name)}
                </div>
                <div className="contact-info">
                  <strong>{contact.name}</strong>
                  <span>{contact.company || contact.phone}</span>
                  {contact.company && <span>{contact.phone}</span>}
                  {contact.email && (
                    <span className="contact-email">
                      <Mail size={12} />
                      {contact.email}
                    </span>
                  )}
                  {contact.notes && (
                    <span className="contact-note">{contact.notes}</span>
                  )}
                </div>
                <div className="contact-actions">
                  <button
                    className="quick-call"
                    aria-label={`Use ${contact.name} in dialer`}
                    title="Use number in dialer"
                    onClick={() => onDial(contact.phone)}
                  >
                    <Phone size={15} />
                  </button>
                  <button
                    className="quick-call"
                    aria-label={`Edit ${contact.name}`}
                    title="Edit contact"
                    onClick={() => openEditor(contact)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="quick-call delete-contact"
                    aria-label={`Delete ${contact.name}`}
                    title="Delete contact"
                    disabled={deleting === contact.id}
                    onClick={() => remove(contact)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        <Pagination
          label="Contacts pagination"
          page={currentPage}
          pageSize={pageSize}
          hasMore={currentPage * pageSize < filtered.length}
          loading={loading}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPage(1);
            setPageSize(size);
          }}
        />
      </ActivityTable>
      {editing && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving)
              setEditing(null);
          }}
        >
          <section
            className="modal card contact-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-form-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !saving) setEditing(null);
            }}
          >
            <div className="modal-title">
              <div>
                <div className="card-kicker">ADDRESS BOOK</div>
                <h2 id="contact-form-title">
                  {editing.id ? "Edit contact" : "Add a contact"}
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close contact form"
                disabled={saving}
                onClick={() => setEditing(null)}
              >
                <X size={20} />
              </button>
            </div>
            <p>Keep important contact details in one place.</p>
            <form onSubmit={save}>
              <div className="contact-form-grid">
                <label>
                  Name <span>*</span>
                  <input
                    autoFocus
                    required
                    maxLength={120}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Full name"
                  />
                </label>
                <label>
                  Phone number <span>*</span>
                  <input
                    required
                    type="tel"
                    maxLength={32}
                    value={form.phone}
                    onChange={(e) =>
                      setForm({ ...form, phone: e.target.value })
                    }
                    placeholder="+15551234567"
                  />
                  <small>Include the country code, for example +1.</small>
                </label>
                <label>
                  Company
                  <input
                    maxLength={120}
                    value={form.company}
                    onChange={(e) =>
                      setForm({ ...form, company: e.target.value })
                    }
                    placeholder="Company name"
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    maxLength={254}
                    value={form.email}
                    onChange={(e) =>
                      setForm({ ...form, email: e.target.value })
                    }
                    placeholder="name@example.com"
                  />
                </label>
                <label className="contact-notes">
                  Notes
                  <textarea
                    maxLength={2000}
                    rows={3}
                    value={form.notes}
                    onChange={(e) =>
                      setForm({ ...form, notes: e.target.value })
                    }
                    placeholder="Add a note"
                  />
                </label>
              </div>
              {formError && (
                <div className="contact-form-error" role="alert">
                  {formError}
                </div>
              )}
              <div className="contact-form-actions">
                <button
                  type="button"
                  className="button button-light"
                  disabled={saving}
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
                <button className="button button-green" disabled={saving}>
                  {saving ? "Saving…" : "Save contact"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
