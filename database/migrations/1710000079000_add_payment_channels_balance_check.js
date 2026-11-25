/**
 * Migration: 037_add_payment_channels_balance_check
 *
 * Adds a CHECK constraint to the payment_channels table ensuring that
 * sender_balance can never go below zero.  This is a defence-in-depth
 * measure: the primary protection is the SELECT ... FOR UPDATE locking
 * in paymentChannel.js, but this constraint guarantees that even a bug
 * or a direct SQL UPDATE cannot create a negative balance.
 */

exports.up = (pgm) => {
  pgm.addConstraint(
    'payment_channels',
    'payment_channels_sender_balance_non_negative',
    'CHECK (sender_balance >= 0)'
  );
};

exports.down = (pgm) => {
  pgm.dropConstraint(
    'payment_channels',
    'payment_channels_sender_balance_non_negative'
  );
};
