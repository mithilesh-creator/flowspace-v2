import { useEffect, useMemo, useRef, useState } from 'react';

import { cardAssigneeId, cardDueDate } from '../lib/board.js';

/**
 * Edit panel for a single card.
 *
 * Sends only the fields the user actually changed. `PATCH /cards/:cardId`
 * takes `{title?, description?, assigneeId?, dueDate?}` — sending an
 * unchanged `assigneeId` alongside a title edit would make a rename race
 * with someone else's reassignment and win for no reason. Nothing else is
 * ever put in the body: `board_id` in particular travels in the URL, and
 * the server reads it from the authorised route param.
 */
export function CardEditor({
  card,
  members,
  membersStatus = 'ready',
  onSave,
  onCancel,
  onDelete,
}) {
  const currentAssignee = cardAssigneeId(card) ?? '';

  const [title, setTitle] = useState(card.title ?? '');
  const [description, setDescription] = useState(card.description ?? '');
  const [assigneeId, setAssigneeId] = useState(currentAssignee);
  const [dueDate, setDueDate] = useState(toDateInput(cardDueDate(card)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // H6 — the picker offers org members and nothing else, because
  // `cards(org_id, assignee_id)` is now a foreign key onto `memberships`
  // and anyone else is a save the database will refuse.
  //
  // The exception is the card's *current* assignee when they have since
  // been removed from the workspace: the row still points at them, and
  // silently dropping them from the picker would turn "save the title"
  // into "unassign this card" without anyone choosing that. Keep them,
  // labelled, so the user can see the situation and decide.
  const options = useMemo(() => {
    const rows = members.map((m) => ({
      value: memberUserId(m),
      label: memberOptionLabel(m),
      stale: false,
    }));

    const orphaned =
      currentAssignee &&
      membersStatus === 'ready' &&
      !rows.some((o) => o.value === currentAssignee);

    if (orphaned) {
      rows.unshift({
        value: currentAssignee,
        label: 'Former member — no longer in this workspace',
        stale: true,
      });
    }
    return rows;
  }, [members, membersStatus, currentAssignee]);

  const staleAssignee = options.some((o) => o.stale && o.value === assigneeId);

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
    if (assigneeId !== currentAssignee) {
      patch.assigneeId = assigneeId || null;
    }
    if (dueDate !== toDateInput(cardDueDate(card))) {
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
            <select
              value={assigneeId}
              aria-describedby={staleAssignee ? 'assignee-note' : undefined}
              disabled={membersStatus === 'loading'}
              onChange={(e) => setAssigneeId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
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

        {membersStatus === 'error' && (
          <p className="muted small">
            Could not load the workspace members, so the assignee list is
            incomplete. Reload before changing it.
          </p>
        )}
        {staleAssignee && (
          <p id="assignee-note" className="muted small">
            This card is assigned to someone who has left the workspace. Saving
            keeps them; pick someone else or Unassigned to clear it.
          </p>
        )}

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

/**
 * Label for a row in the assignee picker.
 *
 * Distinct from memberLabel, which is the bare name shown on a card chip
 * where space is tight and the role would be noise. In an open dropdown
 * the role is what disambiguates two people with similar names, and it
 * makes it obvious at a glance that you are about to assign work to a
 * `client` — who cannot act on it, since the portal role is read-only.
 */
export function memberOptionLabel(member) {
  const name = memberLabel(member);
  return member.role ? `${name} (${member.role})` : name;
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
