/**
 * Wraps an async route handler so a rejected promise reaches Express' error handler.
 * Express 4 does not await handlers; without this, a rejection becomes a hung request.
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
