const { getConnection } = require('../config/database');

/**
 * Deletes a ticket and every record that referenced it, in one transaction.
 *
 * This lives in a service so the web route (DELETE /api/tickets/:id) and the
 * mobile route (DELETE /api/staff/tickets/:id) run byte-for-byte the same
 * cleanup. A ticket is referenced from a lot of tables (invoices, parts,
 * attachments, status history, access tokens, ...) and the set keeps growing, so
 * the list of tables is discovered from information_schema instead of being
 * hardcoded - a new table with a ticket_id column is cleaned up automatically
 * without anyone remembering to update this file.
 *
 * Throws on failure; the caller owns the HTTP response.
 *
 * @param {string|number} ticketId
 * @returns {Promise<{ ticket: {id:number, ticket_id:string}, conversationIds: string[] }>}
 *          `conversationIds` are the conversations the ticket's messages were in,
 *          so the caller can tell connected clients to drop them.
 */
async function deleteTicketCascade(ticketId) {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, ticket_id, customer_name, customer_phone FROM tickets WHERE id = $1',
      [ticketId]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      const err = new Error('Ticket not found');
      err.statusCode = 404;
      throw err;
    }
    const ticket = existing.rows[0];

    // Run a DELETE on a child table, silently skip if the table doesn't exist
    // (migration not yet applied). Any other error aborts the transaction
    // properly instead of silently swallowing it.
    const safeDelete = async (sql, params) => {
      try {
        await client.query(sql, params);
      } catch (e) {
        if (e.code === '42P01') {
          // relation does not exist - table was never created, skip
          return;
        }
        throw e;
      }
    };

    // Conversations that referenced this ticket. Returned so the Messages page
    // can immediately drop the now-empty ticket conversations via socket.
    let conversationIds = [];
    try {
      const convRows = await client.query(
        'SELECT DISTINCT conversation_id FROM messages WHERE ticket_id = $1',
        [ticketId]
      );
      conversationIds = (convRows.rows || []).map((r) => r.conversation_id);
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }

    // Tables linked to the ticket indirectly via its invoices rather than
    // directly through a ticket_id column.
    const invoiceLinkedTables = ['invoice_items', 'invoice_pdfs'];
    for (const table of invoiceLinkedTables) {
      await safeDelete(
        `DELETE FROM ${table}
         WHERE invoice_id IN (SELECT id FROM invoices WHERE ticket_id = $1)`,
        [ticketId]
      );
    }

    // Dynamically discover every table that has a ticket_id column, so that no
    // related table is ever missed (including newly added ones).
    const ticketLinkedRows = await client.query(`
      SELECT table_name
      FROM information_schema.columns
      WHERE column_name = 'ticket_id'
        AND table_schema = 'public'
        AND table_name <> 'tickets'
      ORDER BY table_name
    `);
    for (const row of ticketLinkedRows.rows) {
      await safeDelete(`DELETE FROM "${row.table_name}" WHERE ticket_id = $1`, [ticketId]);
    }

    // Conversations are per-customer (cust_<phone>) and may hold WhatsApp
    // customer replies that carry a NULL ticket_id/order_id. Without cleanup
    // those leftover rows keep the deleted ticket's chat visible in the
    // Messages page. Remove any message in the affected conversations that is
    // no longer linked to any ticket or order (i.e. orphaned by this delete),
    // while preserving messages that still belong to another ticket/order.
    for (const convId of conversationIds) {
      await safeDelete(
        `DELETE FROM messages
         WHERE conversation_id = $1
           AND ticket_id IS NULL
           AND order_id IS NULL`,
        [convId]
      );
    }

    // Finally remove the ticket itself.
    const result = await client.query('DELETE FROM tickets WHERE id = $1', [ticketId]);

    await client.query('COMMIT');

    return { ticket, conversationIds, deleted: result.rowCount > 0 };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // ROLLBACK can itself fail if the connection is broken; log and move on
      console.error('Rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Broadcast the `ticket_deleted` socket event so every connected client
 * (web dashboard, web Messages page, mobile app) refreshes immediately.
 */
function broadcastTicketDeleted(io, ticketId, ticket, conversationIds) {
  if (!io) return;
  io.emit('ticket_deleted', {
    ticketId: parseInt(ticketId, 10),
    ticketNumber: ticket.ticket_id,
    conversationIds: conversationIds || [],
  });
}

module.exports = { deleteTicketCascade, broadcastTicketDeleted };