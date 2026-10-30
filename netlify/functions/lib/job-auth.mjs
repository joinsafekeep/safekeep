import { timingSafeEqual } from 'node:crypto';
// Background jobs are started by our own scheduled functions and the admin page, with a shared secret in a header.
export function authorized(request, secret) {
 const given = Buffer.from(request.headers.get('x-safekeep-job') || '');
 const want = Buffer.from(secret || '');
 return want.length >= 16 && given.length === want.length && timingSafeEqual(given, want);
}
