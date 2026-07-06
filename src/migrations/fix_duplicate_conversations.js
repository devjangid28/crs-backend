const { query } = require('../config/database');

async function fixDuplicateConversations() {
  console.log('=== Fixing duplicate conversations ===');

  try {
    // Step 1: Fix messages with numeric conversation_id that have ticket_id
    const step1 = await query(`
      UPDATE messages m
      SET conversation_id = 'cust_' || regexp_replace(
        COALESCE(m.phone, (SELECT customer_phone FROM tickets t WHERE t.id = m.ticket_id LIMIT 1)),
        '[^\\d]', '', 'g'
      )
      WHERE m.conversation_id ~ '^\\d+$'
      AND m.ticket_id IS NOT NULL
      AND COALESCE(m.phone, (SELECT customer_phone FROM tickets t WHERE t.id = m.ticket_id LIMIT 1)) IS NOT NULL
    `);
    console.log(`Step 1: Fixed ${step1.rowCount} messages with numeric convId (has ticket_id)`);

    // Step 2: Fix numeric conversation_ids with phone from other messages
    const step2 = await query(`
      UPDATE messages m
      SET conversation_id = 'cust_' || regexp_replace(
        (SELECT m2.phone FROM messages m2 
         WHERE m2.conversation_id = m.conversation_id 
         AND m2.phone IS NOT NULL AND m2.phone != ''
         LIMIT 1),
        '[^\\d]', '', 'g'
      )
      WHERE m.conversation_id ~ '^\\d+$'
      AND m.phone IS NULL
      AND EXISTS (
        SELECT 1 FROM messages m2 
        WHERE m2.conversation_id = m.conversation_id 
        AND m2.phone IS NOT NULL AND m2.phone != ''
      )
    `);
    console.log(`Step 2: Fixed ${step2.rowCount} messages with numeric convId (found phone from siblings)`);

    // Step 3: Remove duplicate "conversation_created" events
    const step3 = await query(`
      DELETE FROM messages m1
      USING messages m2
      WHERE m1.id > m2.id
        AND m1.conversation_id = m2.conversation_id
        AND m1.type = 'event'
        AND m1.event = 'conversation_created'
        AND m2.type = 'event'
        AND m2.event = 'conversation_created'
    `);
    console.log(`Step 3: Removed ${step3.rowCount} duplicate conversation_created events`);

    // Step 4: Fix messages with numeric convId and order_id
    const step4 = await query(`
      UPDATE messages m
      SET conversation_id = 'cust_' || regexp_replace(
        COALESCE(m.phone, (SELECT mobile_number FROM orders o WHERE o.id = m.order_id LIMIT 1)),
        '[^\\d]', '', 'g'
      )
      WHERE m.conversation_id ~ '^\\d+$'
      AND m.order_id IS NOT NULL
      AND COALESCE(m.phone, (SELECT mobile_number FROM orders o WHERE o.id = m.order_id LIMIT 1)) IS NOT NULL
    `);
    console.log(`Step 4: Fixed ${step4.rowCount} messages with numeric convId (has order_id)`);

    // Step 5: Create indexes for performance
    try {
      await query(`CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages (phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_messages_conv_phone ON messages (conversation_id, phone)`);
      console.log('Step 5: Indexes created');
    } catch (idxErr) {
      console.warn('Step 5: Index creation skipped:', idxErr.message);
    }

    console.log('=== Duplicate conversations fix completed ===');
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  }
}

fixDuplicateConversations()
  .then(() => {
    console.log('Migration completed successfully');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
