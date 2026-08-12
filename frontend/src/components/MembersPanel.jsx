import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';

const ADMIN_ROLES = ['owner', 'admin'];
const ASSIGNABLE = ['member', 'admin', 'client'];

export function MembersPanel({ orgId, role, socket }) {
  const { accessToken } = useAuth();
  const isAdmin = ADMIN_ROLES.includes(role);

  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteUrl, setInviteUrl] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken || !orgId) return;

    try {
      const { members: list } = await api.listMembers(accessToken, orgId);
      setMembers(list);

      // Only admins may read invitations — the RLS policy says so, and
      // the API returns 403. Not an error worth showing a member.
      if (ADMIN_ROLES.includes(role)) {
        const { invitations: invites } = await api.listInvitations(accessToken, orgId);
        setInvitations(invites.filter((i) => !i.accepted_at));
      } else {
        setInvitations([]);
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, orgId, role]);

  useEffect(() => {
    setInviteUrl(null);
    load();
  }, [load]);

  // Someone redeemed an invitation while we were looking at the list.
  useEffect(() => {
    if (!socket || !orgId) return undefined;

    const onJoined = (payload) => {
      if (payload?.orgId !== orgId) return;
      load();
    };

    socket.on('member:joined', onJoined);
    return () => socket.off('member:joined', onJoined);
  }, [socket, orgId, load]);

  async function handleInvite(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInviteUrl(null);

    try {
      const result = await api.createInvitation(accessToken, orgId, {
        email: email.trim(),
        role: inviteRole,
      });
      // Shown once and never retrievable again — the server stores only
      // a hash of this token.
      setInviteUrl(result.inviteUrl);
      setEmail('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(invitation) {
    if (!window.confirm(`Revoke the invitation for ${invitation.email}?`)) return;

    try {
      await api.revokeInvitation(accessToken, orgId, invitation.id);
      setInvitations((prev) => prev.filter((i) => i.id !== invitation.id));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="members">
      <h2 className="section-title">People</h2>

      <ul className="people-list">
        {members.map((m) => (
          <li key={m.id}>
            <span>{m.profile?.full_name || m.profile?.email || 'Unknown user'}</span>
            <span className="role-chip">{m.role}</span>
          </li>
        ))}
      </ul>

      {isAdmin && (
        <>
          <form className="invite-form" onSubmit={handleInvite}>
            <input
              type="email"
              value={email}
              placeholder="teammate@company.com"
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              {ASSIGNABLE.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy || !email.trim()}>
              {busy ? 'Inviting…' : 'Invite'}
            </button>
          </form>

          {inviteUrl && (
            <div className="invite-result">
              <p className="small">
                Send this link to the invitee. It is shown once — the server
                keeps only a hash of it.
              </p>
              <code>{inviteUrl}</code>
              <button
                type="button"
                className="ghost"
                onClick={() => navigator.clipboard?.writeText(inviteUrl)}
              >
                Copy
              </button>
            </div>
          )}

          {invitations.length > 0 && (
            <>
              <h3 className="section-title small">Pending invitations</h3>
              <ul className="people-list">
                {invitations.map((invite) => (
                  <li key={invite.id}>
                    <span>{invite.email}</span>
                    <span className="role-chip">{invite.role}</span>
                    <button
                      type="button"
                      className="ghost danger"
                      onClick={() => handleRevoke(invite)}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  );
}
