import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import validate from '../../src/middleware/validate.js';

/**
 * `validate` is the boundary between raw request input and everything else: controllers read
 * `req.valid` and never `req.query`, so what this middleware puts there — and the shape of the
 * error it produces when input is wrong — is load-bearing.
 */
const run = (schemas, req = {}) =>
  new Promise((resolve) => {
    const request = { params: {}, query: {}, body: {}, ...req };
    validate(schemas)(request, {}, (err) => resolve({ err, req: request }));
  });

describe('validate', () => {
  it('puts coerced values on req.valid', async () => {
    const { err, req } = await run(
      { query: z.object({ page: z.coerce.number().int().default(1) }) },
      { query: { page: '3' } },
    );

    assert.equal(err, undefined);
    assert.equal(req.valid.query.page, 3, 'a string from the query string becomes a number');
  });

  it('replaces req.body with the parsed value but leaves query and params alone', async () => {
    // Express 5 exposes req.query through a getter; assigning to it throws. Body is a plain
    // property, so stripping unknown keys there is safe and worth doing.
    const { req } = await run(
      { body: z.object({ email: z.string().email() }), query: z.object({ page: z.coerce.number().default(1) }) },
      { body: { email: 'a@b.co', role: 'admin' }, query: { page: '2' } },
    );

    assert.deepEqual(req.body, { email: 'a@b.co' }, 'unknown keys are dropped — no mass assignment');
    assert.deepEqual(req.query, { page: '2' }, 'the original query object is untouched');
    assert.equal(req.valid.query.page, 2);
  });

  it('fills req.valid from the request for sources it was not given a schema for', async () => {
    const { req } = await run({ body: z.object({ ok: z.boolean() }) }, { body: { ok: true }, params: { id: 'abc' } });
    assert.deepEqual(req.valid.params, { id: 'abc' });
    assert.deepEqual(req.valid.body, { ok: true });
  });

  it('reports a validation error as a 422 with per-field messages', async () => {
    const { err } = await run(
      { body: z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(8, 'Too short') }) },
      { body: { email: 'nope', password: 'x' } },
    );

    assert.equal(err.statusCode, 422);
    assert.equal(err.code, 'VALIDATION_FAILED');
    assert.equal(err.message, 'Some fields need attention');
    assert.deepEqual(err.details.fields, [
      { field: 'email', message: 'Enter a valid email' },
      { field: 'password', message: 'Too short' },
    ]);
  });

  it('names body fields bare and prefixes params and query', async () => {
    // A form field maps to an input name, so `email` must not arrive as `body.email`; a bad
    // path parameter is not a form field at all, so `params.id` is the clearer label.
    const { err } = await run(
      {
        params: z.object({ id: z.string().uuid('Not a valid id') }),
        query: z.object({ page: z.coerce.number().int().positive('Page must be positive') }),
        body: z.object({ title: z.string().min(1, 'Required') }),
      },
      { params: { id: 'nope' }, query: { page: '-1' }, body: { title: '' } },
    );

    assert.deepEqual(
      err.details.fields.map((f) => f.field),
      ['params.id', 'query.page', 'title'],
    );
  });

  it('collects every problem across every source in one response', async () => {
    // Returning the first failure only would make a user fix a form one field per round trip.
    const { err } = await run(
      {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ a: z.string(), b: z.number() }),
      },
      { params: { id: 'x' }, body: {} },
    );
    assert.equal(err.details.fields.length, 3);
  });

  it('labels a whole-object failure with its source instead of an empty string', async () => {
    // `body` being an array, or a refinement on the object itself, has no path to report.
    const { err } = await run({ body: z.object({ a: z.string() }).strict() }, { body: [] });
    assert.equal(err.details.fields[0].field, 'body');
  });

  it('names a nested field with a dotted path', async () => {
    const { err } = await run(
      { body: z.object({ card: z.object({ cvc: z.string().length(3, 'Three digits') }) }) },
      { body: { card: { cvc: '1' } } },
    );
    assert.equal(err.details.fields[0].field, 'card.cvc');
  });

  it('indexes array members', async () => {
    const { err } = await run(
      { body: z.object({ genreIds: z.array(z.string().uuid('Bad id')) }) },
      { body: { genreIds: ['ok-ish'] } },
    );
    assert.equal(err.details.fields[0].field, 'genreIds.0');
  });

  it('passes straight through when no schema is supplied', async () => {
    const { err, req } = await run({}, { body: { anything: true } });
    assert.equal(err, undefined);
    assert.deepEqual(req.valid.body, { anything: true });
  });

  it('applies schema defaults so controllers never branch on undefined', async () => {
    const { req } = await run(
      { query: z.object({ limit: z.coerce.number().default(24), sort: z.string().default('recent') }) },
      { query: {} },
    );
    assert.deepEqual(req.valid.query, { limit: 24, sort: 'recent' });
  });
});
