/**
 * EWJ AI proxy — Cloudflare Worker
 *
 * Replaces the current ewj-proxy worker. Two things it does that the old one
 * did not:
 *
 *  1. Every reply carries CORS headers, errors included. Without them the
 *     browser cannot read an error at all and reports a bare "Failed to fetch",
 *     which is why the tools kept failing with nothing useful to show.
 *
 *  2. It gives up on a stalled call to Anthropic after 45 seconds and tries
 *     once more, rather than holding the browser's connection open until
 *     something in between drops it.
 *
 * The API key still comes from the browser in the x-api-key header and is
 * never stored here.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
  'Access-Control-Max-Age': '86400',
};

const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 45000;   // longer than any normal reply, shorter than the browser's patience
const ATTEMPTS = 2;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') {
      return json({ error: { message: 'This address only accepts POST requests.' } }, 405);
    }

    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return json({ error: { message: 'No API key was sent. Paste your key into the tool and save it.' } }, 401);
    }

    let body;
    try {
      body = await request.text();
    } catch (e) {
      return json({ error: { message: 'Could not read the request body.' } }, 400);
    }

    let lastProblem = 'unknown';

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const control = new AbortController();
      const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(UPSTREAM, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
          },
          body,
          signal: control.signal,
        });
        clearTimeout(timer);

        // Overload and rate limiting are worth one more go; everything else,
        // including a rejected key, goes straight back so the tool can say why.
        if ((res.status === 429 || res.status >= 500) && attempt < ATTEMPTS) {
          lastProblem = 'Anthropic returned HTTP ' + res.status;
          await sleep(2000);
          continue;
        }

        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        clearTimeout(timer);
        lastProblem = (e && e.name === 'AbortError')
          ? 'Anthropic did not reply within 45 seconds'
          : ('could not reach Anthropic — ' + ((e && e.message) || 'network error'));
        if (attempt < ATTEMPTS) {
          await sleep(1500);
          continue;
        }
      }
    }

    // A real HTTP answer with CORS headers, so the tool shows this sentence
    // instead of a blank "Failed to fetch".
    return json({ error: { message: 'The proxy could not get an answer: ' + lastProblem + '. Try again in a moment.' } }, 504);
  },
};
