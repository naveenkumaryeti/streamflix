import AppError from '../utils/AppError.js';

/**
 * Validates and coerces request input with zod. Parsed values land on `req.valid`
 * (controllers read from there) so nothing downstream touches raw user input.
 *
 *   router.post('/', validate({ body: createTitleSchema }), controller.create)
 */
export function validate(schemas = {}) {
  return (req, _res, next) => {
    const valid = {};
    const fields = [];

    for (const source of ['params', 'query', 'body']) {
      const schema = schemas[source];
      if (!schema) continue;
      const result = schema.safeParse(req[source]);
      if (result.success) {
        valid[source] = result.data;
        continue;
      }
      for (const issue of result.error.issues) {
        fields.push({
          field: [source === 'body' ? null : source, ...issue.path].filter((p) => p !== null && p !== undefined).join('.') || source,
          message: issue.message,
        });
      }
    }

    if (fields.length) return next(AppError.validation('Some fields need attention', { fields }));

    // Body is safe to replace; params/query stay untouched to avoid Express getter quirks.
    if (valid.body) req.body = valid.body;
    req.valid = { params: valid.params ?? req.params, query: valid.query ?? req.query, body: valid.body ?? req.body };
    return next();
  };
}

export default validate;
