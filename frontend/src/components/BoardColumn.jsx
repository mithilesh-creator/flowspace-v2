import { Fragment, useState } from 'react';

import { memberLabel } from './CardEditor.jsx';

/**
 * One list (column) and its cards.
 *
 * Drag and drop is the plain HTML5 API — no library. Two drags share the
 * surface, so every handler checks `drag.kind` before claiming the event:
 * a card drag is handled by the cards body and stops there, a list drag is
 * handled by the column root. Without the `stopPropagation` on the card
 * handlers a hover over a card would also register as a hover over the
 * column and the drop index would snap to the end of the list.
 */
export function BoardColumn({
  list,
  index,
  canWrite,
  canDeleteList,
  drag,
  dropHint,
  memberById,
  onDragStartCard,
  onDragStartList,
  onDragEnd,
  onHoverCard,
  onHoverList,
  onDropCard,
  onDropList,
  onRenameList,
  onDeleteList,
  onCreateCard,
  onOpenCard,
}) {
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const draggingList = drag?.kind === 'list';
  const draggingCard = drag?.kind === 'card';
  const cardHint =
    dropHint?.kind === 'card' && dropHint.listId === list.id ? dropHint.index : null;

  async function handleAdd(event) {
    event.preventDefault();
    const trimmed = newTitle.trim();
    if (!trimmed) return;

    setAdding(true);
    try {
      await onCreateCard(list.id, trimmed);
      setNewTitle('');
    } catch {
      // The board already surfaced the message; keep the draft title so
      // the user can retry without retyping it.
    } finally {
      setAdding(false);
    }
  }

  return (
    <section
      className={`column${drag?.listId === list.id && draggingList ? ' is-dragging' : ''}`}
      aria-label={list.title}
      onDragOver={(event) => {
        if (!draggingList) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const after = event.clientX > rect.left + rect.width / 2;
        onHoverList(index + (after ? 1 : 0));
      }}
      onDrop={(event) => {
        if (!draggingList) return;
        event.preventDefault();
        onDropList();
      }}
    >
      <header
        className="column-header"
        draggable={canWrite}
        onDragStart={(event) => {
          if (!canWrite) return;
          event.dataTransfer.effectAllowed = 'move';
          // Firefox refuses to start a drag without payload on the transfer.
          event.dataTransfer.setData('text/plain', list.id);
          onDragStartList(list);
        }}
        onDragEnd={onDragEnd}
      >
        <h2 title={canWrite ? 'Drag to reorder' : undefined}>{list.title}</h2>
        <span className="count">{list.cards.length}</span>
        {canWrite && (
          <div className="column-actions">
            <button type="button" className="ghost" onClick={() => onRenameList(list)}>
              Rename
            </button>
            {/* Deleting a list cascades every card in it, so it is
                owner|admin only — a member can delete individual cards but
                not the column holding them. */}
            {canDeleteList && (
              <button
                type="button"
                className="ghost danger"
                onClick={() => onDeleteList(list)}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </header>

      <ul
        className="column-cards"
        onDragOver={(event) => {
          if (!draggingCard) return;
          event.preventDefault();
          event.stopPropagation();
          onHoverCard(list.id, list.cards.length);
        }}
        onDrop={(event) => {
          if (!draggingCard) return;
          event.preventDefault();
          event.stopPropagation();
          onDropCard(list.id);
        }}
      >
        {list.cards.map((card, cardIndex) => (
          <Fragment key={card.id}>
            {cardHint === cardIndex && <li className="drop-indicator" aria-hidden="true" />}
            <li
              className={`kanban-card${drag?.cardId === card.id ? ' is-dragging' : ''}`}
              draggable={canWrite}
              onDragStart={(event) => {
                if (!canWrite) return;
                event.stopPropagation();
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', card.id);
                onDragStartCard(card, list.id);
              }}
              onDragEnd={onDragEnd}
              onDragOver={(event) => {
                if (!draggingCard) return;
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                const after = event.clientY > rect.top + rect.height / 2;
                onHoverCard(list.id, cardIndex + (after ? 1 : 0));
              }}
            >
              <button
                type="button"
                className="card-open"
                onClick={() => onOpenCard(card)}
                disabled={!canWrite}
              >
                <span className="card-title">{card.title}</span>
                {card.description && <span className="card-desc">{card.description}</span>}
                {(card.assignee_id || card.due_date) && (
                  <span className="card-meta">
                    {card.assignee_id && (
                      <span className="role-chip">
                        {memberById.has(card.assignee_id)
                          ? memberLabel(memberById.get(card.assignee_id))
                          : 'Assigned'}
                      </span>
                    )}
                    {card.due_date && (
                      <span className="muted small">
                        due {new Date(card.due_date).toLocaleDateString()}
                      </span>
                    )}
                  </span>
                )}
              </button>
            </li>
          </Fragment>
        ))}

        {cardHint === list.cards.length && (
          <li className="drop-indicator" aria-hidden="true" />
        )}

        {list.cards.length === 0 && cardHint === null && (
          <li className="muted small column-empty">No cards</li>
        )}
      </ul>

      {canWrite && (
        <form className="new-card" onSubmit={handleAdd}>
          <input
            type="text"
            value={newTitle}
            placeholder="Add a card"
            maxLength={200}
            aria-label={`Add a card to ${list.title}`}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button type="submit" disabled={adding || !newTitle.trim()}>
            {adding ? '…' : 'Add'}
          </button>
        </form>
      )}
    </section>
  );
}
