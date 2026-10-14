// RETIRED — kept only so older copies of group-thread.html that still call it don't error.
// Group-chat pushes are now sent by the database itself through /api/push-event the
// moment a message is saved (works even if the sender closes the app). Doing it here as
// well would buzz everyone twice, so this does nothing. You can delete this file once
// every device has the latest group-thread.html.
module.exports = async (req, res) => {
  res.status(200).json({ ok: true, skipped: 'handled-by-database' });
};
