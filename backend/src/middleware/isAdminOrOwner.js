/**
 * isAdminOrOwner([resourceLoader])
 *
 * Middleware factory that enforces admin-or-owner access control.
 *
 * Without a resourceLoader:
 *   - Admins (req.user.role === 'admin') are passed through immediately.
 *   - Any other authenticated user is passed through under the assumption that
 *     the downstream controller already scopes every DB query to req.user.userId
 *     (i.e. "you only see your own data"). All three current callers
 *     (listSigners, addSigner, removeSigner) satisfy this requirement.
 *   - Unauthenticated requests are rejected with 401.
 *   - WARNING: do NOT use this middleware without a resourceLoader on routes
 *     whose controllers do not filter by req.user.userId — doing so would
 *     allow any authenticated user to access any user's resources.
 *
 * With a resourceLoader (async function (req) => resource | null):
 *   - Admins are still passed through immediately.
 *   - For non-admins the loader is awaited; if it returns null the request
 *     gets 404. If the returned resource's user_id does not match
 *     req.user.userId the request gets 403.
 *   - Use this form when the route parameter identifies a specific resource
 *     (e.g. a ticket, an escrow) and ownership must be enforced before the
 *     controller runs.
 *
 * Usage:
 *   router.get('/signers', isAdminOrOwner(), listSigners);
 *   router.get('/tickets/:id', isAdminOrOwner(async (req) => {
 *     const { rows } = await db.query('SELECT user_id FROM tickets WHERE id = $1', [req.params.id]);
 *     return rows[0] ?? null;
 *   }), getTicket);
 */
module.exports = function isAdminOrOwner(resourceLoader) {
  return async function isAdminOrOwnerMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Admins always pass.
    if (req.user.role === 'admin') {
      return next();
    }

    // No resourceLoader: rely on the controller to scope queries to req.user.userId.
    if (!resourceLoader) {
      return next();
    }

    // With a resourceLoader: verify this authenticated user owns the resource.
    try {
      const resource = await resourceLoader(req);
      if (!resource) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      if (resource.user_id !== req.user.userId) {
        return res.status(403).json({ error: 'Forbidden: admin or account owner required' });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
};
