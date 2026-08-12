import { useEffect, useRef, useState } from 'react';

/**
 * Edit panel for a single card.
 *
 * Sends only the fields the user actually changed. `PATCH /cards/:cardId`
 * takes `{title?, description?, assigneeId?, dueDate?}` — sending an
 * unchanged `assigneeId` alongside a title edit would make a rename race
 * with someone else's reassignment and win for no reason.
 */
export function CardEditor({ card, members, onSave, onCancel, onDelete }) {
  const [title, setTitle] = useState(card.title ?? '');
  const [description, setDescription] = useState(card.description ?? '');
  const [assigneeId, setAssigneeId] = useState(card.assignee_id ?? '');
  const [dueDate, setDueDate] = useState(toDateInput(card.due_date));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const titleRef = useRef(null);
  useEffect(() => titleRef.current?.focus(), []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  async function handleSubmit(event) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    const patch = {};
    if (trimmed !== card.title) patch.title = trimmed;
    if (description !== (card.description ?? '')) {
      patch.description = description.trim() ? description : null;
    }
    if (assigneeId !== (card.assignee_id ?? '')) {
      patch.assigneeId = assigneeId || null;
    }
    if (dueDate !== toDateInput(card.due_date)) {
      patch.dueDate = fromDateInput(dueDate);
    }

    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        className="card card-editor"
        role="dialog"
        aria-modal="true"
        aria-label="Edit card"
        onSubmit={handleSubmit}
      >
        <label>
          Title
          <input
            ref={titleRef}
            type="text"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </label>

        <label>
          Description
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="field-row">
          <label>
            Assignee
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={memberUserId(m)} value={memberUserId(m)}>
                  {memberLabel(m)}
                </option>
              ))}
            </select>
          </label>

          <label>
            Due date
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="editor-actions">
          <button type="button" className="ghost danger" onClick={onDelete}>
            Delete
          </button>
          <div className="spacer" />
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

// `members` rows come from GET /api/orgs/:orgId/members, which nests the
// profile. The card's assignee_id is the profile/user id, not the
// membership id.
export function memberUserId(member) {
  return member.user_id ?? member.profile?.id ?? member.id;
}

export function memberLabel(member) {
  return member.profile?.full_name || member.profile?.email || 'Unknown user';
}

function toDateInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  // <input type="date"> only speaks YYYY-MM-DD, in local time.
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromDateInput(value) {
  if (!value) return null;
  // The column is timestamptz. Send an explicit instant — local midnight —
  // rather than a bare date, which Postgres would resolve in the server's
  // timezone and silently shift by a day for some users.
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
