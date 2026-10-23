const TOKEN_KEY = 'smas_token';
const USER_KEY = 'smas_user';
const SSO_FLAG_KEY = 'sams_is_sso';
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60;

export function getToken() {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem('token') || localStorage.getItem('sams_token');
  } catch {
    return null;
  }
}

export function getStoredUser() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(USER_KEY) || localStorage.getItem('user') || localStorage.getItem('sams_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function isSsoSession() {
  if (typeof window === 'undefined') return false;
  try {
    return (
      sessionStorage.getItem(SSO_FLAG_KEY) === 'true' ||
      localStorage.getItem(SSO_FLAG_KEY) === 'true' ||
      localStorage.getItem('isSSO') === 'true'
    );
  } catch {
    return false;
  }
}

export function setSsoFlag(isSso) {
  if (typeof window === 'undefined') return;
  try {
    if (isSso) {
      sessionStorage.setItem(SSO_FLAG_KEY, 'true');
      localStorage.setItem(SSO_FLAG_KEY, 'true');
      localStorage.setItem('isSSO', 'true');
    } else {
      sessionStorage.removeItem(SSO_FLAG_KEY);
      localStorage.removeItem(SSO_FLAG_KEY);
      localStorage.removeItem('isSSO');
    }
  } catch {
    // ignore
  }
}

export function setSession(token, user, isSso = false) {
  if (typeof window !== 'undefined') {
    const serializedUser = JSON.stringify(user);
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, serializedUser);
      // Compatibility keys
      localStorage.setItem('token', token);
      localStorage.setItem('sams_token', token);
      localStorage.setItem('user', serializedUser);
      localStorage.setItem('sams_user', serializedUser);

      if (isSso || user?.isSSO) {
        setSsoFlag(true);
      } else {
        setSsoFlag(false);
      }
    } catch {
      // ignore
    }
    try {
      document.cookie = `smas_token=${encodeURIComponent(token)}; path=/; max-age=${TOKEN_MAX_AGE}; SameSite=Lax`;
    } catch {
      // ignore
    }
  }
}

export function clearSession() {
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem('token');
      localStorage.removeItem('sams_token');
      localStorage.removeItem('user');
      localStorage.removeItem('sams_user');
      setSsoFlag(false);
      sessionStorage.clear();
    } catch {
      // ignore
    }
    try {
      document.cookie = 'smas_token=; path=/; max-age=0';
    } catch {
      // ignore
    }
  }
}

export function hasPermission(user, module, action = 'read') {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  const perms = user.systemRoleId?.permissions;
  if (!perms) return false;
  const modulePerms = perms[module];
  if (!modulePerms) return false;
  if (action === 'read') return Boolean(modulePerms.read || modulePerms.write);
  return Boolean(modulePerms.write);
}
