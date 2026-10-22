const BASE = '/api';
// Hosted backends can sleep; use fast pings + short retries so login feels responsive.
const AUTH_TIMEOUT_MS = 25_000;
const AUTH_MAX_RETRIES = 5;
const AUTH_RETRY_BASE_MS = 350;
const WARMUP_INTERVAL_MS = 350;
const WARMUP_MAX_ATTEMPTS = 12;
const TRANSIENT_STATUSES = new Set([404, 408, 429, 502, 503, 504]);
// Attendance history builds a dense month grid — allow longer, and prefer a
// direct backend hop when configured so Next.js rewrites do not socket-hang.
const REPORT_TIMEOUT_MS = 120_000;
const DIRECT_BACKEND =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_BACKEND_URL
    ? String(process.env.NEXT_PUBLIC_BACKEND_URL).replace(/\/$/, '')
    : '') ||
  (typeof window !== 'undefined' && window.location?.hostname === 'localhost'
    ? 'http://localhost:3001'
    : '');

let backendReady = false;
let warmupPromise = null;

function apiUrl(path) {
  if (DIRECT_BACKEND && path.startsWith('/reports/attendance-history')) {
    return `${DIRECT_BACKEND}/api${path}`;
  }
  return `${BASE}${path}`;
}

function getAuthHeaders(extra = {}) {
  if (typeof window === 'undefined') return extra;
  try {
    const token = localStorage.getItem('smas_token');
    if (!token) return extra;
    return { ...extra, Authorization: `Bearer ${token}` };
  } catch {
    return extra;
  }
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientFailure(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TypeError') return true;
  return TRANSIENT_STATUSES.has(err.status);
}

/** Build query string, omitting undefined / null / empty / literal "undefined". */
function toQuery(params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    const str = String(value);
    if (str === 'undefined' || str === 'null') return;
    qs.set(key, str);
  });
  const query = qs.toString();
  return query ? `?${query}` : '';
}

async function requestOnce(path, options = {}, { timeoutMs = null } = {}) {
  const isFormData = options.body instanceof FormData;
  const timeout = timeoutMs ? withTimeout(timeoutMs) : null;

  try {
    const res = await fetch(apiUrl(path), {
      ...options,
      signal: timeout?.signal ?? options.signal ?? undefined,
      headers: getAuthHeaders(
        isFormData ? {} : { 'Content-Type': 'application/json', ...(options.headers || {}) }
      ),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/login')) {
        const isPublicVerify = path.startsWith('/passes/verify/');
        if (!isPublicVerify) {
          try {
            localStorage.removeItem('smas_token');
            localStorage.removeItem('smas_user');
          } catch {
            // ignore
          }
          try {
            document.cookie = 'smas_token=; path=/; max-age=0';
          } catch {
            // ignore
          }
          if (!window.location.pathname.startsWith('/login')) {
            const afterHours = data?.code === 'AFTER_HOURS_LOGOUT';
            const next = encodeURIComponent(window.location.pathname);
            window.location.href = afterHours
              ? `/login?error=after_hours&next=${next}`
              : `/login?next=${next}`;
          }
        }
      }
      const err = new Error(data.message || data.error || data.detail || `Request failed: ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Request timed out. Please check your connection and try again.');
      timeoutErr.status = 408;
      throw timeoutErr;
    }
    throw err;
  } finally {
    timeout?.clear();
  }
}

async function pingBackend(timeoutMs = 10_000) {
  return requestOnce('/ping', {}, { timeoutMs });
}

async function runWarmup(options = {}) {
  const maxAttempts = options.maxAttempts ?? WARMUP_MAX_ATTEMPTS;
  const intervalMs = options.intervalMs ?? WARMUP_INTERVAL_MS;

  await Promise.allSettled([
    pingBackend().catch(() => {}),
    sleep(150).then(() => pingBackend()).catch(() => {}),
    sleep(400).then(() => pingBackend()).catch(() => {}),
  ]);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await pingBackend();
      backendReady = true;
      return true;
    } catch {
      if (attempt < maxAttempts - 1) {
        await sleep(intervalMs);
      }
    }
  }

  return false;
}

/** Wait until the API responds (or give up after quick retries). */
export async function ensureBackendReady(options = {}) {
  if (backendReady) return true;

  if (!warmupPromise) {
    warmupPromise = runWarmup(options).finally(() => {
      warmupPromise = null;
    });
  }

  await warmupPromise;
  return backendReady;
}

const referenceCache = new Map();
const pendingRequests = new Map();
const CACHE_TTL_MS = 45_000;

const CACHEABLE_PREFIXES = [
  '/reports/divisions',
  '/departments',
  '/shifts',
  '/roles',
  '/divisions',
];

function isCacheable(path, options) {
  const method = (options?.method || 'GET').toUpperCase();
  if (method !== 'GET') return false;
  return CACHEABLE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}?`));
}

export function clearApiCache() {
  referenceCache.clear();
}

async function request(path, options = {}, { timeoutMs = null } = {}) {
  const method = (options?.method || 'GET').toUpperCase();
  const cacheKey = `${method}:${path}`;

  if (method !== 'GET') {
    referenceCache.clear();
  }

  if (method === 'GET' && isCacheable(path, options)) {
    const cached = referenceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  if (method === 'GET' && pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  const execute = async () => {
    const isAuthPath = path.startsWith('/auth/') || path === '/health' || path === '/ping';
    let data;
    if (!isAuthPath) {
      data = await requestOnce(path, options, { timeoutMs });
    } else {
      let lastErr;
      for (let attempt = 0; attempt < AUTH_MAX_RETRIES; attempt += 1) {
        try {
          data = await requestOnce(path, options, { timeoutMs: timeoutMs || AUTH_TIMEOUT_MS });
          backendReady = true;
          break;
        } catch (err) {
          lastErr = err;
          const canRetry = attempt < AUTH_MAX_RETRIES - 1 && isTransientFailure(err);
          if (!canRetry) break;
          await sleep(AUTH_RETRY_BASE_MS * (attempt + 1));
        }
      }
      if (!data && lastErr) throw lastErr;
    }

    if (method === 'GET' && isCacheable(path, options)) {
      referenceCache.set(cacheKey, { data, timestamp: Date.now() });
    }
    return data;
  };

  if (method === 'GET') {
    const promise = execute().finally(() => {
      pendingRequests.delete(cacheKey);
    });
    pendingRequests.set(cacheKey, promise);
    return promise;
  }

  return execute();
}

/** Start waking a sleeping hosted backend as soon as the login page loads. */
export function warmBackend() {
  if (typeof window === 'undefined' || backendReady) return;
  return ensureBackendReady();
}

export const api = {
  health: () => request('/health'),
  dashboard: {
    stats: (params = {}) => request(`/dashboard${toQuery(params)}`),
  },

  equipment: {
    dashboard: () => request('/equipment/idle-monitoring/dashboard'),
    reports: () => request('/equipment/idle-monitoring/reports'),
    settings: () => request('/equipment/idle-monitoring/settings'),
    updateSettings: (data) => request('/equipment/idle-monitoring/settings', { method: 'PUT', body: JSON.stringify(data) })
  },

  auth: {
    precheck: (username) =>
      request('/auth/precheck', { method: 'POST', body: JSON.stringify({ username }) }),
    login: (username, password, fingerprint = null) =>
      request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, ...(fingerprint ? { fingerprint } : {}) }) }),
    verifyLocation: (username, latitude, longitude, accuracy, timestamp, error = null, fingerprint = null) =>
      requestOnce('/auth/verify-location', { method: 'POST', body: JSON.stringify({ username, latitude, longitude, accuracy, timestamp, error, fingerprint }) }),
    verifyPassword: (password) =>
      request('/auth/verify-password', { method: 'POST', body: JSON.stringify({ password }) }),
    changePassword: (password, confirmPassword) =>
      request('/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ password, confirmPassword }),
      }),
    me: () => request('/auth/me'),
    accessScope: () => request('/auth/access-scope'),
  },

  admin: {
    geoLoginAudit: (limit = 100, params = {}) => request(`/geo-login-audit?limit=${limit}${toQuery(params).replace('?', '&')}`),
  },

  geoLocations: {
    list: () => request('/geo-locations'),
  },

  systemRoles: {
    list: () => request('/system-roles'),
    get: (id) => request(`/system-roles/${id}`),
    create: (data) => request('/system-roles', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/system-roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updatePermissions: (id, permissions) =>
      request(`/system-roles/${id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions }),
      }),
    delete: (id) => request(`/system-roles/${id}`, { method: 'DELETE' }),
  },

  systemUsers: {
    list: () => request('/system-users'),
    get: (id) => request(`/system-users/${id}`),
    hrmsEmployees: (params = {}) => request(`/system-users/hrms-employees${toQuery(params)}`),
    create: (data) => request('/system-users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/system-users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => request(`/system-users/${id}`, { method: 'DELETE' }),
  },

  roles: {
    list: () => request('/roles'),
    get: (id) => request(`/roles/${id}`),
    create: (data) => request('/roles', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => request(`/roles/${id}`, { method: 'DELETE' }),
  },

  forms: {
    getByRole: (roleId) => request(`/forms/role/${roleId}`),
    get: (id) => request(`/forms/${id}`),
    getUsedOptions: (id) => request(`/forms/${id}/used-options`),
    migrateOption: (id, data) => request(`/forms/${id}/migrate-option`, { method: 'POST', body: JSON.stringify(data) }),
    create: (data) => request('/forms', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/forms/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  },

  registrations: {
    list: (params = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return;
        qs.set(key, String(value));
      });
      const query = qs.toString();
      return request(`/registrations${query ? `?${query}` : ''}`);
    },
    get: (id) => request(`/registrations/${id}`),
    create: (data) => request('/registrations', { method: 'POST', body: JSON.stringify(data) }),
    updateForm: (id, data) =>
      request(`/registrations/${id}/form`, { method: 'PUT', body: JSON.stringify(data) }),
    uploadPhoto: (id, photoBlob) => {
      const form = new FormData();
      form.append('photo', photoBlob, 'photo.jpg');
      return request(`/registrations/${id}/photo`, { method: 'POST', body: form });
    },
    uploadMedia: (id, fieldId, file) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return request(`/registrations/${id}/media/${fieldId}`, { method: 'POST', body: form });
    },
    checkDuplicate: ({ photoBlob, formData, roleId, excludeId } = {}) => {
      const form = new FormData();
      if (photoBlob) form.append('photo', photoBlob, 'photo.jpg');
      if (formData) form.append('formData', JSON.stringify(formData));
      if (roleId) form.append('roleId', roleId);
      if (excludeId) form.append('excludeId', excludeId);
      return request('/registrations/check-duplicate', { method: 'POST', body: form });
    },
    getDuplicates: (id) => request(`/registrations/${id}/duplicates`),
    verify: (id, data) =>
      request(`/registrations/${id}/verify`, { method: 'POST', body: JSON.stringify(data) }),
    delete: (id) => request(`/registrations/${id}`, { method: 'DELETE' }),
  },

  passes: {
    getRegistrationPass: (registrationId) => request(`/passes/registration/${registrationId}`),
    generateRegistrationPass: (registrationId) =>
      request(`/passes/registration/${registrationId}`, { method: 'POST' }),
    syncAllRegistrationPasses: () =>
      request('/passes/registration/sync-all', { method: 'POST' }),
    getDayPassByGateLog: (gateLogId) => request(`/passes/day/gate-log/${gateLogId}`),
    getTodayDayPass: (registrationId, date = null) => {
      const qs = date ? `?date=${encodeURIComponent(date)}` : '';
      return request(`/passes/day/registration/${registrationId}${qs}`);
    },
    getDayPass: (registrationId, date = null) => {
      const qs = date ? `?date=${encodeURIComponent(date)}` : '';
      return request(`/passes/day/registration/${registrationId}${qs}`);
    },
    verify: (passCode) => request(`/passes/verify/${passCode}`),
    listByRegistration: (registrationId) => request(`/passes/registration/${registrationId}/list`),
  },

  gate: {
    scan: (photoBlob, eventType, options = {}) => {
      const {
        registrationId = null,
        gateId = null,
        departmentId = null,
        divisionId = null,
        scanType = 'gate',
        forceDepartmentCheckout = false,
        autoCreateGateEntry = false,
      } = options;
      const form = new FormData();
      form.append('photo', photoBlob, 'gate-photo.jpg');
      form.append('eventType', eventType);
      form.append('scanType', scanType);
      if (registrationId) form.append('registrationId', registrationId);
      if (gateId) form.append('gateId', gateId);
      if (departmentId) form.append('departmentId', departmentId);
      if (divisionId) form.append('divisionId', divisionId);
      if (forceDepartmentCheckout) form.append('forceDepartmentCheckout', 'true');
      if (autoCreateGateEntry) form.append('autoCreateGateEntry', 'true');
      // Face match + S3 upload can take a bit; fail clearly instead of hanging on Processing.
      return request('/gate/scan', { method: 'POST', body: form }, { timeoutMs: 60_000 });
    },
    qrScan: (passCode, eventType, options = {}) => {
      const {
        gateId = null,
        departmentId = null,
        divisionId = null,
        forceDepartmentCheckout = false,
        autoCreateGateEntry = false,
      } = options;
      return request(
        '/gate/qr-scan',
        {
          method: 'POST',
          body: JSON.stringify({
            passCode,
            eventType,
            gateId,
            departmentId,
            divisionId,
            ...(forceDepartmentCheckout ? { forceDepartmentCheckout: true } : {}),
            ...(autoCreateGateEntry ? { autoCreateGateEntry: true } : {}),
          }),
        },
        { timeoutMs: 60_000 }
      );
    },
    activityScan: (photoBlob) => {
      const form = new FormData();
      form.append('photo', photoBlob, 'activity-photo.jpg');
      return request('/gate/activity-scan', { method: 'POST', body: form });
    },
    logs: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/gate/logs${qs ? `?${qs}` : ''}`);
    },
    status: (registrationId) => request(`/gate/status/${registrationId}`),
    session: (registrationId, divisionId) =>
      request(`/gate/session/${registrationId}?divisionId=${divisionId}`),
    attachShift: (logId, shiftId, shiftName) =>
      request(`/gate/logs/${logId}/shift`, {
        method: 'PATCH',
        body: JSON.stringify({ shiftId, shiftName }),
      }),
    attachRemark: (logId, remark) =>
      request(`/gate/logs/${logId}/remark`, {
        method: 'PATCH',
        body: JSON.stringify({ remark }),
      }),
    settings: () => request('/gate/settings'),
    updateSettings: (data) =>
      request('/gate/settings', { method: 'PUT', body: JSON.stringify(data) }),
    publicSettings: () => requestOnce('/gate/settings/public', {}, { timeoutMs: 15_000 }),
  },

  reports: {
    listRegistrations: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/reports/registrations${qs ? `?${qs}` : ''}`);
    },
    getRegistration: (registrationId, params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/reports/registrations/${registrationId}${qs ? `?${qs}` : ''}`);
    },
    dailyPasses: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/reports/daily-passes${qs ? `?${qs}` : ''}`);
    },
    departmentActivity: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/reports/department-activity${qs ? `?${qs}` : ''}`);
    },
    divisions: () => request('/reports/divisions'),
    attendanceHistory: (params = {}) => {
      const cleanParams = {};
      for (const [key, val] of Object.entries(params)) {
        if (val === undefined || val === null || val === '') continue;
        if (Array.isArray(val)) {
          if (val.length > 0) cleanParams[key] = val.join(',');
        } else {
          cleanParams[key] = val;
        }
      }
      const qs = new URLSearchParams(cleanParams).toString();
      return requestOnce(`/reports/attendance-history${qs ? `?${qs}` : ''}`, {}, { timeoutMs: REPORT_TIMEOUT_MS });
    },
    recalculateAttendanceHistory: (data = {}) =>
      requestOnce('/reports/attendance-history/recalculate', {
        method: 'POST',
        body: JSON.stringify(data),
      }, { timeoutMs: REPORT_TIMEOUT_MS }),
    setAttendanceStatus: (registrationId, data = {}) =>
      request(`/reports/registrations/${registrationId}/attendance-status`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },

  divisions: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/divisions${qs ? `?${qs}` : ''}`);
    },
    get: (id) => request(`/divisions/${id}`),
    create: (data) => request('/divisions', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/divisions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => request(`/divisions/${id}`, { method: 'DELETE' }),
  },

  gates: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/gates${qs ? `?${qs}` : ''}`);
    },
    get: (id) => request(`/gates/${id}`),
    create: (data) => request('/gates', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/gates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => request(`/gates/${id}`, { method: 'DELETE' }),
  },

  departments: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/departments${qs ? `?${qs}` : ''}`);
    },
    get: (id) => request(`/departments/${id}`),
    create: (data) => request('/departments', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/departments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => request(`/departments/${id}`, { method: 'DELETE' }),
  },

  push: {
    publicKey: () => request('/push/public-key'),
    subscribe: (subscription) =>
      request('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) }),
    unsubscribe: (endpoint) =>
      request('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  },

  shifts: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/shifts${qs ? `?${qs}` : ''}`);
    },
    get: (id) => request(`/shifts/${id}`),
    create: (data) => request('/shifts', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/shifts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => request(`/shifts/${id}`, { method: 'DELETE' }),
  },

  projects: {
    list: (params = {}) => request(`/projects${toQuery(params)}`),
    get: (id) => request(`/projects/${id}`),
    create: (data) => request('/projects', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
    archive: (id) => request(`/projects/${id}/archive`, { method: 'POST' }),
    portfolioSummary: () => request('/projects/portfolio-summary'),
    eligibleLabourers: (id, params = {}) =>
      request(`/projects/${id}/eligible-labourers${toQuery(params)}`),
    assignments: (id) => request(`/projects/${id}/assignments`),
    activity: (id) => request(`/projects/${id}/activity`),
    photoDays: (id) => request(`/projects/${id}/photo-days`),
    photos: (id, params = {}) => request(`/projects/${id}/photos${toQuery(params)}`),
    uploadPhotos: (id, files, photoDate) => {
      const form = new FormData();
      const list = Array.isArray(files) ? files : [files];
      list.forEach((file) => {
        if (file) form.append('photos', file);
      });
      if (photoDate) form.append('photoDate', photoDate);
      return request(`/projects/${id}/photos`, { method: 'POST', body: form });
    },
    deletePhoto: (id, photoId) =>
      request(`/projects/${id}/photos/${photoId}`, { method: 'DELETE' }),
    assign: (id, data) =>
      request(`/projects/${id}/assignments`, { method: 'POST', body: JSON.stringify(data) }),
    removeAssignment: (id, labourId) =>
      request(`/projects/${id}/assignments/${labourId}`, { method: 'DELETE' }),
    removeAssignments: (id, data) =>
      request(`/projects/${id}/assignments/remove`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },

  devices: {
    // Public (called before login — no token)
    register:  (data) => requestOnce('/devices/register',  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    validate:  (data) => requestOnce('/devices/validate',  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    // Public settings — used by login page to check deviceMaintenanceEnabled before auth
    publicSettings: () => requestOnce('/devices/settings/public', {}, { timeoutMs: 15_000 }),
    // Protected admin endpoints
    stats:        ()       => request('/devices/stats'),
    list:         (params = {}) => request(`/devices${toQuery(params)}`),
    pending:      (params = {}) => request(`/devices/pending${toQuery(params)}`),
    get:          (id)     => request(`/devices/${id}`),
    approve:      (id)     => request(`/devices/${id}/approve`,  { method: 'PUT' }),
    reject:       (id, note = '') => request(`/devices/${id}/reject`,  { method: 'PUT', body: JSON.stringify({ note }) }),
    block:        (id, note = '') => request(`/devices/${id}/block`,   { method: 'PUT', body: JSON.stringify({ note }) }),
    unblock:      (id)     => request(`/devices/${id}/unblock`, { method: 'PUT' }),
    delete:       (id)     => request(`/devices/${id}`,          { method: 'DELETE' }),
    auditLogs:    (params = {}) => request(`/devices/audit-logs${toQuery(params)}`),
    settings:     ()       => request('/devices/settings'),
    updateSettings: (data) => request('/devices/settings', { method: 'PUT', body: JSON.stringify(data) }),
    syncGeo:        ()       => request('/devices/sync-geo', { method: 'POST' }),
  },

  geoLocations: {
    list: (params = {}) => request(`/geo-locations${toQuery(params)}`),
    get: (id) => request(`/geo-locations/${id}`),
    create: (data) => request('/geo-locations', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/geo-locations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => request(`/geo-locations/${id}`, { method: 'DELETE' }),
    settings: () => request('/geo-locations/settings'),
    updateSettings: (data) => request('/geo-locations/settings', { method: 'PUT', body: JSON.stringify(data) }),
    publicSettings: () => requestOnce('/geo-locations/settings/public', {}, { timeoutMs: 15_000 }),
    assignUserLocations: (userId, locationIds) => 
      request(`/geo-locations/users/${userId}/locations`, { method: 'PUT', body: JSON.stringify({ locationIds }) }),
    verify: (latitude, longitude, isContinuous = false) =>
      request('/geo-locations/verify', { method: 'POST', body: JSON.stringify({ latitude, longitude, isContinuous }) }),
  },

  projectReports: {
    projects: (params = {}) => request(`/project-reports/projects${toQuery(params)}`),
    overview: (params = {}) => request(`/project-reports/overview${toQuery(params)}`),
    attendance: (params = {}) => request(`/project-reports/attendance${toQuery(params)}`),
    history: (params = {}) => request(`/project-reports/history${toQuery(params)}`),
    labourDetail: (labourId, params = {}) =>
      request(`/project-reports/history/${labourId}${toQuery(params)}`),
    labourByAssignment: (assignmentId, params = {}) =>
      request(`/project-reports/labour/${assignmentId}${toQuery(params)}`),
    labourExcel: (assignmentId, params = {}) =>
      request(`/project-reports/labour/${assignmentId}/excel${toQuery(params)}`),
    labourPdf: (assignmentId, params = {}) =>
      request(`/project-reports/labour/${assignmentId}/pdf${toQuery(params)}`),
    faces: (params = {}) => request(`/project-reports/faces${toQuery(params)}`),
    analytics: (params = {}) => request(`/project-reports/analytics${toQuery(params)}`),
    filters: (params = {}) => request(`/project-reports/filters${toQuery(params)}`),
    export: (params = {}) => request(`/project-reports/export${toQuery(params)}`),
  },
  geoLoginAudit: {
    list: (params) => request('/geo-login-audit', { params }),
  },
  vehicles: {
    dashboardStats: () => request('/vehicles/dashboard'),
    summary: () => request('/vehicles/summary'),
    movements: (params = {}) => request(`/vehicles/movements${toQuery(params)}`),
    list: () => request('/vehicles'),
    delete: (id) => request(`/vehicles/${id}`, { method: 'DELETE' }),
    qr: (id) => request(`/vehicles/${id}/qr`),
    settings: () => request('/vehicles/settings'),
    updateSettings: (data) => request('/vehicles/settings', { method: 'PUT', body: JSON.stringify(data) }),
    types: {
      list: () => request('/vehicles/types'),
      create: (data) => request('/vehicles/types', { method: 'POST', body: JSON.stringify(data) }),
      update: (id, data) => request(`/vehicles/types/${id}`, { method: 'PUT', body: JSON.stringify(data) })
    },
    categories: {
      list: () => request('/vehicles/categories')
    },
    registrations: {
      list: (params = {}) => request(`/vehicles/registrations${toQuery(params)}`),
      get: (id) => request(`/vehicles/registrations/${id}`),
      approve: (id, data) => request(`/vehicles/registrations/${id}/approve`, { method: 'POST', body: JSON.stringify(data) }),
      reject: (id, data) => request(`/vehicles/registrations/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),
      delete: (id) => request(`/vehicles/registrations/${id}`, { method: 'DELETE' }),
      qr: (id) => request(`/vehicles/registrations/${id}/qr`),
      updatePhoto: (id, photoKey, file) => {
        const form = new FormData();
        form.append('photo', file);
        return request(`/vehicles/registrations/${id}/photos/${photoKey}`, { method: 'PUT', body: form });
      }
    }
  },
  payroll: {
    getCombinations: () => request('/payroll/rate-master/combinations'),
    listRateMasters: () => request('/payroll/rate-master'),
    getRateMasterView: (id) => request(`/payroll/rate-master/${id}/view`),
    preview: (data) => request('/payroll/rate-master/preview', { method: 'POST', body: JSON.stringify(data) }),
    apply: (id) => request(`/payroll/rate-master/${id}/apply`, { method: 'POST' }),
    create: (data) => request('/payroll/rate-master', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/payroll/rate-master/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    getRateMasterLabourers: () => request('/payroll/rate-master/labourers'),
    generatePaySlips: (data) => request('/payroll/pay-slips/generate', { method: 'POST', body: JSON.stringify(data) }),
    unlockPaySlip: (id) => request(`/payroll/pay-slips/${id}/unlock`, { method: 'POST' }),
    getPaySlipDetails: (id) => request(`/payroll/pay-slips/${id}/details`),
    getPaySlips: (params) => {
      const query = new URLSearchParams();
      if (params?.fromDate) query.append('fromDate', params.fromDate);
      if (params?.toDate) query.append('toDate', params.toDate);
      if (params?.registrationId) query.append('registrationId', params.registrationId);
      return request(`/payroll/pay-slips?${query.toString()}`);
    },
    getAttendanceChangeHistory: (params = {}) => {
      const query = new URLSearchParams();
      if (params?.search) query.append('search', params.search);
      if (params?.dateFrom) query.append('dateFrom', params.dateFrom);
      if (params?.dateTo) query.append('dateTo', params.dateTo);
      if (params?.batch) query.append('batch', params.batch);
      if (params?.limit) query.append('limit', String(params.limit));
      return request(`/payroll/attendance-change-history?${query.toString()}`);
    },
  }
};
