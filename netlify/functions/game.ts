import { getStore } from '@netlify/blobs';
import type { Context } from '@netlify/functions';
import { createGameService } from '../../lib/game-service.mjs';

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

// Netlify supplies the Blobs credentials automatically for this standard Function.
// Helpers intentionally live outside netlify/functions; game is the only endpoint.
export default async function game(request: Request, _context: Context): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Use a POST request.' }, 405);
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) {
    return json({ error: 'Open the game on its own address to continue.' }, 403);
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Expected JSON data.' }, 415);
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 120_000) return json({ error: 'That request is too large.' }, 413);
    let input;
    try { input = JSON.parse(text); }
    catch { return json({ error: 'Please send valid question data.' }, 400); }
    const token = request.headers.get('authorization')?.replace(/^Bearer /u, '') || '';
    const store = getStore({ name: 'majority-rules-rooms', consistency: 'strong' });
    const result = await createGameService({ store })(input, token);
    return json(result.body, result.status);
  } catch (error) {
    console.error('Game request failed:', error instanceof Error ? error.message : 'Unknown error');
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
