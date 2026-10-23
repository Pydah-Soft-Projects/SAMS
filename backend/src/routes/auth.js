import { Router } from 'express';
import bcrypt from 'bcryptjs';
import SystemUser from '../models/SystemUser.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  authenticate,
  signToken,
  shouldForceEmployeeAfterHoursLogout,
  AFTER_HOURS_LOGOUT_CODE,
  AFTER_HOURS_LOGOUT_MESSAGE,
} from '../middleware/auth.js';
import { getUserAccessScope } from '../services/accessScopeService.js';
import { getLoginFlow } from '../services/loginFlowService.js';
import { verifyHrmsEmployeePassword } from '../services/hrmsEmployeeService.js';
import { userHasPermission } from '../middleware/auth.js';
import {
  hasPrimaryAdminDevice,
  bootstrapApproveDevice,
  getOrCreateSettings,
} from '../services/deviceService.js';

const router = Router();

function serializeUser(user) {
  const role = user.systemRoleId;
  const permissions =
    user.isSuperAdmin || !role
      ? null
      : role.permissions instanceof Map
        ? Object.fromEntries(role.permissions.entries())
        : role.permissions;

  return {
    _id: user._id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    hrmsEmployeeId: user.hrmsEmployeeId || null,
    isSuperAdmin: user.isSuperAdmin,
    isActive: user.isActive,
    divisionIds: user.divisionIds,
    gateIds: user.gateIds,
    gateAccessModes:
      user.gateAccessModes instanceof Map
        ? Object.fromEntries(user.gateAccessModes.entries())
        : user.gateAccessModes || {},
    departmentIds: user.departmentIds,
    departmentAccessModes:
      user.departmentAccessModes instanceof Map
        ? Object.fromEntries(user.departmentAccessModes.entries())
        : user.departmentAccessModes || {},
    systemRoleId: role
      ? {
          _id: role._id,
          name: role.name,
          slug: role.slug,
          permissions,
        }
      : null,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// ─── Shared query builder ────────────────────────────────────────────────────
// Lean query for precheck (no passwordHash needed, lean object is faster)
function userQueryLean(username) {
  return SystemUser.findOne({ username: username.toLowerCase().trim() })
    .populate('systemRoleId', 'name slug permissions isActive')
    .populate('divisionIds', 'name slug')
    .populate('gateIds', 'name slug gateType divisionId')
    .populate('departmentIds', 'name slug isActive');
}

// ─── /precheck ───────────────────────────────────────────────────────────────
// Optimised: skip full scope fetch for standard-flow users
router.post(
  '/precheck',
  asyncHandler(async (req, res) => {
    const { username } = req.body;
    if (!username?.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Minimal projection for users that will end up on standard flow
    const user = await SystemUser.findOne({ username: username.toLowerCase().trim() })
      .select('displayName isActive isSuperAdmin systemRoleId gateIds gateAccessModes departmentIds divisionIds')
      .populate('systemRoleId', 'name slug permissions isActive')
      .populate('gateIds', '_id')          // only need IDs to check length
      .populate('departmentIds', '_id');   // only need IDs to check length

    if (!user || !user.isActive) {
      return res.json({ flow: 'standard', isSuperAdmin: false });
    }

    if (!user.isSuperAdmin && user.systemRoleId && !user.systemRoleId.isActive) {
      return res.json({ flow: 'standard', isSuperAdmin: false });
    }

    const flow = getLoginFlow(user);

    if (flow !== 'gate') {
      // Standard flow — no scope fetch needed at all
      return res.json({ flow: 'standard', displayName: user.displayName, isSuperAdmin: user.isSuperAdmin });
    }

    // Gate flow — now fetch full scope (only reached for gate operators)
    const fullUser = await userQueryLean(username);
    const scope = await getUserAccessScope(fullUser);
    const hasScopeItems = (scope.divisions || []).some(
      (d) => (d.gates || []).length > 0 || (d.departments || []).length > 0
    );

    if (!hasScopeItems) {
      return res.json({ flow: 'standard', displayName: user.displayName, isSuperAdmin: user.isSuperAdmin });
    }

    return res.json({
      flow: 'gate',
      displayName: user.displayName,
      isSuperAdmin: user.isSuperAdmin,
      canGateWrite: userHasPermission(fullUser, 'gate', 'write'),
      accessScope: scope,
    });
  })
);

// ─── /verify-location ────────────────────────────────────────────────────────
router.post(
  '/verify-location',
  asyncHandler(async (req, res) => {
    const { username, latitude, longitude, accuracy, timestamp, error: clientError, reason, fingerprint } = req.body;
    if (!username?.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const user = await SystemUser.findOne({ username: username.toLowerCase().trim() })
      .select('isSuperAdmin displayName username allowedLocationIds isActive')
      .populate('allowedLocationIds', '_id name latitude longitude radius isActive')
      .lean();

    if (!user || !user.isActive) {
      // Simulate access denied
      return res.status(403).json({ error: 'Access denied. You are outside the permitted organization location.' });
    }

    // Dynamic import to avoid circular dependencies
    const { verifyGeoAccess } = await import('../services/geoLocationService.js');

    // Handle client-reported geolocation failure (e.g. browser permission denied or timeout)
    if (clientError || reason || latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
      const result = await verifyGeoAccess({
        user,
        latitude: null,
        longitude: null,
        accuracy: null,
        req,
        deviceFingerprint: fingerprint || null,
        failureReason: clientError || reason || 'location_permission_denied',
      });
      if (result.ok) {
        return res.json({
          ok: true,
          result: result.result,
          locationName: result.locationName ?? null,
          distance: result.distance ?? null,
        });
      }
      return res.status(403).json({
        error: result.message || 'Access denied. Location verification failed or permission was denied.',
        result: result.result,
      });
    }

    const result = await verifyGeoAccess({
      user,
      latitude,
      longitude,
      accuracy,
      req,
      deviceFingerprint: fingerprint || null,
    });

    if (!result.ok) {
      return res.status(403).json({
        error: result.message || 'Access denied. You are outside the permitted organization location.',
        result: result.result,
        nearestDistance: result.nearestDistance ?? null,
        nearestLocationName: result.nearestLocationName ?? null,
      });
    }

    return res.json({
      ok: true,
      result: result.result,
      locationName: result.locationName ?? null,
      distance: result.distance ?? null,
    });
  })
);

// ─── /login ──────────────────────────────────────────────────────────────────
// Optimised: run bcrypt + DB fetch in parallel, update lastLoginAt without blocking
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password, fingerprint } = req.body;
    if (!username?.trim() || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Fetch user with passwordHash — run concurrently with nothing else yet
    const user = await SystemUser.findOne({ username: username.toLowerCase().trim() })
      .select('+passwordHash hrmsEmployeeId displayName email isActive isSuperAdmin divisionIds gateIds gateAccessModes departmentIds lastLoginAt createdAt updatedAt')
      .populate('systemRoleId', 'name slug permissions isActive')
      .populate('divisionIds', 'name slug')
      .populate('gateIds', 'name slug gateType divisionId')
      .populate('departmentIds', 'name slug isActive');

    if (!user || !user.isActive) {
      // Still run a dummy bcrypt to prevent timing-based username enumeration
      await bcrypt.compare(password, '$2b$10$dummyhashfordummycompareXXXXXXXXXXXXXXXXXXXXXXXX');
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = user.hrmsEmployeeId
      ? await verifyHrmsEmployeePassword(user.hrmsEmployeeId, password)
      : await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.isSuperAdmin && user.systemRoleId && !user.systemRoleId.isActive) {
      return res.status(403).json({ error: 'Your assigned role is inactive. Contact an administrator.' });
    }

    if (shouldForceEmployeeAfterHoursLogout(user)) {
      return res.status(403).json({
        error: AFTER_HOURS_LOGOUT_MESSAGE,
        code: AFTER_HOURS_LOGOUT_CODE,
      });
    }

    // ── Bootstrap: auto-approve the very first Super Admin device ────────────
    // Only runs when Device Maintenance Mode is enabled.
    // Conditions (ALL must be true):
    //   1. Device Maintenance Mode is ON.
    //   2. Authenticating user is a Super Admin.
    //   3. A device fingerprint was supplied in the login body.
    //   4. No approved Super Admin device exists yet (fresh installation).
    if (user.isSuperAdmin && fingerprint) {
      try {
        const settings = await getOrCreateSettings('default');
        if (settings.deviceMaintenanceEnabled) {
          const hasPrimary = await hasPrimaryAdminDevice('default');
          if (!hasPrimary) {
            const bootstrapResult = await bootstrapApproveDevice({
              fingerprint,
              req,
              organizationId: 'default',
            });
            if (bootstrapResult.ok && bootstrapResult.bootstrapped) {
              console.log(
                `[Bootstrap] Super Admin "${user.username}" — device auto-approved on first login.`
              );
            }
          }
        }
      } catch (err) {
        // Bootstrap failure must never block login — log and continue
        console.warn('[Bootstrap] device approval failed (non-fatal):', err.message);
      }
    }

    // Fire-and-forget lastLoginAt update — do NOT await, never block the response
    SystemUser.updateOne({ _id: user._id }, { lastLoginAt: new Date() }).catch(() => {});

    const token = signToken(user);
    res.json({ token, user: serializeUser(user) });
  })
);

// ─── /sso-login ──────────────────────────────────────────────────────────────
// Verifies encrypted token from CRM Gateway and establishes SAMS session
router.post(
  '/sso-login',
  asyncHandler(async (req, res) => {
    const { token } = req.body;

    let cleanToken = typeof token === 'string' ? token.trim() : '';
    try {
      if (cleanToken.includes('%')) {
        cleanToken = decodeURIComponent(cleanToken);
      }
    } catch (_) {}
    // Restore base64 '+' characters if converted to spaces during URL query decoding
    if (cleanToken.includes(' ')) {
      cleanToken = cleanToken.replace(/ /g, '+');
    }

    if (!cleanToken) {
      return res.status(400).json({
        success: false,
        message: 'SSO token is required',
      });
    }

    // 1. Verify token with CRM Gateway
    const CRM_AUTH_URL = process.env.CRM_AUTH_URL || 'https://crm.pydah.edu.in';
    console.log(
      `[SAMS-SSO] Verifying token with CRM (${CRM_AUTH_URL}). Length: ${cleanToken.length}, preview: ${cleanToken.substring(0, 10)}...${cleanToken.substring(cleanToken.length - 8)}`
    );

    let crmResponse;
    try {
      const response = await fetch(`${CRM_AUTH_URL}/api/auth/verify-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedToken: cleanToken,
          token: cleanToken,
          portalId: 'sams',
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || !data.data) {
        console.error('[SAMS-SSO] CRM verify-token failed:', {
          status: response.status,
          statusText: response.statusText,
          message: data?.message,
          data,
        });
        return res.status(401).json({
          success: false,
          message: data?.message || 'Invalid or expired SSO token',
        });
      }
      crmResponse = data;
    } catch (apiErr) {
      console.error('[SAMS-SSO] CRM verify-token error:', apiErr.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired SSO token',
      });
    }

    const crmData = crmResponse.data;
    const {
      userId,
      username,
      displayName,
      name,
      email,
      hrmsEmployeeId,
      employeeId,
      empNo,
      isSuperAdmin,
    } = crmData;

    const empId = hrmsEmployeeId || employeeId || empNo;

    console.log(`[SAMS-SSO] Verified CRM user: ${displayName || name || username} (Emp: ${empId}, Email: ${email})`);

    // 2. Locate SystemUser in SAMS database
    const orConditions = [];
    if (empId) {
      orConditions.push({ hrmsEmployeeId: String(empId).trim() });
    }
    if (email && typeof email === 'string' && email.trim()) {
      orConditions.push({ email: email.toLowerCase().trim() });
    }
    if (username && typeof username === 'string' && username.trim()) {
      orConditions.push({ username: username.toLowerCase().trim() });
    }
    if (userId && /^[0-9a-fA-F]{24}$/.test(userId)) {
      orConditions.push({ _id: userId });
    }

    let user = null;
    if (orConditions.length > 0) {
      user = await SystemUser.findOne({
        $or: orConditions,
        isActive: true,
      })
        .populate('systemRoleId', 'name slug permissions isActive')
        .populate('divisionIds', 'name slug')
        .populate('gateIds', 'name slug gateType divisionId')
        .populate('departmentIds', 'name slug isActive');
    }

    // 3. Auto-provision if user does not exist yet (e.g. HRMS admin logging in for first time)
    if (!user) {
      console.log(`[SAMS-SSO] Auto-provisioning new SAMS SystemUser for: ${displayName || name || username || empId}`);
      const baseUsername = (username || (email ? email.split('@')[0] : empId) || `user_${Date.now()}`)
        .toLowerCase()
        .trim();

      let chosenUsername = baseUsername;
      const existing = await SystemUser.findOne({ username: chosenUsername });
      if (existing) {
        chosenUsername = `${baseUsername}_${Math.floor(1000 + Math.random() * 9000)}`;
      }

      user = new SystemUser({
        username: chosenUsername,
        displayName: displayName || name || username || 'SAMS Operator',
        email: email ? email.toLowerCase().trim() : '',
        hrmsEmployeeId: empId ? String(empId).trim() : undefined,
        passwordHash: 'SSO_MANAGED_AUTHENTICATION',
        isSuperAdmin: Boolean(isSuperAdmin),
        isActive: true,
        lastLoginAt: new Date(),
      });
      await user.save();
    } else {
      if (isSuperAdmin !== undefined && Boolean(isSuperAdmin) !== user.isSuperAdmin) {
        user.isSuperAdmin = Boolean(isSuperAdmin);
      }
      user.lastLoginAt = new Date();
      await user.save();
    }

    if (!user.isSuperAdmin && user.systemRoleId && !user.systemRoleId.isActive) {
      return res.status(403).json({
        success: false,
        error: 'Your assigned role is inactive. Contact an administrator.',
        message: 'Your assigned role is inactive. Contact an administrator.',
      });
    }

    if (shouldForceEmployeeAfterHoursLogout(user)) {
      return res.status(403).json({
        success: false,
        error: AFTER_HOURS_LOGOUT_MESSAGE,
        message: AFTER_HOURS_LOGOUT_MESSAGE,
        code: AFTER_HOURS_LOGOUT_CODE,
      });
    }

    // 4. Generate local SAMS JWT
    const tokenPayload = signToken(user);

    // 5. Return authenticated session
    const serialized = serializeUser(user);
    return res.status(200).json({
      success: true,
      message: 'SSO login successful',
      token: tokenPayload,
      user: {
        ...serialized,
        id: user._id.toString(),
        isSSO: true,
      },
    });
  })
);

router.post(
  '/verify-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const user = await SystemUser.findById(req.user._id).select('+passwordHash');
    if (!user) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const valid = user.hrmsEmployeeId
      ? await verifyHrmsEmployeePassword(user.hrmsEmployeeId, password)
      : await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    res.json({ ok: true });
  })
);

router.get(
  '/access-scope',
  authenticate,
  asyncHandler(async (req, res) => {
    const scope = await getUserAccessScope(req.user);
    res.json(scope);
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(serializeUser(req.user));
  })
);

router.put(
  '/password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { password, confirmPassword } = req.body;

    if (!password || !confirmPassword) {
      return res.status(400).json({ error: 'Password and confirmation are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    const user = await SystemUser.findById(req.user._id).select('+passwordHash');
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (user.hrmsEmployeeId) {
      return res.status(400).json({ error: 'Manage this account password in HRMS' });
    }

    user.passwordHash = await bcrypt.hash(password, 12);
    await user.save();

    res.json({ ok: true, message: 'Password updated successfully' });
  })
);

export default router;
