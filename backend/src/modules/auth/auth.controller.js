import config from '../../config/env.js';
import asyncHandler from '../../utils/asyncHandler.js';
import AppError from '../../utils/AppError.js';
import * as authService from './auth.service.js';
import { getEntitlement } from '../subscriptions/entitlements.js';

const REFRESH_COOKIE = 'sf_refresh';

const context = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

/**
 * The refresh token is returned in the body *and* set as an httpOnly cookie.
 *
 * The cookie is the safer channel (unreadable by JavaScript, so an XSS bug cannot steal a
 * 30-day credential) and is what the browser client uses. The body copy exists for native
 * apps and for curl-driven testing, which have no cookie jar. The access token is only
 * ever in the body: it is short-lived and needs to go in an Authorization header.
 */
function setRefreshCookie(res, token, expiresAt) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: `${config.apiPrefix}/auth`,
    expires: new Date(expiresAt),
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { path: `${config.apiPrefix}/auth` });
}

const readRefreshToken = (req) => req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE] || null;

export const register = asyncHandler(async (req, res) => {
  const result = await authService.register({ ...req.valid.body, ...context(req) });
  setRefreshCookie(res, result.refreshToken, result.refreshTokenExpiresAt);
  res.status(201).json(result);
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login({ ...req.valid.body, ...context(req) });
  setRefreshCookie(res, result.refreshToken, result.refreshTokenExpiresAt);
  res.json(result);
});

export const refresh = asyncHandler(async (req, res) => {
  const token = readRefreshToken(req);
  if (!token) throw AppError.unauthorized('No refresh token supplied', 'REFRESH_MISSING');

  try {
    const result = await authService.refresh({ token, ...context(req) });
    setRefreshCookie(res, result.refreshToken, result.refreshTokenExpiresAt);
    res.json(result);
  } catch (err) {
    // The cookie is dead either way; leaving it would loop the client through 401s.
    clearRefreshCookie(res);
    throw err;
  }
});

export const logout = asyncHandler(async (req, res) => {
  const result = await authService.logout({
    userId: req.user.id,
    refreshToken: readRefreshToken(req),
    accessPayload: req.tokenPayload,
    everywhere: req.valid?.body?.everywhere ?? false,
    ip: req.ip,
  });
  clearRefreshCookie(res);
  res.json(result);
});

export const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user, entitlement: await getEntitlement(req.user.id) });
});

export const changePassword = asyncHandler(async (req, res) => {
  const result = await authService.changePassword({
    userId: req.user.id,
    ...req.valid.body,
    ip: req.ip,
  });
  clearRefreshCookie(res);
  res.json({ ...result, message: 'Password updated. Other devices have been signed out.' });
});

export const sessions = asyncHandler(async (req, res) => {
  res.json({ items: await authService.listSessions(req.user.id) });
});
