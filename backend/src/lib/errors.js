/**
 * An error with an HTTP status attached. Anything thrown that is not one
 * of these becomes a 500 with no detail leaked to the client.
 */
export class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Translate a PostgREST/Postgres error into an HTTP response.
 *
 * The important line is 42501. An RLS policy rejecting a write surfaces
 * as insufficient_privilege, and it must become 403 — never a 500. A 500
 * here would read as "the server is broken" when what actually happened
 * is "the database correctly refused a cross-tenant write", and that
 * distinction is the difference between noticing an attack and paging
 * someone at 3am about a bug that does not exist.
 */
export function fromPostgrestError(error, fallbackMessage = 'Request failed') {
  if (!error) return new HttpError(500, fallbackMessage);

  switch (error.code) {
    case '42501': // insufficient_privilege — RLS or a missing grant
      return new HttpError(403, 'You do not have access to this resource', error.code);
    case '23505': // unique_violation
      return new HttpError(409, 'That already exists', error.code);
    case '23503': // foreign_key_violation
      return new HttpError(400, 'Referenced record does not exist', error.code);
    case '23514': // check_violation — e.g. the last-owner guard
      return new HttpError(409, error.message || 'Operation not allowed', error.code);
    case '22023': // invalid_parameter_value — raised by our RPCs
      return new HttpError(400, error.message || 'Invalid input', error.code);
    case 'P0002': // no_data_found — raised by accept_invitation
      return new HttpError(404, error.message || 'Not found', error.code);
    case 'PGRST116': // PostgREST: .single() matched zero rows
      return new HttpError(404, 'Not found', error.code);
    default:
      return new HttpError(500, fallbackMessage, error.code ?? null);
  }
}

/** Wraps an async route handler so rejections reach the error middleware. */
export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
