/**
 * BE-177: store one Web Push subscription per device instead of a single
 * users.push_subscription column, and migrate existing subscriptions.
 */

exports.up = (pgm) => {
  pgm.createTable('push_subscriptions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    endpoint: { type: 'text', notNull: true, unique: true },
    p256dh: { type: 'text', notNull: true },
    auth: { type: 'text', notNull: true },
    user_agent: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    failure_count: { type: 'integer', notNull: true, default: 0 },
    last_success_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  }, { ifNotExists: true });
  pgm.createIndex('push_subscriptions', 'user_id', { ifNotExists: true });

  pgm.sql(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, active, failure_count)
    SELECT id,
           push_subscription::jsonb->>'endpoint',
           push_subscription::jsonb->'keys'->>'p256dh',
           push_subscription::jsonb->'keys'->>'auth',
           COALESCE(push_subscription_active, true),
           COALESCE(push_failure_count, 0)
      FROM users
     WHERE push_subscription IS NOT NULL
       AND push_subscription::jsonb->>'endpoint' IS NOT NULL
       AND push_subscription::jsonb->'keys'->>'p256dh' IS NOT NULL
       AND push_subscription::jsonb->'keys'->>'auth' IS NOT NULL
    ON CONFLICT (endpoint) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('push_subscriptions', { ifExists: true });
};
