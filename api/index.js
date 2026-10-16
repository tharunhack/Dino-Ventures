/**
 * Vercel serverless entrypoint.
 *
 * Vercel hands each invocation a Node `(req, res)` pair. Fastify already owns
 * a Node HTTP server internally, so the adapter is simply to emit the request
 * into it — no shim library, no re-routing.
 *
 * The app is built ONCE per warm instance and cached on the module scope.
 * Rebuilding per request would open a new pg Pool every time and exhaust the
 * database's connection slots within seconds.
 *
 * `vercel.json` rewrites every path to this function, so Fastify sees the
 * original URL and its own router does the matching.
 */
import { buildApp } from '../src/app.js';

let appPromise;

const getApp = () => {
  if (!appPromise) {
    appPromise = buildApp()
      .then(async (app) => {
        await app.ready();
        return app;
      })
      .catch((err) => {
        // Don't cache a failed boot: the next invocation should retry rather
        // than serve errors forever because the database was briefly down.
        appPromise = undefined;
        throw err;
      });
  }
  return appPromise;
};

export default async function handler(req, res) {
  let app;
  try {
    app = await getApp();
  } catch (err) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The service could not reach its database.',
        },
      }),
    );
    console.error('boot failed:', err);
    return;
  }

  app.server.emit('request', req, res);
}
