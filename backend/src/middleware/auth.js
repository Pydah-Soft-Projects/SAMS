import jwt from 'jsonwebtoken';
import SystemUser from '../models/SystemUser.js';
import { PERMISSION_MODULE_LIST } from '../constants/index.js';
import {
  gateAccessModesToObject,
  isEventAllowedForGateMode,
  isEventAllowedForDepartmentMode,
} from '../utils/gateAccessModes.js';
import { isPastEmployeeAutoLogoutHour } from '../utils/istTime.js';

const JWT_SECRET = process.env.JWT_SECRET || 'sams-dev-jwt-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export const AFTER_HOURS_LOGOUT_CODE = 'AFTER_HOURS_LOGOUT';
export const AFTER_HOURS_LOGOUT_MESSAGE =
  'Your session ended after 9:00 PM. Please sign in again tomorrow.';

/**
 * Check if user is associated with JATTU maintenance / workforce.
 */
export function isJattuUser(user) {
  if (!user) return false;
  if (user.isSuperAdmin) return false;

  const directSlug = String(user.roleSlug || user.role || '').toLowerCase();
  const directName = String(user.roleName || '').toLowerCase();
  if (directSlug === 'jattu' || directName.includes('jattu')) return true;

  const role = user.systemRoleId;
  if (role && typeof role === 'object') {
    const slug = String(role.slug || '').toLowerCase();
    const name = String(role.name || '').toLowerCase();
    if (slug === 'jattu' || name.includes('jattu')) return true;

    const perms = role.permissions || {};
    const jattuKeys = [
      'jattu',
      'jattu_registrations',
      'jattu_entry_exit',
      'jattu_activity',
      'jattu_attendance',
    ];
    if (jattuKeys.some((key) => Boolean(perms[key]?.read || perms[key]?.write))) {
      return true;
    }
  }

  if (user.permissions && typeof user.permissions === 'object') {
    const jattuKeys = [
      'jattu',
      'jattu_registrations',
      'jattu_entry_exit',
      'jattu_activity',
      'jattu_attendance',
    ];
    if (jattuKeys.some((key) => Boolean(user.permissions[key]?.read || user.permissions[key]?.write))) {
      return true;
    }
  }

  return false;
}

/**
 * Active JATTU employees must not keep an authenticated session after 9pm IST.
 */
export function shouldForceEmployeeAfterHoursLogout(user) {
  if (!user) return false;
  if (user.isSuperAdmin) return false;
  if (user.isActive === false) return false;
  if (!isJattuUser(user)) return false;
  return isPastEmployeeAutoLogoutHour();
}


// ─── Simple in-process user cache ────────────────────────────────────────────
// Avoids hitting MongoDB + 4 populate() calls on every authenticated request.
// TTL: 60 seconds — short enough to pick up role/permission changes promptly.
const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map(); // userId → { user, expiresAt }

function cacheGet(userId) {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    userCache.delete(userId);
    return null;
  }
  return entry.user;
}

function cacheSet(userId, user) {
  userCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  // Evict stale entries if cache grows large (safety valve)
  if (userCache.size > 500) {
    const now = Date.now();
    for (const [key, val] of userCache) {
      if (now > val.expiresAt) userCache.delete(key);
    }
  }
}

// Call this after updating a user's roles/permissions so the next request re-fetches
export function invalidateUserCache(userId) {
  if (userId) userCache.delete(userId.toString());
}
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_API_ROUTES = [
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/precheck' },
  { method: 'POST', path: '/api/auth/sso-login' },
  { method: 'GET',  path: '/api/health' },
  { method: 'GET',  path: '/api/ping' },
  { method: 'GET',  prefix: '/api/passes/verify/' },
  { method: 'GET',  path: '/api/roles' },
  { method: 'GET',  prefix: '/api/forms/role/' },
  { method: 'POST', path: '/api/registrations' },
  { method: 'GET',  prefix: '/api/registrations/' },
  { method: 'PUT',  prefix: '/api/registrations/' },
  { method: 'POST', prefix: '/api/registrations/' },
  // Device binding — called before login, no token available
  { method: 'POST', path: '/api/devices/register' },
  { method: 'POST', path: '/api/devices/validate' },
  { method: 'GET',  path: '/api/devices/settings/public' },
  // Geo Location
  { method: 'GET',  path: '/api/geo-locations/settings/public' },
  { method: 'POST', path: '/api/auth/verify-location' },
  // Internal AI Server integration
  { method: 'POST', path: '/api/vehicles/check-batch' },
];

function isPublicApiRoute(req) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return PUBLIC_API_ROUTES.some((route) => {
    if (route.method !== req.method) return false;
    if (route.path)   return path === route.path;
    if (route.prefix) return path.startsWith(route.prefix);
    return false;
  });
}

export function signToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      userId: user._id.toString(),
      isSuperAdmin: Boolean(user.isSuperAdmin),
      username: user.username,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export function authenticateUnlessPublic(req, res, next) {
  const url = (req.originalUrl || req.url || '').split('?')[0];
  if (!url.startsWith('/api')) return next();
  if (isPublicApiRoute(req)) return next();
  return authenticate(req, res, next);
}

export async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Verify JWT first — cheap, synchronous, no DB
  let payload;
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const userId = payload.sub || payload.userId;

  // ── Cache hit: skip DB round-trip entirely ─────────────────────────────
  const cached = cacheGet(userId);
  if (cached) {
    if (shouldForceEmployeeAfterHoursLogout(cached)) {
      invalidateUserCache(userId);
      return res.status(401).json({
        error: AFTER_HOURS_LOGOUT_MESSAGE,
        code: AFTER_HOURS_LOGOUT_CODE,
      });
    }
    req.user = cached;
    return next();
  }

  // ── Cache miss: fetch from DB, populate, then cache ────────────────────
  try {
    const user = await SystemUser.findById(userId)
      .populate('systemRoleId', 'name slug permissions isActive')
      .populate('divisionIds', 'name slug')
      .populate('gateIds', 'name slug gateType divisionId')
      .populate('departmentIds', 'name slug')
      .select('-passwordHash');

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid or inactive user' });
    }

    if (!user.isSuperAdmin && user.systemRoleId && !user.systemRoleId.isActive) {
      return res.status(403).json({ error: 'Assigned system role is inactive' });
    }

    if (shouldForceEmployeeAfterHoursLogout(user)) {
      return res.status(401).json({
        error: AFTER_HOURS_LOGOUT_MESSAGE,
        code: AFTER_HOURS_LOGOUT_CODE,
      });
    }

    cacheSet(userId, user);
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

export function userHasPermission(user, module, action) {
  if (!PERMISSION_MODULE_LIST.includes(module)) return false;
  if (user.isSuperAdmin) return true;

  const role = user.systemRoleId;
  if (!role?.permissions) return false;

  const perms = role.permissions instanceof Map
    ? Object.fromEntries(role.permissions.entries())
    : role.permissions;

  const modulePerms = perms[module];
  if (!modulePerms) return false;
  if (action === 'read') return Boolean(modulePerms.read || modulePerms.write);
  return Boolean(modulePerms.write);
}

export function requirePermission(module, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (userHasPermission(req.user, module, action)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

export function requireAnyPermission(modules, action) {
  const list = Array.isArray(modules) ? modules : [modules];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (list.some((module) => userHasPermission(req.user, module, action))) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

function toIdString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value._id) return value._id.toString();
  return value.toString();
}

export function hasDivisionScope(user, divisionId) {
  if (user.isSuperAdmin) return true;
  if (!divisionId) return true;
  const target = toIdString(divisionId);
  return (user.divisionIds || []).some((id) => toIdString(id) === target);
}

export function hasDepartmentScope(user, departmentId) {
  if (user.isSuperAdmin) return true;
  if (!departmentId) return true;
  const target = toIdString(departmentId);
  return (user.departmentIds || []).some((id) => toIdString(id) === target);
}

export function hasGateScope(user, gateId) {
  if (user.isSuperAdmin) return true;
  if (!gateId) return true;
  const target = toIdString(gateId);
  return (user.gateIds || []).some((id) => toIdString(id) === target);
}

/**
 * Check whether the user may perform eventType at gateId.
 * eventType: 'entry' | 'exit' | 'auto'
 * Uses gateAccessModes when present; missing mode = full access for the gate type.
 */
export function hasGateEventScope(user, gateId, eventType, gateType) {
  if (user.isSuperAdmin) return true;
  if (!hasGateScope(user, gateId)) return false;
  const target = toIdString(gateId);
  const modes = gateAccessModesToObject(user.gateAccessModes);
  return isEventAllowedForGateMode(gateType, modes[target], eventType);
}

/**
 * Check whether the user may perform eventType at departmentId.
 * eventType: 'entry' | 'exit' | 'auto'
 * Uses departmentAccessModes when present; missing mode = full access.
 */
export function hasDepartmentEventScope(user, departmentId, eventType) {
  if (user.isSuperAdmin) return true;
  if (!hasDepartmentScope(user, departmentId)) return false;
  const target = toIdString(departmentId);
  const modes = gateAccessModesToObject(user.departmentAccessModes);
  return isEventAllowedForDepartmentMode(modes[target], eventType);
}

export function applyDivisionScopeFilter(user, filter = {}) {
  if (user.isSuperAdmin) return filter;
  const ids = user.divisionIds || [];
  if (ids.length === 0) {
    filter._id = { $in: [] };
    return filter;
  }
  filter._id = filter._id ? filter._id : { $in: ids };
  return filter;
}

export function applyDepartmentScopeFilter(user, filter = {}) {
  if (user.isSuperAdmin) return filter;
  const ids = user.departmentIds || [];
  if (ids.length === 0) {
    filter._id = { $in: [] };
    return filter;
  }
  if (filter.divisionIds) {
    filter._id = { $in: ids };
    return filter;
  }
  filter._id = { $in: ids };
  return filter;
}
