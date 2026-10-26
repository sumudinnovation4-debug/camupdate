// ONE serverless function that serves several routes.
// Vercel's free plan allows at most 12 functions, and every file in /api counts as one.
// The real code for each route lives in api/_handlers/ (files starting with "_" are not
// counted). vercel.json rewrites each public address to this file, so the addresses the app
// and the database use do not change:
//   /api/push-event  /api/push-test  /api/notify-call  /api/notify-message
//   /api/notify-group-message  /api/send-push  /api/delete-account  /api/quick-reply  /api/call-decline
const ROUTES = {
  'push-event':           () => require('./_handlers/push-event.js'),
  'push-test':            () => require('./_handlers/push-test.js'),
  'notify-call':          () => require('./_handlers/notify-call.js'),
  'notify-message':       () => require('./_handlers/notify-message.js'),
  'notify-group-message': () => require('./_handlers/notify-group-message.js'),
  'send-push':            () => require('./_handlers/send-push.js'),
  'delete-account':       () => require('./_handlers/delete-account.js'),
  'quick-reply':          () => require('./_handlers/quick-reply.js'),
  'call-decline':         () => require('./_handlers/call-decline.js'),
};

module.exports = async (req, res) => {
  const route = String((req.query && req.query.r) || '');
  const load = ROUTES[route];
  if (!load) return res.status(404).json({ error: 'Unknown route' });
  return load()(req, res);
};
