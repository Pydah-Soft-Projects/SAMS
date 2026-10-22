import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import Registration from '../models/Registration.js';
import GateLog from '../models/GateLog.js';
import Gate from '../models/Gate.js';
import Division from '../models/Division.js';
import Department from '../models/Department.js';
import Pass from '../models/Pass.js';
import ActivitySighting from '../models/ActivitySighting.js';
import SystemSetting from '../models/SystemSetting.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { REGISTRATION_STATUS, GATE_EVENT_TYPES, GATE_TYPES, SCAN_TYPES, PASS_TYPES } from '../constants/index.js';
import {
  extractFaceEmbedding,
  extractFaceEmbeddingsMulti,
  compareFaceEmbeddings,
  searchFaceEmbeddings,
} from '../services/aiClient.js';
import { loadRegistrationContext, formatPassResponse } from '../services/passService.js';
import { buildDisplayInfo, photoUrlFromPath } from '../utils/displayInfo.js';
import { grantedGateLogFilter } from '../utils/gateLogFilters.js';
import { withRegistrationScanLock } from '../utils/scanLock.js';
import { normalizeEmbedMultiFaces } from '../utils/normalizeEmbedMultiFaces.js';
import {
  getActiveDayPass,
  getPassSessionState,
  validateGateScan,
  validateDepartmentScan,
  createOrRefreshDayPass,
  updateDayPassAfterDepartmentScan,
  updateDayPassAfterGateExit,
  syncDepartmentVisitsFromLogs,
  madeGateEntryToday,
  isPersonInsideTargetDivision,
  getActiveDivisionSession,
  resolveAutoGateEventType,
  resolveAutoDepartmentEventType,
  isOppositeGateEvent,
  assertNotDuplicateScan,
  GATE_DENIAL_REASONS,
  todayDateString,
  forceCheckoutActiveDepartment,
  findLatestGateEntryAnyDivision,
  getTodayLogsForRegistration,
  isRegistrationGateOptionalByPayCategory,
} from '../services/attendanceService.js';
import { startOfDayIst, endOfDayIst } from '../utils/istTime.js';
import { getRequiredSteps } from '../constants/accessRules.js';
import { rebuildFaceIndexFromDb } from '../services/faceIndexService.js';
import { createMulter, uploadDir } from '../utils/storage.js';
import { cropAndSaveActivityFace, persistActivityFaceBuffer } from '../utils/activityFaceCrop.js';
import {
  isObjectStorageEnabled,
  uploadPhoto,
} from '../services/objectStorage.js';
import { hasDivisionScope, hasDepartmentScope, hasGateScope, hasGateEventScope, hasDepartmentEventScope, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { getScopedDivisionIds, resolveDivisionFilterIds } from '../services/accessScopeService.js';

const router = Router();
const MATCH_THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.42');
const MIN_MATCH_MARGIN = parseFloat(process.env.MIN_MATCH_MARGIN || '0.05');
const SEARCH_TOP_K = parseInt(process.env.SEARCH_TOP_K || '5', 10);
const EMBEDDING_SIZE = parseInt(process.env.FACE_EMBEDDING_SIZE || '512', 10);

const upload = createMulter('gate', (req, file) => {
  return `gate-${Date.now()}${path.extname(file.originalname) || '.jpg'}`;
});

/**
 * Start gate audit-photo upload without blocking the scan response.
 * Face match is fast; S3 put can take longer — attach the URL to the log later.
 */
function startGatePhotoUpload(imageBuffer, filePath) {
  if (!isObjectStorageEnabled()) {
    return Promise.resolve(filePath);
  }
  return uploadPhoto(imageBuffer, 'gate', `gate-${Date.now()}.jpg`, 'image/jpeg')
    .then((result) => {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return result.url;
    })
    .catch((err) => {
      console.error('Object storage gate upload failed, falling back to local:', err.message);
      if (filePath) return filePath;
      try {
        const dir = path.join(uploadDir, 'gate');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const localPath = path.join(dir, `gate-${Date.now()}.jpg`);
        fs.writeFileSync(localPath, imageBuffer);
        return localPath;
      } catch (writeErr) {
        console.error('Local gate photo fallback failed:', writeErr.message);
        return null;
      }
    });
}

function attachGatePhotoWhenReady(logId, uploadPromise) {
  if (!logId || !uploadPromise) return;
  uploadPromise
    .then(async (savedPath) => {
      if (!savedPath) return;
      await GateLog.findByIdAndUpdate(logId, { photoPath: savedPath });
    })
    .catch((err) => {
      console.error('Background gate photo attach failed:', err.message);
    });
}

function discardGatePhotoUpload(uploadPromise) {
  if (!uploadPromise) return;
  uploadPromise
    .then((savedPath) => {
      if (savedPath && !String(savedPath).startsWith('http') && fs.existsSync(savedPath)) {
        fs.unlinkSync(savedPath);
      }
    })
    .catch(() => {});
}

/** Attach the logged-in operator to every gate/department scan attempt. */
function operatorFields(user) {
  if (!user?._id) return {};
  return {
    scannedBy: user._id,
    scannedByName: user.displayName || user.username || '',
    scannedByUsername: user.username || '',
  };
}

async function finalizeGateLog(log) {
  if (!log) return log;
  log.accessGranted = true;
  log.matched = true;
  if (log.metadata?.forceDepartmentCheckout) {
    const now = new Date();
    await GateLog.updateOne(
      { _id: log._id },
      { $set: { accessGranted: true, matched: true, createdAt: now } }
    );
    log.createdAt = now;
    return log;
  }
  await log.save();
  return log;
}

/**
 * Persist a rejected scan attempt for the audit trail instead of discarding it.
 * The log keeps accessGranted=false plus the denial reason, so audit views can
 * show every attempted entry/exit while attendance queries (granted-only) skip it.
 */
async function markGateLogDenied(log, reason, error) {
  if (!log?._id) return null;
  try {
    log.accessGranted = false;
    log.metadata = {
      ...(log.metadata || {}),
      denialReason: reason || 'denied',
      denialError: error || '',
    };
    log.markModified('metadata');
    await log.save();
    return log;
  } catch (err) {
    console.error('Failed to persist denied gate log:', err.message);
    return null;
  }
}

router.get(
  '/logs',
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.registrationId) filter.registrationId = req.query.registrationId;
    if (req.query.eventType) filter.eventType = req.query.eventType;
    if (req.query.departmentId) filter.departmentId = req.query.departmentId;
    if (req.query.gateRefId) filter.gateRefId = req.query.gateRefId;
    if (req.query.scanType) filter.scanType = req.query.scanType;
    if (req.query.matched === 'true') filter.matched = true;
    if (req.query.matched === 'false') filter.matched = false;
    if (req.query.successOnly !== 'false') {
      filter.matched = true;
      filter.$or = [{ accessGranted: true }, { accessGranted: { $exists: false } }];
    } else if (req.query.status === 'granted') {
      filter.$or = [{ accessGranted: true }, { accessGranted: { $exists: false } }];
    } else if (req.query.status === 'denied') {
      filter.accessGranted = false;
    }

    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = startOfDayIst(req.query.dateFrom);
      if (req.query.dateTo) filter.createdAt.$lte = endOfDayIst(req.query.dateTo);
    }

    // RBAC division scoping: non-super-admins only see logs from their own
    // divisions; the optional `divisionId` query narrows within that scope.
    const scopedIds = req.user ? await getScopedDivisionIds(req.user) : null;
    const divisionIds = resolveDivisionFilterIds(scopedIds, req.query.divisionId);
    if (Array.isArray(divisionIds)) {
      filter.divisionId = { $in: divisionIds };
    }

    const logs = await GateLog.find(filter)
      .populate({
        path: 'registrationId',
        select: 'registrationCode formData formId photoPath',
        populate: { path: 'formId', select: 'fields' },
      })
      .populate('roleId', 'name slug')
      .populate('divisionId', 'name slug')
      .populate('departmentId', 'name slug')
      .populate('gateRefId', 'name gateType slug')
      .populate('scannedBy', 'username displayName')
      .sort({ createdAt: -1 })
      .limit(parseInt(req.query.limit || '100', 10));

    const items = logs.map((log) => {
      const obj = log.toObject();
      const reg = obj.registrationId;
      const display = reg
        ? buildDisplayInfo(reg.formData, reg.formId?.fields || [])
        : null;
      const operatorName =
        obj.scannedByName ||
        obj.scannedBy?.displayName ||
        obj.scannedBy?.username ||
        null;
      const operatorUsername =
        obj.scannedByUsername || obj.scannedBy?.username || null;
      return {
        ...obj,
        holderName: display?.displayName || null,
        holderPhotoUrl: reg?.photoPath ? photoUrlFromPath(reg.photoPath) : null,
        denialReason: obj.metadata?.denialReason || null,
        denialError: obj.metadata?.denialError || null,
        operatorName,
        operatorUsername,
      };
    });

    res.json(items);
  })
);

router.get(
  '/status/:registrationId',
  asyncHandler(async (req, res) => {
    const [lastEntry, lastExit] = await Promise.all([
      GateLog.findOne(
        grantedGateLogFilter({
          registrationId: req.params.registrationId,
          eventType: GATE_EVENT_TYPES.ENTRY,
        })
      ).sort({ createdAt: -1 }),
      GateLog.findOne(
        grantedGateLogFilter({
          registrationId: req.params.registrationId,
          eventType: GATE_EVENT_TYPES.EXIT,
        })
      ).sort({ createdAt: -1 }),
    ]);

    const isInside =
      lastEntry && (!lastExit || lastEntry.createdAt > lastExit.createdAt);

    res.json({ isInside, lastEntry, lastExit });
  })
);

router.post(
  '/reindex',
  asyncHandler(async (req, res) => {
    const result = await rebuildFaceIndexFromDb();
    res.json({
      ok: true,
      message:
        result.indexed > 0
          ? `Indexed ${result.indexed} verified face(s)`
          : 'No 512-d face embeddings found. Verify users and re-upload photos.',
      ...result,
    });
  })
);

// ─── Attach shift (deprecated — shifts are assigned at registration) ─────────
router.patch(
  '/logs/:id/shift',
  asyncHandler(async (req, res) => {
    res.status(410).json({
      error: 'Shift assignment at gate is no longer supported. Assign the shift on the registration.',
    });
  })
);

// ─── Attach remark to a department check-in log ──────────────────────────────
router.patch(
  '/logs/:id/remark',
  asyncHandler(async (req, res) => {
    const remark = typeof req.body?.remark === 'string' ? req.body.remark.trim() : '';

    const log = await GateLog.findById(req.params.id);
    if (!log) return res.status(404).json({ error: 'Gate log not found' });

    if (log.scanType !== SCAN_TYPES.DEPARTMENT || log.eventType !== GATE_EVENT_TYPES.ENTRY) {
      // Allow legacy QR dept check-ins that stored scanType as "qr"
      const isLegacyDeptCheckIn =
        log.scanType === SCAN_TYPES.QR &&
        log.departmentId &&
        log.eventType === GATE_EVENT_TYPES.ENTRY;
      if (!isLegacyDeptCheckIn) {
        return res.status(400).json({ error: 'Remarks can only be added on department check-in' });
      }
    }

    log.remark = remark;
    await log.save();

    res.json({ ok: true, log });
  })
);

async function formatRegistrationForScan(registrationDoc) {
  // lean + no faceEmbedding: the 512-float embedding is useless to the client
  // and dominates the payload/hydration cost otherwise.
  const obj = await Registration.findById(registrationDoc._id)
    .select('-faceEmbedding')
    .populate('roleId', 'name slug isShiftBased')
    .populate('formId', 'fields')
    .lean();
  if (!obj) return null;
  const display = buildDisplayInfo(obj.formData, obj.formId?.fields || []);
  return {
    ...obj,
    displayName: display.displayName,
    displayPhone: display.displayPhone,
    formDetails: display.details,
    photoUrl: photoUrlFromPath(obj.photoPath),
  };
}

function buildScanDenialResponse({
  scanType,
  matchScore,
  registration,
  log,
  error,
  reason,
  sessionState,
  dayPass,
  hasGateEntry,
  activeDepartment,
  activeDivision,
  requiredSteps,
  securityReview = false,
  requestedEventType = null,
  suggestedEventType = null,
  resolvedEventType = null,
  personInside = null,
  todayLogs = [],
  checkoutWaitRemainingMs = null,
}) {
  return {
    matched: true,
    denied: true,
    scanType,
    matchScore,
    registration,
    log,
    error,
    reason,
    hasGateEntry,
    activeDepartment,
    activeDivision,
    sessionState,
    dayPass,
    requiredSteps,
    securityReview,
    requestedEventType,
    suggestedEventType,
    resolvedEventType,
    personInside,
    todayLogs,
    checkoutWaitRemainingMs,
    // Gate exit blocked by open department — UI may offer force dept out + gate out.
    canForceCheckout: reason === GATE_DENIAL_REASONS.DEPARTMENT_STILL_ACTIVE,
  };
}

function parseForceDepartmentCheckout(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

/**
 * When an operator confirms force checkout on gate exit, close the open
 * department visit first so validateGateScan can proceed.
 */
async function applyForceDepartmentCheckoutIfRequested({
  forceDepartmentCheckout,
  resolvedEventType,
  activePass,
  registrationId,
  divisionId,
  matchScore,
  operator,
  sourceLogId,
  photoPath = null,
}) {
  if (
    !forceDepartmentCheckout ||
    resolvedEventType !== GATE_EVENT_TYPES.EXIT ||
    !activePass
  ) {
    return { activePass, forcedDepartmentCheckout: null };
  }

  const result = await forceCheckoutActiveDepartment({
    pass: activePass,
    registrationId,
    divisionId,
    matchScore,
    operator,
    sourceLogId,
    photoPath,
  });

  return {
    activePass: result.pass || activePass,
    forcedDepartmentCheckout: result.activeDepartment
      ? {
          ...result.activeDepartment,
          departmentLogId: result.departmentLog?._id || null,
          photoPath: result.departmentLog?.photoPath || photoPath || null,
        }
      : null,
  };
}

/**
 * Synthesise a gate-entry GateLog for a division where gateEntryRequired=false.
 * Called right before the department scan is finalised so the day-pass and
 * attendance reports have a matching gate entry on the same day.
 *
 * The synthetic log is stamped with:
 *   - the same createdAt as the department scan (so it sorts before it)
 *   - the photoPath from borrowedGateEntry (the person's most recent gate
 *     entry from any division today), or the photo captured for this scan
 *
 * @returns {Promise<GateLog>}
 */
async function createAutoGateEntryLog({
  registrationId,
  roleId,
  divisionId,
  matchScore,
  photoPath,
  borrowedGateEntry,
  operator,
  deptLogId,
  deptLogCreatedAt,
  isContractorGateOptional = false,
}) {
  const entryPhotoPath = borrowedGateEntry?.photoPath || photoPath || undefined;
  const now = deptLogCreatedAt ? new Date(new Date(deptLogCreatedAt).getTime() - 1000) : new Date();

  const log = await GateLog.create({
    registrationId,
    roleId,
    divisionId,
    matchScore,
    matched: true,
    accessGranted: true,
    scanType: SCAN_TYPES.GATE,
    eventType: GATE_EVENT_TYPES.ENTRY,
    gateId: 'auto-optional',
    photoPath: entryPhotoPath,
    scannedBy: operator?.scannedBy || null,
    scannedByName: operator?.scannedByName || '',
    scannedByUsername: operator?.scannedByUsername || '',
    metadata: {
      autoGateEntry: true,
      gateEntryOptional: true,
      isContractorGateOptional: Boolean(isContractorGateOptional),
      triggeringDeptLogId: deptLogId ? String(deptLogId) : null,
      borrowedFromLogId: borrowedGateEntry?.logId ? String(borrowedGateEntry.logId) : null,
      borrowedFromDivisionId: borrowedGateEntry?.divisionId ? String(borrowedGateEntry.divisionId) : null,
      borrowedEntryTime: borrowedGateEntry?.createdAt || null,
    },
  });

  // Backdate the log's createdAt so it sorts before the department scan
  // (MongoDB timestamps are immutable via schema; use a direct update).
  await GateLog.updateOne({ _id: log._id }, { $set: { createdAt: now } });
  log.createdAt = now;
  return log;
}

async function respondScanDenial(res, options) {
  const { log, reason, error, ...rest } = options;
  const savedLog = await markGateLogDenied(log, reason, error);
  const regId = options.registration?._id || options.registration?.id || savedLog?.registrationId;
  const divId = options.activeDivision?._id || options.activeDivision?.id || savedLog?.divisionId;
  let todayLogs = options.todayLogs || [];
  if (todayLogs.length === 0 && regId) {
    try {
      todayLogs = await getTodayLogsForRegistration(regId, divId, options.dayPass);
    } catch {
      // safe fallback
    }
  }
  return res.status(400).json(buildScanDenialResponse({ ...rest, reason, error, log: savedLog, todayLogs }));
}

async function identifyFromPhoto(file, registrationId) {
  const filePath = file.path || null;
  const imageBuffer = file.buffer || fs.readFileSync(filePath);
  const filename = file.filename || file.originalname || 'photo.jpg';

  const { embedding, face_detected } = await extractFaceEmbedding(
    imageBuffer,
    filename,
    'image/jpeg'
  );

  if (!face_detected || !embedding?.length) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { error: 'No face detected in the photo' };
  }

  // Start upload in parallel with face search — do NOT await before responding.
  // The scan handler attaches the URL to GateLog in the background.
  const uploadPromise = startGatePhotoUpload(imageBuffer, filePath);

  let matchedRegistration = null;
  let matchScore = 0;

  if (registrationId) {
    matchedRegistration = await Registration.findById(registrationId).select(
      'status faceEmbedding roleId registrationCode'
    );
    if (!matchedRegistration) {
      discardGatePhotoUpload(uploadPromise);
      return { error: 'Registration not found', status: 404 };
    }
    if (matchedRegistration.status !== REGISTRATION_STATUS.VERIFIED) {
      discardGatePhotoUpload(uploadPromise);
      return { error: 'Registration is not verified', status: 400 };
    }
    if (matchedRegistration.faceEmbedding?.length !== EMBEDDING_SIZE) {
      discardGatePhotoUpload(uploadPromise);
      return {
        error: 'Registration photo uses an outdated face model. Please re-upload the photo.',
        status: 400,
      };
    }
    const result = await compareFaceEmbeddings(matchedRegistration.faceEmbedding, embedding);
    matchScore = result.similarity;
  } else {
    const searchResult = await searchFaceEmbeddings(embedding, {
      topK: SEARCH_TOP_K,
      threshold: MATCH_THRESHOLD,
      minMargin: MIN_MATCH_MARGIN,
    });

    if (searchResult.ambiguous) {
      discardGatePhotoUpload(uploadPromise);
      return {
        ambiguous: true,
        matchScore: searchResult.best?.similarity ?? 0,
        candidates: searchResult.matches?.slice(0, 3) ?? [],
      };
    }

    if (searchResult.best?.id) {
      // Match already scored by the index — no need to load the embedding here.
      matchedRegistration = await Registration.findById(searchResult.best.id).select(
        '-faceEmbedding'
      );
      matchScore = searchResult.best.similarity;
    }
  }

  const matched = matchScore >= MATCH_THRESHOLD && !!matchedRegistration;
  return {
    matchedRegistration,
    matchScore,
    matched,
    autoIdentified: !registrationId,
    uploadPromise,
  };
}

// ─── QR-code gate scan ────────────────────────────────────────────────────────
// Accepts the passCode encoded in a Registration Pass QR, validates it and
// records the gate entry/exit exactly like a face scan would (matchScore = 1.0).
router.post(
  '/qr-scan',
  asyncHandler(async (req, res) => {
    const {
      passCode,
      eventType,
      gateId,
      divisionId: bodyDivisionId,
      departmentId,
      forceDepartmentCheckout: forceCheckoutRaw,
      autoCreateGateEntry: autoCreateGateEntryRaw,
    } = req.body;
    const forceDepartmentCheckout = parseForceDepartmentCheckout(forceCheckoutRaw);
    const autoCreateGateEntry = autoCreateGateEntryRaw === true || autoCreateGateEntryRaw === 'true';

    if (!passCode?.trim()) {
      return res.status(400).json({ error: 'passCode is required' });
    }

    const isAutoEvent = eventType === GATE_EVENT_TYPES.AUTO;
    if (
      !isAutoEvent &&
      !Object.values(GATE_EVENT_TYPES).includes(eventType)
    ) {
      return res.status(400).json({ error: 'eventType must be "entry", "exit", or "auto"' });
    }

    // Resolve gate/division info identical to face scan
    const effectiveScanType = departmentId ? SCAN_TYPES.DEPARTMENT : SCAN_TYPES.GATE;
    const logFields = { scanType: effectiveScanType };
    let divisionId = bodyDivisionId || null;
    let gateRecord = null;
    let department = null;

    if (effectiveScanType === SCAN_TYPES.GATE) {
      if (!gateId) return res.status(400).json({ error: 'gateId is required for gate scans' });

      gateRecord = await Gate.findById(gateId).populate('divisionId', 'name slug isActive');
      if (!gateRecord) return res.status(404).json({ error: 'Gate not found' });
      if (!gateRecord.isActive) return res.status(400).json({ error: 'Gate is inactive' });
      if (gateRecord.divisionId && !gateRecord.divisionId.isActive) {
        return res.status(400).json({ error: 'Division is inactive' });
      }
      if (gateRecord.gateType === GATE_TYPES.ENTRY && !isAutoEvent && eventType !== GATE_EVENT_TYPES.ENTRY) {
        return res.status(400).json({ error: 'This gate allows entry scans only' });
      }
      if (gateRecord.gateType === GATE_TYPES.EXIT && !isAutoEvent && eventType !== GATE_EVENT_TYPES.EXIT) {
        return res.status(400).json({ error: 'This gate allows exit scans only' });
      }
      if (isAutoEvent && gateRecord.gateType !== GATE_TYPES.BOTH) {
        return res.status(400).json({ error: 'Auto entry/exit is only available at combined entry & exit gates' });
      }

      divisionId = gateRecord.divisionId?._id || gateRecord.divisionId;
      logFields.gateRefId = gateRecord._id;
      logFields.divisionId = divisionId;
      logFields.gateId = gateRecord._id.toString();
    } else {
      if (!bodyDivisionId) {
        return res.status(400).json({ error: 'divisionId is required for department scans' });
      }
      if (!departmentId) {
        return res.status(400).json({ error: 'departmentId is required for department scans' });
      }

      department = await Department.findById(departmentId);
      if (!department) return res.status(404).json({ error: 'Department not found' });
      if (!department.isActive) return res.status(400).json({ error: 'Department is inactive' });

      const departmentDivisionIds = (department.divisionIds || []).map((id) => id.toString());
      if (!departmentDivisionIds.includes(bodyDivisionId.toString())) {
        return res.status(400).json({ error: 'Department does not belong to the selected division' });
      }

      divisionId = bodyDivisionId;
      logFields.divisionId = divisionId;
      logFields.departmentId = department._id;
      logFields.gateId = 'department';
    }

    // Scope check
    if (req.user && !req.user.isSuperAdmin) {
      if (!hasDivisionScope(req.user, divisionId)) {
        return res.status(403).json({ error: 'You do not have access to this division' });
      }
      if (effectiveScanType === SCAN_TYPES.GATE && !hasGateScope(req.user, gateRecord._id)) {
        return res.status(403).json({ error: 'You do not have access to this gate' });
      }
      if (
        effectiveScanType === SCAN_TYPES.GATE &&
        !hasGateEventScope(req.user, gateRecord._id, eventType, gateRecord.gateType)
      ) {
        return res.status(403).json({
          error: 'You do not have access to this gate mode (entry/exit)',
        });
      }
      if (effectiveScanType === SCAN_TYPES.DEPARTMENT && !hasDepartmentScope(req.user, department._id)) {
        return res.status(403).json({ error: 'You do not have access to this department' });
      }
      if (
        effectiveScanType === SCAN_TYPES.DEPARTMENT &&
        !hasDepartmentEventScope(req.user, department._id, eventType)
      ) {
        return res.status(403).json({ error: 'You do not have permission for this department event type' });
      }
    }

    // Resolve registration from the pass
    const pass = await Pass.findOne({ passCode: passCode.trim(), isActive: true });
    if (!pass) {
      return res.status(400).json({ error: 'Invalid or inactive pass. QR code not recognised.' });
    }
    if (pass.passType !== 'registration') {
      return res.status(400).json({ error: 'Only Registration Pass QR codes can be used at the gate.' });
    }

    const matchedRegistration = await Registration.findById(pass.registrationId);
    if (!matchedRegistration) {
      return res.status(404).json({ error: 'Registration not found for this pass' });
    }
    if (matchedRegistration.status !== REGISTRATION_STATUS.VERIFIED) {
      return res.status(400).json({ error: 'Registration is not verified' });
    }

    const matchScore = 1.0; // QR scan — identity is proven by possession of the pass

    const log = await GateLog.create({
      registrationId: matchedRegistration._id,
      roleId: matchedRegistration.roleId,
      matchScore,
      matched: true,
      accessGranted: false,
      ...logFields,
      ...operatorFields(req.user),
      eventType, // will be updated if auto-resolved
      metadata: { qrScan: true, passCode: pass.passCode, scanType: effectiveScanType },
    });

    return withRegistrationScanLock(matchedRegistration._id, async () => {
    const [populated, initialActivePass] = await Promise.all([
      formatRegistrationForScan(matchedRegistration),
      getActiveDayPass(matchedRegistration._id, divisionId),
    ]);
    let activePass = initialActivePass;
    let dayPass = activePass ? await formatPassResponse(activePass) : null;
    let sessionState = getPassSessionState(activePass);
    let resolvedEventType = eventType;
    let forcedDepartmentCheckout = null;

    if (effectiveScanType === SCAN_TYPES.GATE) {
      if (gateRecord.gateType === GATE_TYPES.BOTH) {
        const personInside = await isPersonInsideTargetDivision(matchedRegistration._id, divisionId);

        if (isAutoEvent) {
          resolvedEventType = await resolveAutoGateEventType(matchedRegistration._id, divisionId);
        } else if (isOppositeGateEvent(personInside, eventType)) {
          const suggestedEventType = personInside
            ? GATE_EVENT_TYPES.EXIT
            : GATE_EVENT_TYPES.ENTRY;
          return respondScanDenial(res, {
              scanType: effectiveScanType,
              matchScore,
              registration: populated,
              log,
              error: personInside
                ? 'This person is already inside the division. They should exit, not enter again.'
                : 'This person is not checked in at this division. They should enter, not exit.',
              reason: personInside
                ? GATE_DENIAL_REASONS.ALREADY_IN_DIVISION
                : GATE_DENIAL_REASONS.NOT_CHECKED_IN,
              sessionState,
              dayPass,
              activeDivision: personInside
                ? { divisionId: divisionId?.toString(), divisionName: gateRecord?.divisionId?.name || 'Division' }
                : null,
              requiredSteps: getRequiredSteps(
                personInside
                  ? GATE_DENIAL_REASONS.ALREADY_IN_DIVISION
                  : GATE_DENIAL_REASONS.NOT_CHECKED_IN,
                { hasActiveDepartment: Boolean(sessionState?.currentDepartmentId) }
              ),
              securityReview: false,
              requestedEventType: eventType,
              suggestedEventType,
            });
        }
      } else if (isAutoEvent) {
        await markGateLogDenied(log, 'invalid_gate_config', 'Auto entry/exit is only available at combined entry & exit gates');
        return res.status(400).json({ error: 'Auto entry/exit is only available at combined entry & exit gates' });
      }

      const gateDup = await assertNotDuplicateScan({
        registrationId: matchedRegistration._id,
        scanType: effectiveScanType,
        eventType: resolvedEventType,
        divisionId,
        gateRefId: gateRecord?._id,
        excludeLogId: log._id,
      });
      if (!gateDup.ok) {
        return respondScanDenial(res, {
          scanType: effectiveScanType,
          matchScore,
          registration: populated,
          log,
          error: gateDup.error,
          reason: gateDup.reason,
          sessionState,
          dayPass,
          requiredSteps: getRequiredSteps(gateDup.reason),
        });
      }

      ({ activePass, forcedDepartmentCheckout } = await applyForceDepartmentCheckoutIfRequested({
        forceDepartmentCheckout,
        resolvedEventType,
        activePass,
        registrationId: matchedRegistration._id,
        divisionId,
        matchScore,
        operator: operatorFields(req.user),
        sourceLogId: log._id,
        photoPath: log.photoPath || null,
      }));
      if (forcedDepartmentCheckout) {
        sessionState = getPassSessionState(activePass);
        dayPass = activePass ? await formatPassResponse(activePass) : dayPass;
        log.metadata = {
          ...(log.metadata || {}),
          forceDepartmentCheckout: true,
          forcedDepartmentId: forcedDepartmentCheckout.departmentId,
          forcedDepartmentName: forcedDepartmentCheckout.departmentName,
          forcedDepartmentLogId: forcedDepartmentCheckout.departmentLogId
            ? String(forcedDepartmentCheckout.departmentLogId)
            : null,
        };
        log.markModified('metadata');
        await log.save();
      }

      const gateCheck = await validateGateScan(
        activePass,
        resolvedEventType,
        matchedRegistration._id,
        divisionId
      );
      if (!gateCheck.ok) {
        const denialDayPass = gateCheck.pass
          ? await formatPassResponse(gateCheck.pass)
          : dayPass;
        return respondScanDenial(res, {
            scanType: effectiveScanType,
            matchScore,
            registration: populated,
            log,
            error: gateCheck.error,
            reason: gateCheck.reason,
            sessionState: gateCheck.sessionState || sessionState,
            dayPass: denialDayPass,
            activeDepartment: gateCheck.activeDepartment,
            activeDivision: gateCheck.activeDivision,
            requiredSteps: gateCheck.requiredSteps,
            checkoutWaitRemainingMs: gateCheck.checkoutWaitRemainingMs,
          });
      }

      if (resolvedEventType === GATE_EVENT_TYPES.ENTRY) {
        const { registration, role, display } = await loadRegistrationContext(matchedRegistration._id);
        dayPass = await createOrRefreshDayPass({
          registration,
          role,
          display,
          gateLogId: log._id,
          divisionId,
          divisionName: gateRecord?.divisionId?.name || '',
        });
        sessionState = getPassSessionState(await getActiveDayPass(matchedRegistration._id, divisionId));
      } else if (activePass) {
        dayPass = await updateDayPassAfterGateExit(activePass);
        sessionState = getPassSessionState(await getActiveDayPass(matchedRegistration._id, divisionId));
      }

      if (resolvedEventType !== eventType) {
        log.eventType = resolvedEventType;
        await log.save();
      }
    } else {
      // Department QR scan — support auto event type
      let resolvedDeptEventType = eventType;
      let deptAutoResolved = false;

      if (isAutoEvent) {
        resolvedDeptEventType = await resolveAutoDepartmentEventType(
          matchedRegistration._id, divisionId, department._id
        );
        deptAutoResolved = true;
        log.eventType = resolvedDeptEventType;
        await log.save();
      }

      const deptDup = await assertNotDuplicateScan({
        registrationId: matchedRegistration._id,
        scanType: effectiveScanType,
        eventType: resolvedDeptEventType,
        divisionId,
        departmentId: department._id,
        excludeLogId: log._id,
      });
      if (!deptDup.ok) {
        return respondScanDenial(res, {
          scanType: effectiveScanType,
          matchScore,
          registration: populated,
          log,
          error: deptDup.error,
          reason: deptDup.reason,
          sessionState,
          dayPass,
          requiredSteps: getRequiredSteps(deptDup.reason),
        });
      }

      // Load division to check gateEntryRequired
      const divisionDoc = await Division.findById(divisionId).select('gateEntryRequired name').lean();
      let gateEntryOptional = divisionDoc ? divisionDoc.gateEntryRequired === false : false;

      const isContractorGateOptional = await isRegistrationGateOptionalByPayCategory(
        matchedRegistration._id,
        matchedRegistration.roleId
      );
      if (isContractorGateOptional) {
        gateEntryOptional = true;
      }

      const deptCheck = await validateDepartmentScan(
        activePass,
        department,
        resolvedDeptEventType,
        matchedRegistration._id,
        divisionId,
        {
          gateEntryOptional,
          isContractorGateOptional,
        }
      );
      if (!deptCheck.ok) {
        const denialDayPass = deptCheck.pass
          ? await formatPassResponse(deptCheck.pass)
          : dayPass;
        return respondScanDenial(res, {
            scanType: effectiveScanType,
            matchScore,
            registration: populated,
            log,
            error: deptCheck.error,
            reason: deptCheck.reason,
            hasGateEntry: deptCheck.hasGateEntry,
            activeDepartment: deptCheck.activeDepartment,
            activeDivision: deptCheck.activeDivision,
            sessionState: deptCheck.sessionState || sessionState,
            dayPass: denialDayPass,
            requiredSteps: deptCheck.requiredSteps,
            checkoutWaitRemainingMs: deptCheck.checkoutWaitRemainingMs,
          });
      }

      // ── Optional gate entry ─────────────────────────────────────────────
      // deptCheck.needsAutoGateEntry is set when the division or pay category allows
      // optional gate entry and the person has no gate entry today.
      let autoGateLog = null;
      if (deptCheck.needsAutoGateEntry) {
        if (!autoCreateGateEntry) {
          // First pass: tell the UI to show the confirmation popup with clear contractor notification.
          await markGateLogDenied(log, 'no_gate_entry_optional_pending', 'Awaiting operator confirmation for auto gate entry');
          return res.status(202).json({
            needsAutoGateEntry: true,
            isContractorGateOptional: Boolean(deptCheck.isContractorGateOptional),
            contractorNotice: deptCheck.isContractorGateOptional
              ? 'This contractor has no gate entries, so we are directly marking the department entry for the contractor.'
              : null,
            divisionName: divisionDoc?.name || '',
            borrowedGateEntry: deptCheck.borrowedGateEntry,
            registration: populated,
            matchScore,
            qrScan: true,
          });
        }
        // Second pass: synthesise the gate-entry log.
        autoGateLog = await createAutoGateEntryLog({
          registrationId: matchedRegistration._id,
          roleId: matchedRegistration.roleId,
          divisionId,
          matchScore,
          photoPath: log.photoPath || null,
          borrowedGateEntry: deptCheck.borrowedGateEntry,
          operator: operatorFields(req.user),
          deptLogId: log._id,
          deptLogCreatedAt: log.createdAt,
          isContractorGateOptional: Boolean(deptCheck.isContractorGateOptional),
        });
        // Refresh the active pass so updateDayPassAfterDepartmentScan uses
        // the newly created gate entry context.
        const { registration, role, display } = await loadRegistrationContext(matchedRegistration._id);
        await createOrRefreshDayPass({
          registration,
          role,
          display,
          gateLogId: autoGateLog._id,
          divisionId,
          divisionName: divisionDoc?.name || '',
        });
        activePass = await getActiveDayPass(matchedRegistration._id, divisionId);
      }

      if (!activePass && deptCheck.hasGateEntry) {
        const { registration, role, display } = await loadRegistrationContext(matchedRegistration._id);
        const todayGateEntry = await GateLog.findOne(grantedGateLogFilter({
          registrationId: matchedRegistration._id,
          eventType: GATE_EVENT_TYPES.ENTRY,
          divisionId,
        })).sort({ createdAt: -1 });

        await createOrRefreshDayPass({
          registration,
          role,
          display,
          gateLogId: todayGateEntry?._id || log._id,
          divisionId,
          divisionName: divisionDoc?.name || '',
        });
        activePass = await getActiveDayPass(matchedRegistration._id, divisionId);
      }

      if (!activePass) {
        await markGateLogDenied(log, 'system_error', 'Failed to initialize active day pass for department check-in');
        return res.status(500).json({ error: 'System error: Could not initialize active day pass.' });
      }

      dayPass = await updateDayPassAfterDepartmentScan(
        activePass,
        department,
        resolvedDeptEventType,
        log.createdAt
      );
      resolvedEventType = resolvedDeptEventType;
    }

    const hasGateEntry = await madeGateEntryToday(matchedRegistration._id, divisionId);
    await finalizeGateLog(log);

    if (effectiveScanType === SCAN_TYPES.DEPARTMENT) {
      const updatedPass = await getActiveDayPass(matchedRegistration._id, divisionId);
      sessionState = await syncDepartmentVisitsFromLogs(
        updatedPass,
        matchedRegistration._id,
        divisionId
      );
      if (updatedPass) {
        dayPass = await formatPassResponse(updatedPass);
      }
    }

    const todayLogs = await getTodayLogsForRegistration(
      matchedRegistration._id,
      divisionId,
      activePass || dayPass
    );

    res.json({
      matched: true,
      denied: false,
      scanType: effectiveScanType,
      matchScore,
      registration: populated,
      log,
      dayPass,
      sessionState,
      hasGateEntry,
      todayLogs,
      activeDepartment: sessionState?.currentDepartmentId
        ? {
            departmentId: sessionState.currentDepartmentId,
            departmentName: sessionState.currentDepartmentName,
          }
        : null,
      resolvedEventType,
      autoResolved: isAutoEvent,
      qrScan: true,
      forcedDepartmentCheckout,
      autoGateLog: autoGateLog ? { _id: autoGateLog._id, createdAt: autoGateLog.createdAt } : null,
    });
    });
  })
);

router.get(
  '/session/:registrationId',
  asyncHandler(async (req, res) => {
    const { divisionId } = req.query;
    if (!divisionId) return res.status(400).json({ error: 'divisionId is required' });

    const pass = await getActiveDayPass(req.params.registrationId, divisionId);
    const sessionState = getPassSessionState(pass);
    const todayLogs = await getTodayLogsForRegistration(req.params.registrationId, divisionId, pass);

    res.json({
      hasDayPass: Boolean(pass),
      sessionState,
      todayLogs,
    });
  })
);

router.post(
  '/scan',
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const {
      registrationId,
      eventType,
      gateId,
      departmentId,
      divisionId: bodyDivisionId,
      scanType = SCAN_TYPES.GATE,
      forceDepartmentCheckout: forceCheckoutRaw,
      autoCreateGateEntry: autoCreateGateEntryRaw,
    } = req.body;
    const forceDepartmentCheckout = parseForceDepartmentCheckout(forceCheckoutRaw);
    const autoCreateGateEntry = autoCreateGateEntryRaw === true || autoCreateGateEntryRaw === 'true';

    if (!req.file) return res.status(400).json({ error: 'Photo is required' });
    const isAutoEvent = eventType === GATE_EVENT_TYPES.AUTO;
    if (
      !isAutoEvent &&
      !Object.values(GATE_EVENT_TYPES).includes(eventType)
    ) {
      return res.status(400).json({ error: 'eventType must be "entry", "exit", or "auto"' });
    }
    if (!Object.values(SCAN_TYPES).includes(scanType)) {
      return res.status(400).json({ error: 'scanType must be "gate" or "department"' });
    }

    const logFields = { scanType, eventType };
    let divisionId = bodyDivisionId || null;
    let gateRecord = null;
    let department = null;

    if (scanType === SCAN_TYPES.GATE) {
      if (!gateId) return res.status(400).json({ error: 'gateId is required for gate scans' });
      if (departmentId) {
        return res.status(400).json({ error: 'Department is not used for division gate scans' });
      }

      gateRecord = await Gate.findById(gateId).populate('divisionId', 'name slug isActive');
      if (!gateRecord) return res.status(404).json({ error: 'Gate not found' });
      if (!gateRecord.isActive) return res.status(400).json({ error: 'Gate is inactive' });
      if (gateRecord.divisionId && !gateRecord.divisionId.isActive) {
        return res.status(400).json({ error: 'Division is inactive' });
      }
      if (gateRecord.gateType === GATE_TYPES.ENTRY && !isAutoEvent && eventType !== GATE_EVENT_TYPES.ENTRY) {
        return res.status(400).json({ error: 'This gate allows entry scans only' });
      }
      if (gateRecord.gateType === GATE_TYPES.EXIT && !isAutoEvent && eventType !== GATE_EVENT_TYPES.EXIT) {
        return res.status(400).json({ error: 'This gate allows exit scans only' });
      }
      if (isAutoEvent && gateRecord.gateType !== GATE_TYPES.BOTH) {
        return res.status(400).json({ error: 'Auto entry/exit is only available at combined entry & exit gates' });
      }

      divisionId = gateRecord.divisionId?._id || gateRecord.divisionId;
      logFields.gateRefId = gateRecord._id;
      logFields.divisionId = divisionId;
      logFields.gateId = gateRecord._id.toString();
    } else {
      if (!bodyDivisionId) {
        return res.status(400).json({ error: 'divisionId is required for department scans' });
      }
      if (!departmentId) {
        return res.status(400).json({ error: 'departmentId is required for department scans' });
      }
      if (gateId) return res.status(400).json({ error: 'Gate is not used for department scans' });

      department = await Department.findById(departmentId);
      if (!department) return res.status(404).json({ error: 'Department not found' });
      if (!department.isActive) return res.status(400).json({ error: 'Department is inactive' });

      const departmentDivisionIds = (department.divisionIds || []).map((id) => id.toString());
      if (!departmentDivisionIds.includes(bodyDivisionId.toString())) {
        return res.status(400).json({ error: 'Department does not belong to the selected division' });
      }

      divisionId = bodyDivisionId;
      logFields.divisionId = divisionId;
      logFields.departmentId = department._id;
      logFields.gateId = 'department';
    }

    if (req.user && !req.user.isSuperAdmin) {
      if (!hasDivisionScope(req.user, divisionId)) {
        return res.status(403).json({ error: 'You do not have access to this division' });
      }
      if (scanType === SCAN_TYPES.GATE && !hasGateScope(req.user, gateRecord._id)) {
        return res.status(403).json({ error: 'You do not have access to this gate' });
      }
      if (
        scanType === SCAN_TYPES.GATE &&
        !hasGateEventScope(req.user, gateRecord._id, eventType, gateRecord.gateType)
      ) {
        return res.status(403).json({
          error: 'You do not have access to this gate mode (entry/exit)',
        });
      }
      if (scanType === SCAN_TYPES.DEPARTMENT && !hasDepartmentScope(req.user, department._id)) {
        return res.status(403).json({ error: 'You do not have access to this department' });
      }
      if (
        scanType === SCAN_TYPES.DEPARTMENT &&
        !hasDepartmentEventScope(req.user, department._id, eventType)
      ) {
        return res.status(403).json({ error: 'You do not have permission for this department event type' });
      }
    }

    const identify = await identifyFromPhoto(req.file, registrationId || null);
    if (identify.error) {
      return res.status(identify.status || 400).json({ error: identify.error });
    }

    if (identify.ambiguous) {
      return res.json({
        matched: false,
        reason: 'ambiguous',
        scanType,
        matchScore: identify.matchScore,
        message: 'Could not identify this person uniquely. Please register or try again.',
        candidates: identify.candidates,
      });
    }

    const { matchedRegistration, matchScore, matched, autoIdentified, uploadPromise } = identify;

    const log = await GateLog.create({
      registrationId: matchedRegistration?._id || undefined,
      roleId: matchedRegistration?.roleId || undefined,
      matchScore,
      matched,
      accessGranted: false,
      // Store local path immediately; S3 upload updates in background if enabled.
      photoPath: req.file?.path || undefined,
      ...logFields,
      ...operatorFields(req.user),
      metadata: {
        threshold: MATCH_THRESHOLD,
        minMargin: MIN_MATCH_MARGIN,
        autoIdentified,
        scanType,
      },
    });
    attachGatePhotoWhenReady(log._id, uploadPromise);

    if (!matched) {
      const reason = registrationId ? 'face_mismatch' : 'not_found';
      const message = registrationId
        ? 'Face does not match the selected registration'
        : 'Person not found in the database. Please complete registration.';
      await markGateLogDenied(log, reason, message);

      return res.json({
        matched: false,
        reason,
        scanType,
        matchScore,
        message,
        registerUrl: '/registrations/register',
      });
    }

    return withRegistrationScanLock(matchedRegistration._id, async () => {
    const [populated, initialActivePass] = await Promise.all([
      formatRegistrationForScan(matchedRegistration),
      getActiveDayPass(matchedRegistration._id, divisionId),
    ]);
    let activePass = initialActivePass;
    let dayPass = activePass ? await formatPassResponse(activePass) : null;
    let sessionState = getPassSessionState(activePass);

    let resolvedEventType = eventType;
    let personInside = null;
    let forcedDepartmentCheckout = null;
    let autoGateLog = null;

    if (scanType === SCAN_TYPES.GATE) {
      if (gateRecord.gateType === GATE_TYPES.BOTH) {
        personInside = await isPersonInsideTargetDivision(matchedRegistration._id, divisionId);

        if (isAutoEvent) {
          resolvedEventType = await resolveAutoGateEventType(matchedRegistration._id, divisionId);
        } else if (isOppositeGateEvent(personInside, eventType)) {
          const suggestedEventType = personInside
            ? GATE_EVENT_TYPES.EXIT
            : GATE_EVENT_TYPES.ENTRY;
          return respondScanDenial(res, {
              scanType,
              matchScore,
              registration: populated,
              log,
              error: personInside
                ? 'This person is already inside the division. They should exit at this entry & exit gate, not enter again.'
                : 'This person is not checked in at this division. They should enter at this entry & exit gate, not exit.',
              reason: personInside
                ? GATE_DENIAL_REASONS.ALREADY_IN_DIVISION
                : GATE_DENIAL_REASONS.NOT_CHECKED_IN,
              sessionState,
              dayPass,
              activeDivision: personInside
                ? { divisionId: divisionId?.toString(), divisionName: gateRecord?.divisionId?.name || 'Division' }
                : null,
              requiredSteps: getRequiredSteps(
                personInside
                  ? GATE_DENIAL_REASONS.ALREADY_IN_DIVISION
                  : GATE_DENIAL_REASONS.NOT_CHECKED_IN,
                { hasActiveDepartment: Boolean(sessionState?.currentDepartmentId) }
              ),
              securityReview: false,
              requestedEventType: eventType,
              suggestedEventType,
              personInside,
            });
        }
      } else if (isAutoEvent) {
        await markGateLogDenied(log, 'invalid_gate_config', 'Auto entry/exit is only available at combined entry & exit gates');
        return res.status(400).json({ error: 'Auto entry/exit is only available at combined entry & exit gates' });
      }

      const gateDup = await assertNotDuplicateScan({
        registrationId: matchedRegistration._id,
        scanType,
        eventType: resolvedEventType,
        divisionId,
        gateRefId: gateRecord?._id,
        excludeLogId: log._id,
      });
      if (!gateDup.ok) {
        return respondScanDenial(res, {
          scanType,
          matchScore,
          registration: populated,
          log,
          error: gateDup.error,
          reason: gateDup.reason,
          sessionState,
          dayPass,
          requiredSteps: getRequiredSteps(gateDup.reason),
        });
      }

      ({ activePass, forcedDepartmentCheckout } = await applyForceDepartmentCheckoutIfRequested({
        forceDepartmentCheckout,
        resolvedEventType,
        activePass,
        registrationId: matchedRegistration._id,
        divisionId,
        matchScore,
        operator: operatorFields(req.user),
        sourceLogId: log._id,
        photoPath: req.file?.path || log.photoPath || null,
      }));
      if (forcedDepartmentCheckout) {
        if (uploadPromise && forcedDepartmentCheckout.departmentLogId) {
          attachGatePhotoWhenReady(forcedDepartmentCheckout.departmentLogId, uploadPromise);
        }
        sessionState = getPassSessionState(activePass);
        dayPass = activePass ? await formatPassResponse(activePass) : dayPass;
        log.metadata = {
          ...(log.metadata || {}),
          forceDepartmentCheckout: true,
          forcedDepartmentId: forcedDepartmentCheckout.departmentId,
          forcedDepartmentName: forcedDepartmentCheckout.departmentName,
          forcedDepartmentLogId: forcedDepartmentCheckout.departmentLogId
            ? String(forcedDepartmentCheckout.departmentLogId)
            : null,
        };
        log.markModified('metadata');
        await log.save();
      }

      const gateCheck = await validateGateScan(
        activePass,
        resolvedEventType,
        matchedRegistration._id,
        divisionId
      );
      if (!gateCheck.ok) {
        const denialDayPass = gateCheck.pass
          ? await formatPassResponse(gateCheck.pass)
          : dayPass;
        return respondScanDenial(res, {
            scanType,
            matchScore,
            registration: populated,
            log,
            error: gateCheck.error,
            reason: gateCheck.reason,
            sessionState: gateCheck.sessionState || sessionState,
            dayPass: denialDayPass,
            activeDepartment: gateCheck.activeDepartment,
            activeDivision: gateCheck.activeDivision,
            requiredSteps: gateCheck.requiredSteps,
            checkoutWaitRemainingMs: gateCheck.checkoutWaitRemainingMs,
          });
      }

      if (resolvedEventType === GATE_EVENT_TYPES.ENTRY) {
        const { registration, role, display } = await loadRegistrationContext(matchedRegistration._id);
        dayPass = await createOrRefreshDayPass({
          registration,
          role,
          display,
          gateLogId: log._id,
          divisionId,
          divisionName: gateRecord?.divisionId?.name || '',
        });
        sessionState = getPassSessionState(await getActiveDayPass(matchedRegistration._id, divisionId));
      } else {
        // EXIT — fetch the pass fresh by registrationId + divisionId in case
        // the face-index lookup returned a slightly stale matchedRegistration.
        // Falling back to a direct DB query ensures the pass is always closed
        // even when activePass was null from the earlier getActiveDayPass call.
        const passToClose = activePass || await Pass.findOne({
          registrationId: matchedRegistration._id,
          divisionId,
          passType: PASS_TYPES.DAY_PASS,
          isActive: true,
          'qrPayload.divisionInside': true,
        }).sort({ createdAt: -1 });

        if (passToClose) {
          dayPass = await updateDayPassAfterGateExit(passToClose);
        }
        sessionState = getPassSessionState(await getActiveDayPass(matchedRegistration._id, divisionId));
      }

      if (resolvedEventType !== eventType) {
        log.eventType = resolvedEventType;
        await log.save();
      }
    } else {
      // Department face scan — support auto event type
      let resolvedDeptEventType = eventType;
      let deptAutoResolved = false;

      if (isAutoEvent) {
        resolvedDeptEventType = await resolveAutoDepartmentEventType(
          matchedRegistration._id, divisionId, department._id
        );
        deptAutoResolved = true;
        log.eventType = resolvedDeptEventType;
        await log.save();
      }

      const deptDup = await assertNotDuplicateScan({
        registrationId: matchedRegistration._id,
        scanType,
        eventType: resolvedDeptEventType,
        divisionId,
        departmentId: department._id,
        excludeLogId: log._id,
      });
      if (!deptDup.ok) {
        return respondScanDenial(res, {
          scanType,
          matchScore,
          registration: populated,
          log,
          error: deptDup.error,
          reason: deptDup.reason,
          sessionState,
          dayPass,
          requiredSteps: getRequiredSteps(deptDup.reason),
        });
      }

      // Load division to check gateEntryRequired
      const divisionDoc = await Division.findById(divisionId).select('gateEntryRequired name').lean();
      let gateEntryOptional = divisionDoc ? divisionDoc.gateEntryRequired === false : false;

      const isContractorGateOptional = await isRegistrationGateOptionalByPayCategory(
        matchedRegistration._id,
        matchedRegistration.roleId
      );
      if (isContractorGateOptional) {
        gateEntryOptional = true;
      }

      const deptCheck = await validateDepartmentScan(
        activePass,
        department,
        resolvedDeptEventType,
        matchedRegistration._id,
        divisionId,
        {
          gateEntryOptional,
          isContractorGateOptional,
        }
      );
      if (!deptCheck.ok) {
        const denialDayPass = deptCheck.pass
          ? await formatPassResponse(deptCheck.pass)
          : dayPass;
        return respondScanDenial(res, {
            scanType,
            matchScore,
            registration: populated,
            log,
            error: deptCheck.error,
            reason: deptCheck.reason,
            hasGateEntry: deptCheck.hasGateEntry,
            activeDepartment: deptCheck.activeDepartment,
            activeDivision: deptCheck.activeDivision,
            sessionState: deptCheck.sessionState || sessionState,
            dayPass: denialDayPass,
            requiredSteps: deptCheck.requiredSteps,
            checkoutWaitRemainingMs: deptCheck.checkoutWaitRemainingMs,
          });
      }

      // ── Optional gate entry ─────────────────────────────────────────────
      if (deptCheck.needsAutoGateEntry) {
        if (!autoCreateGateEntry) {
          // First pass: tell the UI to show the confirmation popup with clear contractor notification.
          await markGateLogDenied(log, 'no_gate_entry_optional_pending', 'Awaiting operator confirmation for auto gate entry');
          return res.status(202).json({
            needsAutoGateEntry: true,
            isContractorGateOptional: Boolean(deptCheck.isContractorGateOptional),
            contractorNotice: deptCheck.isContractorGateOptional
              ? 'This contractor has no gate entries, so we are directly marking the department entry for the contractor.'
              : null,
            divisionName: divisionDoc?.name || '',
            borrowedGateEntry: deptCheck.borrowedGateEntry,
            registration: populated,
            matchScore,
          });
        }
        // Second pass: synthesise the gate-entry log.
        autoGateLog = await createAutoGateEntryLog({
          registrationId: matchedRegistration._id,
          roleId: matchedRegistration.roleId,
          divisionId,
          matchScore,
          photoPath: log.photoPath || null,
          borrowedGateEntry: deptCheck.borrowedGateEntry,
          operator: operatorFields(req.user),
          deptLogId: log._id,
          deptLogCreatedAt: log.createdAt,
          isContractorGateOptional: Boolean(deptCheck.isContractorGateOptional),
        });
        const { registration, role, display } = await loadRegistrationContext(matchedRegistration._id);
        await createOrRefreshDayPass({
          registration,
          role,
          display,
          gateLogId: autoGateLog._id,
          divisionId,
          divisionName: divisionDoc?.name || '',
        });
        activePass = await getActiveDayPass(matchedRegistration._id, divisionId);
      }

      if (!activePass && deptCheck.hasGateEntry) {
        const { registration, role, display } = await loadRegistrationContext(matchedRegistration._id);
        const todayGateEntry = await GateLog.findOne(grantedGateLogFilter({
          registrationId: matchedRegistration._id,
          eventType: GATE_EVENT_TYPES.ENTRY,
          divisionId,
        })).sort({ createdAt: -1 });

        await createOrRefreshDayPass({
          registration,
          role,
          display,
          gateLogId: todayGateEntry?._id || log._id,
          divisionId,
          divisionName: divisionDoc?.name || '',
        });
        activePass = await getActiveDayPass(matchedRegistration._id, divisionId);
      }

      if (!activePass) {
        await markGateLogDenied(log, 'system_error', 'Failed to initialize active day pass for department check-in');
        return res.status(500).json({ error: 'System error: Could not initialize active day pass.' });
      }

      dayPass = await updateDayPassAfterDepartmentScan(
        activePass,
        department,
        resolvedDeptEventType,
        log.createdAt
      );
      resolvedEventType = resolvedDeptEventType;
      personInside = deptAutoResolved;
    }

    const hasGateEntry = await madeGateEntryToday(matchedRegistration._id, divisionId);
    await finalizeGateLog(log);

    if (scanType === SCAN_TYPES.DEPARTMENT) {
      const updatedPass = await getActiveDayPass(matchedRegistration._id, divisionId);
      sessionState = await syncDepartmentVisitsFromLogs(
        updatedPass,
        matchedRegistration._id,
        divisionId
      );
      if (updatedPass) {
        dayPass = await formatPassResponse(updatedPass);
      }
    }

    const photoUrl = photoUrlFromPath(req.file?.path || log.photoPath) || null;

    const todayLogs = await getTodayLogsForRegistration(
      matchedRegistration._id,
      divisionId,
      activePass || dayPass
    );

    res.json({
      matched: true,
      denied: false,
      scanType,
      matchScore,
      registration: populated,
      log,
      dayPass,
      sessionState,
      hasGateEntry,
      todayLogs,
      activeDepartment: sessionState?.currentDepartmentId
        ? {
            departmentId: sessionState.currentDepartmentId,
            departmentName: sessionState.currentDepartmentName,
          }
        : null,
      photoUrl,
      resolvedEventType,
      autoResolved: isAutoEvent,
      forcedDepartmentCheckout,
      autoGateLog: autoGateLog ? { _id: autoGateLog._id, createdAt: autoGateLog.createdAt } : null,
    });
    });
  })
);

// ─── Activity monitor: multi-face recognition ────────────────────────────────
// Resolve shift from an open gate session (day pass), falling back to the most
// recent gate-entry log that still carries shift metadata (overnight coverage).
async function resolveActivityShift(registrationId, sessionState = null) {
  if (sessionState?.shiftId) {
    return {
      shiftId: String(sessionState.shiftId),
      shiftName: sessionState.shiftName || '',
      totalHours: sessionState.totalHours ?? null,
      shiftStartTime: sessionState.shiftStartTime || '',
      shiftEndTime: sessionState.shiftEndTime || '',
      assignedAt: sessionState.gateEntryAt || null,
    };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const log = await GateLog.findOne({
    registrationId,
    'metadata.shiftId': { $exists: true, $ne: null },
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .select('metadata createdAt')
    .lean();

  if (!log?.metadata?.shiftId) return null;
  return {
    shiftId: String(log.metadata.shiftId),
    shiftName: log.metadata.shiftName || '',
    totalHours: log.metadata.totalHours ?? null,
    shiftStartTime: log.metadata.shiftStartTime || '',
    shiftEndTime: log.metadata.shiftEndTime || '',
    assignedAt: log.createdAt,
  };
}

async function resolveActivityFaceImage(imageBuffer, faceBox, thumbnailB64) {
  // Prefer AI-provided thumbnail bytes; otherwise crop from the full frame.
  if (thumbnailB64) {
    try {
      const buf = Buffer.from(thumbnailB64, 'base64');
      if (buf.length) {
        const saved = await persistActivityFaceBuffer(
          buf,
          `activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        );
        if (saved) {
          return {
            photoPath: saved.photoPath,
            faceCropDataUrl: saved.dataUrl || `data:image/jpeg;base64,${thumbnailB64}`,
          };
        }
      }
    } catch (err) {
      console.warn('Failed to persist AI activity thumbnail:', err.message);
    }
  }

  const cropped = await cropAndSaveActivityFace(imageBuffer, faceBox);
  if (!cropped) return { photoPath: null, faceCropDataUrl: null };
  return {
    photoPath: cropped.photoPath,
    faceCropDataUrl: cropped.dataUrl,
  };
}

router.post(
  '/activity-scan',
  requireAnyPermission(['activity', 'jattu_activity'], 'read'),
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });

    const filePath = req.file.path || null;
    const imageBuffer = req.file.buffer || fs.readFileSync(filePath);
    const filename = req.file.filename || req.file.originalname || 'activity.jpg';

    let facesResult;
    try {
      facesResult = await extractFaceEmbeddingsMulti(imageBuffer, filename, 'image/jpeg');
    } finally {
      // Full frame is not kept — only per-face crops are persisted for the record.
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    const faces = normalizeEmbedMultiFaces(facesResult);
    if (!faces.length) {
      return res.json({
        facesDetected: 0,
        matchedCount: 0,
        unmatchedCount: 0,
        inActivityCount: 0,
        people: [],
        unmatchedFaces: [],
      });
    }

    const bestByRegistration = new Map();
    const unmatchedFaces = [];
    const sightingDate = todayDateString();

    for (const face of faces) {
      const thumbnailB64 = face?.thumbnail_jpeg_b64 || null;

      if (!face?.embedding?.length) {
        unmatchedFaces.push({
          faceBox: face?.face_box || null,
          thumbnailB64,
        });
        continue;
      }

      const searchResult = await searchFaceEmbeddings(face.embedding, {
        topK: SEARCH_TOP_K,
        threshold: MATCH_THRESHOLD,
        minMargin: MIN_MATCH_MARGIN,
      });
      const best = searchResult?.best;
      if (!best?.id || best.similarity < MATCH_THRESHOLD || searchResult.ambiguous) {
        unmatchedFaces.push({
          faceBox: face.face_box || null,
          thumbnailB64,
        });
        continue;
      }

      const existing = bestByRegistration.get(best.id);
      if (!existing || best.similarity > existing.similarity) {
        bestByRegistration.set(best.id, {
          similarity: best.similarity,
          faceBox: face.face_box || null,
          thumbnailB64,
        });
      }
    }

    const people = [];
    for (const [regId, info] of bestByRegistration.entries()) {
      const reg = await Registration.findById(regId)
        .select('-faceEmbedding')
        .populate('roleId', 'name slug isShiftBased')
        .populate('formId', 'fields')
        .lean();
      if (!reg || reg.status !== REGISTRATION_STATUS.VERIFIED) {
        unmatchedFaces.push({
          faceBox: info.faceBox,
          thumbnailB64: info.thumbnailB64,
        });
        continue;
      }

      const display = buildDisplayInfo(reg.formData, reg.formId?.fields || []);
      const activeSession = await getActiveDivisionSession(regId);
      const inActivity = Boolean(activeSession?.sessionState?.divisionInside);
      const sessionState = activeSession?.sessionState || null;
      const shift = inActivity ? await resolveActivityShift(regId, sessionState) : null;
      const faceImage = await resolveActivityFaceImage(imageBuffer, info.faceBox, info.thumbnailB64);

      // Persist so Today's Activity + person timeline include this sighting
      // even when the person has no gate entry.
      await ActivitySighting.create({
        registrationId: reg._id,
        roleId: reg.roleId?._id || reg.roleId || null,
        matched: true,
        matchScore: info.similarity,
        inActivity,
        photoPath: faceImage.photoPath || '',
        faceBox: info.faceBox,
        sightingDate,
        metadata: {
          divisionId: activeSession?.divisionId || null,
          divisionName: activeSession?.divisionName || null,
        },
      });

      people.push({
        registered: true,
        inActivity,
        registrationId: String(regId),
        registrationCode: reg.registrationCode || null,
        displayName: display.displayName || null,
        displayPhone: display.displayPhone || null,
        photoUrl: reg.photoPath ? photoUrlFromPath(reg.photoPath) : null,
        faceCropDataUrl: faceImage.faceCropDataUrl,
        roleName: reg.roleId?.name || null,
        isShiftBased: Boolean(reg.roleId?.isShiftBased),
        matchScore: info.similarity,
        faceBox: info.faceBox,
        divisionId: activeSession?.divisionId || null,
        divisionName: activeSession?.divisionName || null,
        gateEntryAt: sessionState?.gateEntryAt || null,
        shift,
      });
    }

    // Persist unmatched faces for the left-panel gallery (no registration link).
    const unmatchedForClient = [];
    for (let index = 0; index < unmatchedFaces.length; index += 1) {
      const face = unmatchedFaces[index];
      const faceImage = await resolveActivityFaceImage(imageBuffer, face.faceBox, face.thumbnailB64);
      await ActivitySighting.create({
        registrationId: null,
        roleId: null,
        matched: false,
        matchScore: null,
        inActivity: false,
        photoPath: faceImage.photoPath || '',
        faceBox: face.faceBox || null,
        sightingDate,
        metadata: {},
      });

      unmatchedForClient.push({
        key: `unmatched-${index}`,
        faceBox: face.faceBox || null,
        faceCropDataUrl: faceImage.faceCropDataUrl,
        photoUrl: faceImage.photoPath ? photoUrlFromPath(faceImage.photoPath) : null,
      });

      people.push({
        registered: false,
        inActivity: false,
        registrationId: null,
        registrationCode: null,
        displayName: 'Non registered person',
        displayPhone: null,
        photoUrl: faceImage.photoPath ? photoUrlFromPath(faceImage.photoPath) : null,
        faceCropDataUrl: faceImage.faceCropDataUrl,
        roleName: null,
        isShiftBased: false,
        matchScore: null,
        faceBox: face.faceBox || null,
        divisionId: null,
        divisionName: null,
        gateEntryAt: null,
        shift: null,
        unmatchedKey: `unmatched-${index}`,
      });
    }

    people.sort((a, b) => {
      const rank = (p) => {
        if (!p.registered) return 2;
        return p.inActivity ? 0 : 1;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return (b.matchScore || 0) - (a.matchScore || 0);
    });

    const matchedCount = people.filter((p) => p.registered).length;
    const unmatchedCount = people.filter((p) => !p.registered).length;

    res.json({
      facesDetected: people.length,
      matchedCount,
      unmatchedCount,
      inActivityCount: people.filter((p) => p.registered && p.inActivity).length,
      people,
      unmatchedFaces: unmatchedForClient,
    });
  })
);

import { analyzeVehicle } from '../services/aiClient.js';
import VehicleActivityLog from '../models/VehicleActivityLog.js';
import Vehicle from '../models/Vehicle.js';

router.post(
  '/verify-vehicle',
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const { gateId, eventType } = req.body;
    
    if (!req.file) return res.status(400).json({ error: 'Vehicle photo is required' });
    if (!gateId) return res.status(400).json({ error: 'gateId is required' });
    
    // Read image buffer
    const filePath = req.file.path || null;
    const imageBuffer = req.file.buffer || fs.readFileSync(filePath);
    
    // Call AI Server for ANPR
    let aiResult;
    try {
      const imagePayload = { frontPlate: { buffer: imageBuffer, filename: req.file.originalname || 'vehicle.jpg', mimeType: req.file.mimetype } };
      aiResult = await analyzeVehicle(imagePayload);
    } catch (error) {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(500).json({ error: 'Failed to analyze vehicle image' });
    }
    
    // Start upload in parallel
    const uploadPromise = startGatePhotoUpload(imageBuffer, filePath);
    
    const capturedPlate = aiResult.normalizedPlateNumber || aiResult.frontPlateNumber || null;
    const normalizedCapturedPlate = capturedPlate ? capturedPlate.toLowerCase().replace(/\s+/g, '') : null;
    const confidence = aiResult.confidence?.ocr || 0;
    
    let decision = 'Unknown';
    let reason = 'Plate not detected';
    let vehicle = null;
    
    if (normalizedCapturedPlate) {
      vehicle = await Vehicle.findOne({ normalizedPlateNumber: normalizedCapturedPlate }).populate('allowedGates');
      
      if (!vehicle) {
        decision = 'Denied';
        reason = 'Vehicle not registered';
      } else if (vehicle.status !== 'Active') {
        decision = 'Denied';
        reason = `Vehicle is ${vehicle.status}`;
      } else if (vehicle.expiryDate && new Date(vehicle.expiryDate) < new Date()) {
        decision = 'Denied';
        reason = 'Vehicle registration expired';
      } else {
        // Check Gate permissions
        const allowedGateIds = vehicle.allowedGates.map(g => g._id.toString());
        if (allowedGateIds.length > 0 && !allowedGateIds.includes(gateId.toString())) {
          decision = 'Denied';
          reason = 'Vehicle not allowed at this gate';
        } else {
          decision = 'Granted';
          reason = 'Access granted';
        }
      }
    }
    
    const snapshotUrl = await uploadPromise.catch(() => null);
    
    const activityLog = await VehicleActivityLog.create({
      gateId,
      vehicleId: vehicle ? vehicle._id : null,
      ownerId: vehicle ? vehicle.ownerId : null,
      ownerModel: vehicle ? vehicle.ownerModel : null,
      departmentId: vehicle ? vehicle.departmentId : null,
      capturedPlate,
      normalizedCapturedPlate,
      confidence,
      snapshotUrl,
      decision,
      reason,
      metadata: aiResult
    });
    
    res.json({
      decision,
      reason,
      capturedPlate,
      vehicle: vehicle ? { _id: vehicle._id, typeId: vehicle.typeId, categoryId: vehicle.categoryId } : null,
      logId: activityLog._id
    });
  })
);

// GET /api/gate/settings/public
router.get(
  '/settings/public',
  asyncHandler(async (req, res) => {
    let settings = await SystemSetting.findOne({ singleton: 'singleton' });
    if (!settings) {
      settings = await SystemSetting.create({ singleton: 'singleton' });
    }
    const eyeBlinkVerificationEnabled = settings.gateSettings?.eyeBlinkVerificationEnabled ?? true;
    const labourPayCategoryGateEntryOptional = settings.gateSettings?.labourPayCategoryGateEntryOptional ?? false;
    const hrmsEmployeeCreationEnabled = settings.gateSettings?.hrmsEmployeeCreationEnabled ?? true;
    const optionalGatePayCategories = settings.gateSettings?.optionalGatePayCategories || ['contract', 'contractor', 'contractors', 'contracters', 'contracter'];
    res.json({ eyeBlinkVerificationEnabled, labourPayCategoryGateEntryOptional, hrmsEmployeeCreationEnabled, optionalGatePayCategories });
  })
);

// GET /api/gate/settings
router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    let settings = await SystemSetting.findOne({ singleton: 'singleton' });
    if (!settings) {
      settings = await SystemSetting.create({ singleton: 'singleton' });
    }
    if (!settings.gateSettings) {
      settings.gateSettings = {
        eyeBlinkVerificationEnabled: true,
        labourPayCategoryGateEntryOptional: false,
        hrmsEmployeeCreationEnabled: true,
        optionalGatePayCategories: ['contract', 'contractor', 'contractors', 'contracters', 'contracter'],
      };
      await settings.save();
    }
    res.json(settings.gateSettings);
  })
);

// PUT /api/gate/settings
router.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const { eyeBlinkVerificationEnabled, labourPayCategoryGateEntryOptional, hrmsEmployeeCreationEnabled, optionalGatePayCategories } = req.body;
    let settings = await SystemSetting.findOne({ singleton: 'singleton' });
    if (!settings) settings = new SystemSetting({ singleton: 'singleton' });

    settings.gateSettings = {
      ...(settings.gateSettings || {}),
      eyeBlinkVerificationEnabled: eyeBlinkVerificationEnabled !== undefined ? Boolean(eyeBlinkVerificationEnabled) : (settings.gateSettings?.eyeBlinkVerificationEnabled ?? true),
      labourPayCategoryGateEntryOptional: labourPayCategoryGateEntryOptional !== undefined ? Boolean(labourPayCategoryGateEntryOptional) : (settings.gateSettings?.labourPayCategoryGateEntryOptional ?? false),
      hrmsEmployeeCreationEnabled: typeof hrmsEmployeeCreationEnabled === 'boolean'
        ? hrmsEmployeeCreationEnabled
        : (settings.gateSettings?.hrmsEmployeeCreationEnabled ?? true),
      optionalGatePayCategories: Array.isArray(optionalGatePayCategories)
        ? optionalGatePayCategories.map(s => String(s).trim().toLowerCase()).filter(Boolean)
        : (settings.gateSettings?.optionalGatePayCategories || ['contract', 'contractor', 'contractors', 'contracters', 'contracter']),
    };
    await settings.save();
    res.json(settings.gateSettings);
  })
);

export default router;
