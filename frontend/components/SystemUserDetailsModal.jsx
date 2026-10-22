'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api/client';
import { PERMISSION_MODULES, emptyPermissions, applyWriteImpliesRead } from '@/lib/auth/permissions';
import { formatDate, formatDateTime } from '@/lib/formatDate';
import PermissionMatrix from '@/components/PermissionMatrix';
import GateAccessPicker, { gateModeBadgeLabel } from '@/components/GateAccessPicker';
import ScopeOverflowCell from '@/components/ScopeOverflowCell';
import DepartmentPicker, { departmentDisplayLabel } from '@/components/DepartmentPicker';
import HrmsEmployeePicker from '@/components/HrmsEmployeePicker';
import {
  filterDepartmentsByDivisions,
  filterGatesByDivisions,
  pruneScopeForDivisions,
} from '@/lib/accessScopeUi';

function normalizePermissions(source) {
  const base = emptyPermissions();
  if (!source) return base;
  for (const { key } of PERMISSION_MODULES) {
    const value = source[key];
    if (value) {
      const write = Boolean(value.write);
      base[key] = { write, read: write || Boolean(value.read) };
    }
  }
  return base;
}

function initialsFromName(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function ScopeBlock({ title, items, badgeClass = 'badge-info', renderBadge }) {
  if (!items.length) return null;
  return (
    <div className="su-scope-block">
      <p className="su-scope-block__title">{title}</p>
      <div className="su-scope-block__pills">
        {items.length > 6 ? (
          <ScopeOverflowCell
            items={items}
            badgeClass={badgeClass}
            renderLabel={renderBadge}
            title={title}
            maxVisible={3}
          />
        ) : (
          items.map((item) => (
            <span key={item._id} className={`badge ${badgeClass}`}>
              {renderBadge ? renderBadge(item) : item.name}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function PermissionSummary({ permissions }) {
  const entries = PERMISSION_MODULES.filter(({ key }) => {
    const v = permissions?.[key];
    return v?.read || v?.write;
  });
  if (entries.length === 0) return null;
  return (
    <ul className="su-permission-list">
      {entries.map(({ key, label }) => {
        const v = permissions[key] || {};
        return (
          <li key={key}>
            <span className="su-permission-list__label">{label}</span>
            <span className="su-permission-list__access">{v.write ? 'Read & write' : 'Read only'}</span>
          </li>
        );
      })}
    </ul>
  );
}

function CheckboxList({ items, selected, onToggle, renderLabel }) {
  if (items.length === 0) return null;
  return (
    <div className="checkbox-group">
      {items.map((item) => (
        <label key={item._id} className="checkbox-option">
          <input
            type="checkbox"
            checked={selected.includes(item._id)}
            onChange={() => onToggle(item._id)}
          />
          <span>{renderLabel ? renderLabel(item) : item.name}</span>
        </label>
      ))}
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export default function SystemUserDetailsModal({ user, canWrite, canEditRole = false, onClose, onSaved }) {
  const [editing, setEditing]       = useState(false);
  const [roles, setRoles]           = useState([]);
  const [divisions, setDivisions]   = useState([]);
  const [gates, setGates]           = useState([]);
  const [departments, setDepartments] = useState([]);

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [selectedHrmsEmployee, setSelectedHrmsEmployee] = useState(null);
  const [hrmsEmployeeCreationEnabled, setHrmsEmployeeCreationEnabled] = useState(false);
  const [systemRoleId, setSystemRoleId] = useState('');
  const [isActive, setIsActive]     = useState(true);
  const [divisionIds, setDivisionIds]   = useState([]);
  const [gateIds, setGateIds]           = useState([]);
  const [gateAccessModes, setGateAccessModes] = useState({});
  const [departmentIds, setDepartmentIds] = useState([]);
  const [departmentAccessModes, setDepartmentAccessModes] = useState({});

  const [rolePerms, setRolePerms]   = useState(emptyPermissions());
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');

  const editable         = canWrite && !user?.isSuperAdmin;
  const roleId           = user?.systemRoleId?._id || null;
  const canEditPrivileges = canEditRole && !user?.isSuperAdmin && Boolean(roleId);

  useEffect(() => {
    if (!user) return;
    setEditing(false);
    setPassword('');
    setSelectedHrmsEmployee(null);
    setError('');
    setSuccess('');
    setDisplayName(user.displayName || '');
    setEmail(user.email || '');
    setSystemRoleId(user.systemRoleId?._id || '');
    setIsActive(Boolean(user.isActive));
    setDivisionIds((user.divisionIds || []).map((d) => d._id));
    setGateIds((user.gateIds || []).map((g) => g._id));
    setGateAccessModes(user.gateAccessModes || {});
    setDepartmentIds((user.departmentIds || []).map((d) => d._id));
    setDepartmentAccessModes(user.departmentAccessModes || {});
    setRolePerms(normalizePermissions(user.systemRoleId?.permissions));
  }, [user]);

  useEffect(() => {
    if (!editing) return;
    Promise.all([
      api.systemRoles.list(),
      api.divisions.list({ isActive: 'true' }),
      api.gates.list({ isActive: 'true' }),
      api.departments.list(),
      api.gate.settings(),
    ])
      .then(([r, d, g, dep, gateSettings]) => {
        setRoles(r.filter((x) => x.isActive));
        setDivisions(d);
        setGates(g);
        setDepartments(dep);
        setHrmsEmployeeCreationEnabled(gateSettings.hrmsEmployeeCreationEnabled ?? true);
      })
      .catch((e) => setError(e.message));
  }, [editing]);

  const scopedGates = useMemo(
    () => filterGatesByDivisions(gates, divisionIds),
    [gates, divisionIds]
  );

  const scopedDepartments = useMemo(
    () => filterDepartmentsByDivisions(departments, divisionIds),
    [departments, divisionIds]
  );

  if (!user) return null;

  function toggleDivision(id) {
    setDivisionIds((prev) => {
      const next = prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id];
      const pruned = pruneScopeForDivisions({
        gates,
        departments,
        divisionIds: next,
        gateIds,
        gateAccessModes,
        departmentIds,
        departmentAccessModes,
      });
      setGateIds(pruned.gateIds);
      setGateAccessModes(pruned.gateAccessModes);
      setDepartmentIds(pruned.departmentIds);
      setDepartmentAccessModes(pruned.departmentAccessModes);
      return next;
    });
  }

  function handleCancel() {
    setEditing(false);
    setError('');
    setSuccess('');
    setPassword('');
    setSelectedHrmsEmployee(null);
    setDisplayName(user.displayName || '');
    setEmail(user.email || '');
    setSystemRoleId(user.systemRoleId?._id || '');
    setIsActive(Boolean(user.isActive));
    setDivisionIds((user.divisionIds || []).map((d) => d._id));
    setGateIds((user.gateIds || []).map((g) => g._id));
    setGateAccessModes(user.gateAccessModes || {});
    setDepartmentIds((user.departmentIds || []).map((d) => d._id));
    setDepartmentAccessModes(user.departmentAccessModes || {});
    setRolePerms(normalizePermissions(user.systemRoleId?.permissions));
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!editable) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = {
        displayName: displayName.trim(),
        email: email.trim(),
        isActive,
        systemRoleId,
        divisionIds,
        gateIds,
        gateAccessModes,
        departmentIds,
        departmentAccessModes,
      };
      if (selectedHrmsEmployee) {
        payload.hrmsEmployeeId = selectedHrmsEmployee._id;
      } else if (password.trim()) {
        payload.password = password.trim();
      }
      await api.systemUsers.update(user._id, payload);
      if (canEditPrivileges && roleId) {
        await api.systemRoles.updatePermissions(roleId, applyWriteImpliesRead(rolePerms));
      }
      const full = await api.systemUsers.get(user._id);
      setSuccess('User updated successfully.');
      setEditing(false);
      setPassword('');
      onSaved?.(full);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const roleName = user.isSuperAdmin ? 'Unrestricted' : user.systemRoleId?.name || '—';
  const hasScope = Boolean(user.divisionIds?.length || user.gateIds?.length || user.departmentIds?.length);

  if (typeof window === 'undefined') return null;

  return createPortal(
    <div className="pass-modal-overlay reg-details-overlay" onClick={onClose}>
      <div
        className={`reg-details-modal su-modal${editing ? ' su-modal--edit' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit System User' : 'System User Details'}
      >
        <div className="reg-details-modal__header no-print">
          <div className="reg-details-modal__title-wrap">
            <span className="reg-details-modal__icon">
              <UserIcon />
            </span>
            <div>
              <h3 className="reg-details-modal__title">{editing ? 'Edit System User' : 'System User Details'}</h3>
              <p className="reg-details-modal__sub">
                {user.displayName} · {user.username}
                {user.isSuperAdmin ? ' · Super Admin' : ''}
              </p>
            </div>
          </div>
          <button type="button" className="reg-details-modal__close" onClick={onClose} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <form onSubmit={handleSave}>
          <div className="reg-details-modal__body">
            <div className="su-modal__identity">
              <div className="su-modal__identity-main">
                <span className="su-modal__avatar">{initialsFromName(user.displayName)}</span>
                <div className="su-modal__identity-text">
                  <p className="su-modal__identity-name">{user.displayName}</p>
                  <p className="su-modal__identity-meta">{user.username} · {roleName}</p>
                </div>
              </div>
              <div className="su-modal__identity-flags">
                <span className={`badge ${user.isActive ? 'badge-success' : 'badge-danger'}`}>
                  {user.isActive ? 'Active' : 'Inactive'}
                </span>
                {user.isSuperAdmin && <span className="badge badge-info">Super Admin</span>}
              </div>
            </div>

            {!editing && (
              <div className="su-view-grid">
                <section className="su-panel">
                  <h4 className="su-panel__title">Account</h4>
                  <dl className="su-kv">
                    <dt>Display Name</dt>
                    <dd>{user.displayName}</dd>
                    <dt>Username</dt>
                    <dd>{user.username}</dd>
                    <dt>Email</dt>
                    <dd>{user.email || '—'}</dd>
                    <dt>System Role</dt>
                    <dd>{user.isSuperAdmin ? 'Unrestricted (Super Admin)' : user.systemRoleId?.name || '—'}</dd>
                    <dt>Last Login</dt>
                    <dd>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</dd>
                    <dt>Created</dt>
                    <dd>{user.createdAt ? formatDate(user.createdAt) : '—'}</dd>
                    <dt>Updated</dt>
                    <dd>{user.updatedAt ? formatDate(user.updatedAt) : '—'}</dd>
                  </dl>
                </section>

                <section className="su-panel">
                  <h4 className="su-panel__title">Access Scope</h4>
                  {user.isSuperAdmin ? (
                    <span className="badge badge-success">All divisions, gates &amp; departments</span>
                  ) : (
                    <>
                      <ScopeBlock title="Divisions" items={user.divisionIds || []} badgeClass="badge-info" />
                      <ScopeBlock
                        title="Division Gates"
                        items={user.gateIds || []}
                        badgeClass="badge-success"
                        renderBadge={(gate) => {
                          const divName = gate.divisionId?.name;
                          return `${gate.name}${divName ? ` · ${divName}` : ''} (${gateModeBadgeLabel(
                            gate,
                            user.gateAccessModes || {}
                          )})`;
                        }}
                      />
                      <ScopeBlock
                        title="Department Gates"
                        items={user.departmentIds || []}
                        badgeClass="badge-warning"
                        renderBadge={(dept) =>
                          departmentDisplayLabel(dept, user.departmentAccessModes || {})
                        }
                      />
                      {!hasScope && <span className="scope-empty">No access scope assigned</span>}
                    </>
                  )}
                </section>

                <section className="su-panel">
                  <h4 className="su-panel__title">Role Privileges</h4>
                  {user.isSuperAdmin ? (
                    <span className="badge badge-success">Full access</span>
                  ) : !roleId ? (
                    <span className="scope-empty">—</span>
                  ) : (
                    <PermissionSummary permissions={user.systemRoleId?.permissions} />
                  )}
                </section>
              </div>
            )}

            {editing && (
              <>
                <div className="su-edit-grid">
                  <section className="su-panel">
                    <h4 className="su-panel__title">Account</h4>
                    <div className="form-group">
                      <label htmlFor="su-display-name">Display Name *</label>
                      <input id="su-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required autoFocus />
                    </div>
                    <div className="form-group">
                      <label htmlFor="su-email">Email</label>
                      <input id="su-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
                    </div>
                    <div className="form-group">
                      <label htmlFor="su-username">Username</label>
                      <input id="su-username" value={user.username} disabled />
                    </div>
                    {!user.hrmsEmployeeId && hrmsEmployeeCreationEnabled && (
                      <HrmsEmployeePicker
                        selectedEmployee={selectedHrmsEmployee}
                        onSelect={(employee) => {
                          setSelectedHrmsEmployee(employee);
                          setPassword('');
                        }}
                        onClear={() => setSelectedHrmsEmployee(null)}
                        label="Assign to HRMS employee"
                      />
                    )}
                    {user.hrmsEmployeeId ? (
                      <p className="field-hint">This account uses HRMS credentials. Manage password changes in HRMS.</p>
                    ) : selectedHrmsEmployee ? (
                      <p className="field-hint">After saving, this account will use the selected employee&apos;s HRMS password.</p>
                    ) : (
                      <div className="form-group">
                        <label htmlFor="su-password">New Password</label>
                        <input id="su-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave blank to keep current" autoComplete="new-password" />
                      </div>
                    )}
                    <div className="form-group">
                      <label htmlFor="su-role">System Role *</label>
                      <select id="su-role" value={systemRoleId} onChange={(e) => setSystemRoleId(e.target.value)} required>
                        <option value="">Select role...</option>
                        {roles.map((r) => <option key={r._id} value={r._id}>{r.name}</option>)}
                      </select>
                    </div>
                    <label className="checkbox-option">
                      <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                      <span>Active user account</span>
                    </label>
                  </section>

                  <section className="su-panel">
                    <h4 className="su-panel__title">Access Scope</h4>
                    {user.isSuperAdmin ? (
                      <span className="badge badge-success">All divisions, gates &amp; departments</span>
                    ) : (
                      <div className="su-scope-grid">
                        <div className="su-scope-col">
                          <p className="su-scope-block__title">Divisions</p>
                          <p className="su-hint">Leave empty for no division restriction.</p>
                          <CheckboxList items={divisions} selected={divisionIds} onToggle={toggleDivision} />
                        </div>

                        <div className="su-scope-col">
                          <p className="su-scope-block__title">Division Gates</p>
                          <p className="su-hint">
                            Optional. Combined gates can be entry, exit, or both.
                            {divisionIds.length === 0 ? ' Showing all gates — select divisions to filter.' : ''}
                          </p>
                          <GateAccessPicker
                            gates={scopedGates}
                            selectedIds={gateIds}
                            modes={gateAccessModes}
                            showDivision={true}
                            emptyMessage={
                              divisionIds.length === 0
                                ? 'No division gates available.'
                                : 'No division gates in the selected divisions.'
                            }
                            onChange={({ gateIds: nextIds, gateAccessModes: nextModes }) => {
                              setGateIds(nextIds);
                              setGateAccessModes(nextModes);
                            }}
                          />
                        </div>

                        <div className="su-scope-col">
                          <p className="su-scope-block__title">Department Gates</p>
                          <p className="su-hint">
                            Optional. Pick Entry, Exit, or Both — same as division gates. Inactive departments stay listed and marked.
                          </p>
                          <DepartmentPicker
                            departments={scopedDepartments}
                            selectedIds={departmentIds}
                            modes={departmentAccessModes}
                            searchPlaceholder="Search department gates…"
                            emptyMessage={
                              divisionIds.length === 0
                                ? 'No department gates available.'
                                : 'No department gates in the selected divisions.'
                            }
                            onChange={({ departmentIds: nextIds, departmentAccessModes: nextModes }) => {
                              setDepartmentIds(nextIds);
                              setDepartmentAccessModes(nextModes);
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </section>
                </div>

                {canEditPrivileges && (
                  <section className="su-panel">
                    <h4 className="su-panel__title">
                      Role Privileges
                      {user.systemRoleId?.name ? ` · ${user.systemRoleId.name}` : ''}
                    </h4>
                    <PermissionMatrix permissions={rolePerms} onChange={setRolePerms} />
                  </section>
                )}
              </>
            )}

            {error && <p className="error-msg">{error}</p>}
            {success && <p className="success-msg">{success}</p>}
          </div>

          <div className="reg-details-modal__footer">
            {editing ? (
              <>
                <button type="button" className="btn-secondary" onClick={handleCancel} disabled={saving}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</button>
              </>
            ) : (
              <>
                <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
                {editable && (
                  <button type="button" className="btn-primary" onClick={() => setEditing(true)}>Edit</button>
                )}
              </>
            )}
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
