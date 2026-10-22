import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import SystemUser from '../models/SystemUser.js';
import SystemRole from '../models/SystemRole.js';
import Division from '../models/Division.js';
import Department from '../models/Department.js';
import Gate from '../models/Gate.js';
import SystemSetting from '../models/SystemSetting.js';
import { getHrmsEmployeeById, searchHrmsEmployees } from '../services/hrmsEmployeeService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { invalidateUserCache, requirePermission } from '../middleware/auth.js';
import {
  GATE_ACCESS_MODES,
  gateAccessModesToObject,
  normalizeGateAccessModes,
  normalizeDepartmentAccessModes,
  resolveGateAccessMode,
  resolveDepartmentAccessMode,
} from '../utils/gateAccessModes.js';

const router = Router();

function normalizeIdList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(String).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
}

async function validateAccessScope(divisionIds, gateIds, departmentIds, gateModesInput, deptModesInput) {
  if (divisionIds.length > 0) {
    const found = await Division.countDocuments({ _id: { $in: divisionIds } });
    if (found !== divisionIds.length) {
      return { error: 'One or more divisions were not found' };
    }
  }

  let gates = [];
  if (gateIds.length > 0) {
    gates = await Gate.find({ _id: { $in: gateIds } });
    if (gates.length !== gateIds.length) {
      return { error: 'One or more gates were not found' };
    }
    if (divisionIds.length > 0) {
      const divisionSet = new Set(divisionIds);
      const invalidGate = gates.find(
        (gate) => !divisionSet.has(gate.divisionId?.toString())
      );
      if (invalidGate) {
        return { error: 'Selected gates must belong to the selected divisions' };
      }
    }
  }

  if (gateModesInput !== undefined && gateModesInput !== null) {
    const modesObj = gateAccessModesToObject(gateModesInput);
    for (const [gateId, mode] of Object.entries(modesObj)) {
      if (!gateIds.includes(gateId)) continue;
      if (![GATE_ACCESS_MODES.ENTRY, GATE_ACCESS_MODES.EXIT, GATE_ACCESS_MODES.BOTH].includes(mode)) {
        return { error: 'Gate access mode must be entry, exit, or both' };
      }
    }
  }

  if (departmentIds.length > 0) {
    const departments = await Department.find({ _id: { $in: departmentIds } });
    if (departments.length !== departmentIds.length) {
      return { error: 'One or more departments were not found' };
    }
    if (divisionIds.length > 0) {
      const divisionSet = new Set(divisionIds);
      const invalidDept = departments.find((dept) =>
        !(dept.divisionIds || []).some((divId) => divisionSet.has(divId.toString()))
      );
      if (invalidDept) {
        return { error: 'Selected departments must belong to the selected divisions' };
      }
    }
  }

  if (deptModesInput !== undefined && deptModesInput !== null) {
    const modesObj = gateAccessModesToObject(deptModesInput);
    for (const [deptId, mode] of Object.entries(modesObj)) {
      if (!departmentIds.includes(deptId)) continue;
      if (![GATE_ACCESS_MODES.ENTRY, GATE_ACCESS_MODES.EXIT, GATE_ACCESS_MODES.BOTH].includes(mode)) {
        return { error: 'Department access mode must be entry, exit, or both' };
      }
    }
  }

  return { ok: true, gates };
}

function serializeGateAccessModes(user) {
  const stored = gateAccessModesToObject(user.gateAccessModes);
  const modes = {};
  for (const gate of user.gateIds || []) {
    const id = (gate?._id || gate)?.toString?.() || String(gate);
    const gateType = gate?.gateType;
    modes[id] = resolveGateAccessMode(gateType || 'both', stored[id]);
  }
  return modes;
}

function serializeDepartmentAccessModes(user) {
  const stored = gateAccessModesToObject(user.departmentAccessModes);
  const modes = {};
  for (const dept of user.departmentIds || []) {
    const id = (dept?._id || dept)?.toString?.() || String(dept);
    modes[id] = resolveDepartmentAccessMode(stored[id]);
  }
  return modes;
}

function serializeUser(user) {
  const role = user.systemRoleId;
  const permissions =
    role?.permissions instanceof Map
      ? Object.fromEntries(role.permissions.entries())
      : role?.permissions;

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
    gateAccessModes: serializeGateAccessModes(user),
    departmentIds: user.departmentIds,
    departmentAccessModes: serializeDepartmentAccessModes(user),
    allowedLocationIds: user.allowedLocationIds,
    systemRoleId: role
      ? {
          _id: role._id,
          name: role.name,
          slug: role.slug,
          isActive: role.isActive,
          permissions,
        }
      : null,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

router.get(
  '/hrms-employees',
  requirePermission('system_users', 'write'),
  asyncHandler(async (req, res) => {
    const settings = await SystemSetting.findOne({ singleton: 'singleton' });
    if (settings?.gateSettings?.hrmsEmployeeCreationEnabled === false) {
      return res.status(403).json({ error: 'Adding system users from HRMS is disabled' });
    }

    const search = String(req.query.search || '').trim();
    if (search.length < 2) {
      return res.status(400).json({ error: 'Search must be at least 2 characters' });
    }
    if (search.length > 100) {
      return res.status(400).json({ error: 'Search must be 100 characters or fewer' });
    }

    const linkedEmployeeIds = await SystemUser.distinct('hrmsEmployeeId', {
      hrmsEmployeeId: { $type: 'string' },
    });
    const employees = await searchHrmsEmployees(search, linkedEmployeeIds);
    res.json(employees);
  })
);

router.get(
  '/',
  requirePermission('system_users', 'read'),
  asyncHandler(async (req, res) => {
    const users = await SystemUser.find()
      .populate('systemRoleId', 'name slug isActive')
      .populate('divisionIds', 'name slug')
      .populate('gateIds', 'name slug gateType')
      .populate('departmentIds', 'name slug isActive')
      .populate('allowedLocationIds', 'name radius')
      .sort({ createdAt: -1 });
    res.json(users.map(serializeUser));
  })
);

router.get(
  '/:id',
  requirePermission('system_users', 'read'),
  asyncHandler(async (req, res) => {
    const user = await SystemUser.findById(req.params.id)
      .populate('systemRoleId', 'name slug isActive permissions')
      .populate('divisionIds', 'name slug')
      .populate('gateIds', 'name slug gateType')
      .populate('departmentIds', 'name slug isActive')
      .populate('allowedLocationIds', 'name radius');
    if (!user) return res.status(404).json({ error: 'System user not found' });
    res.json(serializeUser(user));
  })
);

router.post(
  '/',
  requirePermission('system_users', 'write'),
  asyncHandler(async (req, res) => {
    const { username, password, systemRoleId, hrmsEmployeeId } = req.body;
    let accountUsername = username;
    let { displayName, email } = req.body;

    if (!systemRoleId) return res.status(400).json({ error: 'System role is required' });

    let linkedHrmsEmployeeId;
    if (hrmsEmployeeId !== undefined && hrmsEmployeeId !== null && hrmsEmployeeId !== '') {
      const settings = await SystemSetting.findOne({ singleton: 'singleton' });
      if (settings?.gateSettings?.hrmsEmployeeCreationEnabled === false) {
        return res.status(403).json({ error: 'Adding system users from HRMS is disabled' });
      }
      if (!mongoose.Types.ObjectId.isValid(hrmsEmployeeId)) {
        return res.status(400).json({ error: 'Invalid HRMS employee' });
      }
      const employee = await getHrmsEmployeeById(String(hrmsEmployeeId));
      if (!employee) return res.status(404).json({ error: 'Active HRMS employee not found' });
      if (!employee.employeeId) {
        return res.status(400).json({ error: 'HRMS employee number is required for login' });
      }
      if (!employee.hasHrmsPassword) {
        return res.status(400).json({ error: 'HRMS employee does not have a supported password' });
      }
      const existingLink = await SystemUser.findOne({ hrmsEmployeeId: employee._id });
      if (existingLink) {
        return res.status(409).json({ error: 'This HRMS employee already has a system user' });
      }
      displayName = employee.displayName;
      email = employee.email;
      accountUsername = employee.employeeId;
      linkedHrmsEmployeeId = employee._id;
    }

    if (!displayName?.trim()) return res.status(400).json({ error: 'Display name is required' });
    if (!linkedHrmsEmployeeId && !accountUsername?.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!linkedHrmsEmployeeId && (!password || password.length < 6)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const role = await SystemRole.findById(systemRoleId);
    if (!role || !role.isActive) {
      return res.status(400).json({ error: 'Valid active system role is required' });
    }

    const divisionIds = normalizeIdList(req.body.divisionIds);
    const gateIds = normalizeIdList(req.body.gateIds);
    const departmentIds = normalizeIdList(req.body.departmentIds);
    const scopeCheck = await validateAccessScope(
      divisionIds,
      gateIds,
      departmentIds,
      req.body.gateAccessModes,
      req.body.departmentAccessModes
    );
    if (scopeCheck.error) return res.status(400).json({ error: scopeCheck.error });

    const gateAccessModes = normalizeGateAccessModes(
      gateIds,
      scopeCheck.gates || [],
      req.body.gateAccessModes
    );
    const departmentAccessModes = normalizeDepartmentAccessModes(
      departmentIds,
      req.body.departmentAccessModes
    );

    const normalizedUsername = String(accountUsername).toLowerCase().trim();
    const existing = await SystemUser.findOne({ username: normalizedUsername });
    if (existing) return res.status(409).json({ error: 'Username already exists' });

    const passwordHash = linkedHrmsEmployeeId
      ? await bcrypt.hash(randomBytes(48).toString('hex'), 12)
      : await bcrypt.hash(password, 12);
    const user = await SystemUser.create({
      username: normalizedUsername,
      passwordHash,
      displayName: displayName.trim(),
      email: email?.trim() || '',
      ...(linkedHrmsEmployeeId ? { hrmsEmployeeId: linkedHrmsEmployeeId } : {}),
      systemRoleId,
      isSuperAdmin: false,
      divisionIds,
      gateIds,
      gateAccessModes,
      departmentIds,
      departmentAccessModes,
    });

    const populated = await SystemUser.findById(user._id)
      .populate('systemRoleId', 'name slug')
      .populate('divisionIds', 'name slug')
      .populate('gateIds', 'name slug gateType')
      .populate('departmentIds', 'name slug isActive')
      .populate('allowedLocationIds', 'name radius');

    res.status(201).json(serializeUser(populated));
  })
);

router.put(
  '/:id',
  requirePermission('system_users', 'write'),
  asyncHandler(async (req, res) => {
    const user = await SystemUser.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'System user not found' });
    if (user.isSuperAdmin) {
      return res.status(400).json({ error: 'Super admin account cannot be modified here' });
    }
    if (user.hrmsEmployeeId && req.body.password) {
      return res.status(400).json({ error: 'Manage this account password in HRMS' });
    }
    if (req.body.hrmsEmployeeId !== undefined && req.body.password) {
      return res.status(400).json({ error: 'Manage this account password in HRMS' });
    }

    const updates = {};
    if (req.body.displayName !== undefined) updates.displayName = req.body.displayName.trim();
    if (req.body.email !== undefined) updates.email = req.body.email.trim();
    if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;

    if (req.body.hrmsEmployeeId !== undefined) {
      if (user.hrmsEmployeeId) {
        return res.status(400).json({ error: 'This account is already linked to an HRMS employee' });
      }
      const settings = await SystemSetting.findOne({ singleton: 'singleton' });
      if (settings?.gateSettings?.hrmsEmployeeCreationEnabled === false) {
        return res.status(403).json({ error: 'Adding system users from HRMS is disabled' });
      }
      if (!mongoose.Types.ObjectId.isValid(req.body.hrmsEmployeeId)) {
        return res.status(400).json({ error: 'Invalid HRMS employee' });
      }
      const employee = await getHrmsEmployeeById(String(req.body.hrmsEmployeeId));
      if (!employee) return res.status(404).json({ error: 'Active HRMS employee not found' });
      if (!employee.employeeId) {
        return res.status(400).json({ error: 'HRMS employee number is required for login' });
      }
      if (!employee.hasHrmsPassword) {
        return res.status(400).json({ error: 'HRMS employee does not have a supported password' });
      }
      const existingLink = await SystemUser.findOne({
        hrmsEmployeeId: employee._id,
        _id: { $ne: user._id },
      });
      if (existingLink) {
        return res.status(409).json({ error: 'This HRMS employee already has a system user' });
      }
      updates.hrmsEmployeeId = employee._id;
    }

    if (req.body.systemRoleId !== undefined) {
      const role = await SystemRole.findById(req.body.systemRoleId);
      if (!role || !role.isActive) {
        return res.status(400).json({ error: 'Valid active system role is required' });
      }
      updates.systemRoleId = req.body.systemRoleId;
    }

    if (
      req.body.divisionIds !== undefined ||
      req.body.gateIds !== undefined ||
      req.body.departmentIds !== undefined ||
      req.body.gateAccessModes !== undefined ||
      req.body.departmentAccessModes !== undefined
    ) {
      const divisionIds = normalizeIdList(
        req.body.divisionIds !== undefined ? req.body.divisionIds : user.divisionIds
      );
      const gateIds = normalizeIdList(
        req.body.gateIds !== undefined ? req.body.gateIds : user.gateIds
      );
      const departmentIds = normalizeIdList(
        req.body.departmentIds !== undefined ? req.body.departmentIds : user.departmentIds
      );
      const modesInput =
        req.body.gateAccessModes !== undefined
          ? req.body.gateAccessModes
          : gateAccessModesToObject(user.gateAccessModes);
      const deptModesInput =
        req.body.departmentAccessModes !== undefined
          ? req.body.departmentAccessModes
          : gateAccessModesToObject(user.departmentAccessModes);
      const scopeCheck = await validateAccessScope(
        divisionIds,
        gateIds,
        departmentIds,
        modesInput,
        deptModesInput
      );
      if (scopeCheck.error) return res.status(400).json({ error: scopeCheck.error });
      updates.divisionIds = divisionIds;
      updates.gateIds = gateIds;
      updates.gateAccessModes = normalizeGateAccessModes(
        gateIds,
        scopeCheck.gates || [],
        modesInput
      );
      updates.departmentIds = departmentIds;
      updates.departmentAccessModes = normalizeDepartmentAccessModes(
        departmentIds,
        deptModesInput
      );
    }

    if (req.body.password) {
      if (req.body.password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      updates.passwordHash = await bcrypt.hash(req.body.password, 12);
    }

    const updated = await SystemUser.findByIdAndUpdate(user._id, updates, {
      new: true,
      runValidators: true,
    })
      .populate('systemRoleId', 'name slug permissions')
      .populate('divisionIds', 'name slug')
      .populate('gateIds', 'name slug gateType')
      .populate('departmentIds', 'name slug isActive')
      .populate('allowedLocationIds', 'name radius');

    invalidateUserCache(user._id);
    res.json(serializeUser(updated));
  })
);

router.delete(
  '/:id',
  requirePermission('system_users', 'write'),
  asyncHandler(async (req, res) => {
    const user = await SystemUser.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'System user not found' });
    if (user.isSuperAdmin) {
      return res.status(400).json({ error: 'Super admin account cannot be deleted' });
    }
    await user.deleteOne();
    res.json({ message: 'System user deleted' });
  })
);

export default router;
