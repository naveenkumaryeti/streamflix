import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import AppError from '../../src/utils/AppError.js';

/**
 * `code` is a contract with the frontend: it switches on these strings to decide whether to
 * show a toast, open the plans page, or ask the user to close another device. Changing one
 * silently breaks the UI, so the mapping is pinned here.
 */
describe('AppError', () => {
  it('is a real Error, so throwing it keeps a stack and instanceof works', () => {
    const err = AppError.badRequest('nope');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof AppError);
    assert.equal(err.name, 'AppError');
    assert.ok(err.stack);
    assert.equal(err.message, 'nope');
  });

  it('marks itself expected, which is how the error handler avoids logging it as a bug', () => {
    assert.equal(AppError.notFound().expected, true);
  });

  it('maps each factory to the status the client expects', () => {
    const expected = [
      [AppError.badRequest(), 400, 'BAD_REQUEST'],
      [AppError.payment(), 402, 'PAYMENT_FAILED'],
      [AppError.validation(), 422, 'VALIDATION_FAILED'],
      [AppError.unauthorized(), 401, 'UNAUTHORIZED'],
      [AppError.forbidden(), 403, 'FORBIDDEN'],
      [AppError.notFound(), 404, 'NOT_FOUND'],
      [AppError.conflict(), 409, 'CONFLICT'],
      [AppError.tooMany(), 429, 'RATE_LIMITED'],
      [AppError.subscriptionRequired(), 403, 'SUBSCRIPTION_REQUIRED'],
      [AppError.streamLimit(2), 409, 'STREAM_LIMIT_REACHED'],
      [AppError.unavailable(), 503, 'SERVICE_UNAVAILABLE'],
    ];

    for (const [err, statusCode, code] of expected) {
      assert.equal(err.statusCode, statusCode, code);
      assert.equal(err.code, code);
      assert.ok(err.message, `${code} has a human-readable default`);
    }
  });

  it('lets auth-style factories override the code while keeping the status', () => {
    // TOKEN_EXPIRED vs TOKEN_INVALID is what tells the client to refresh rather than log out.
    const expiredToken = AppError.unauthorized('expired', 'TOKEN_EXPIRED');
    assert.equal(expiredToken.statusCode, 401);
    assert.equal(expiredToken.code, 'TOKEN_EXPIRED');

    const scoped = AppError.forbidden('nope', 'ORIGIN_NOT_ALLOWED');
    assert.equal(scoped.statusCode, 403);
    assert.equal(scoped.code, 'ORIGIN_NOT_ALLOWED');

    assert.equal(AppError.notFound('gone', 'TITLE_NOT_FOUND').code, 'TITLE_NOT_FOUND');
    assert.equal(AppError.conflict('taken', 'EMAIL_TAKEN').code, 'EMAIL_TAKEN');
  });

  it('carries structured details when the client needs more than a message', () => {
    const invalid = AppError.validation('Some fields need attention', {
      fields: [{ field: 'email', message: 'Enter a valid email' }],
    });
    assert.deepEqual(invalid.details.fields, [{ field: 'email', message: 'Enter a valid email' }]);

    assert.deepEqual(AppError.tooMany('slow down', 30).details, { retryAfterSeconds: 30 });
    assert.deepEqual(AppError.streamLimit(4).details, { maxStreams: 4 });
  });

  it('reads a string second argument as a code and an object as details', () => {
    // badRequest and payment are the two factories that legitimately want either. Getting
    // this wrong is not a crash — it ships `code: {fields:[…]}` to a frontend that switches
    // on strings, and the branch silently never matches.
    const specific = AppError.badRequest('Add poster artwork before publishing', 'POSTER_REQUIRED');
    assert.equal(specific.code, 'POSTER_REQUIRED');
    assert.equal(specific.details, undefined);

    const withFields = AppError.badRequest('Your current password is not correct', {
      fields: [{ field: 'currentPassword', message: 'Incorrect password' }],
    });
    assert.equal(withFields.code, 'BAD_REQUEST');
    assert.equal(withFields.details.fields[0].field, 'currentPassword');

    assert.equal(AppError.payment('Card declined', 'CARD_DECLINED').code, 'CARD_DECLINED');
    assert.deepEqual(AppError.payment('Card declined', { decline: 'insufficient_funds' }).details, {
      decline: 'insufficient_funds',
    });
    assert.equal(AppError.payment().code, 'PAYMENT_FAILED');
  });

  it('leaves details undefined when there are none, so it is omitted from the response', () => {
    // The error handler spreads `details` conditionally; undefined keeps the payload clean.
    assert.equal(AppError.notFound().details, undefined);
    assert.equal(AppError.unavailable().details, undefined);
  });

  it('pluralises the stream-limit message, because users read it verbatim', () => {
    assert.match(AppError.streamLimit(1).message, /allows 1 screen at a time/);
    assert.match(AppError.streamLimit(4).message, /allows 4 screens at a time/);
  });

  it('supports a direct construction for the few codes without a factory', () => {
    // 413 has no factory; the error handler builds it from body-parser and multer errors.
    const tooLarge = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.expected, true);
  });
});
