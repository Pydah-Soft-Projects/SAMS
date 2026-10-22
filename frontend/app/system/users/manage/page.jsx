'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { api } from '@/lib/api/client';
import { formatDate } from '@/lib/formatDate';
import { useAuth } from '@/components/AuthProvider';
import SystemUserDetailsModal from '@/components/SystemUserDetailsModal';
import GateAccessPicker, { gateModeBadgeLabel } from '@/components/GateAccessPicker';
import ScopeOverflowCell from '@/components/ScopeOverflowCell';
import DepartmentPicker, { departmentDisplayLabel } from '@/components/DepartmentPicker';
import HrmsEmployeePicker from '@/components/HrmsEmployeePicker';
import {
  filterDepartmentsByDivisions,
  filterGatesByDivisions,
  pruneScopeForDivisions,
} from '@/lib/accessScopeUi';

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function NewUserModal({ onClose, onComplete }) {
  const [roles, setRoles] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [gates, setGates] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [hrmsEmployeeCreationEnabled, setHrmsEmployeeCreationEnabled] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [systemRoleId, setSystemRoleId] = useState('');
  const [divisionIds, setDivisionIds] = useState([]);
  const [gateIds, setGateIds] = useState([]);
  const [gateAccessModes, setGateAccessModes] = useState({});
  const [departmentIds, setDepartmentIds] = useState([]);
  const [departmentAccessModes, setDepartmentAccessModes] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      api.systemRoles.list(),
      api.divisions.list({ isActive: 'true' }),
      api.gates.list({ isActive: 'true' }),
      api.departments.list(),
      api.gate.settings(),
    ])
      .then(([roleList, divisionList, gateList, departmentList, gateSettings]) => {
        const activeRoles = roleList.filter((r) => r.isActive);
        setRoles(activeRoles);
        setDivisions(divisionList);
        setGates(gateList);
        setDepartments(departmentList);
        setHrmsEmployeeCreationEnabled(gateSettings.hrmsEmployeeCreationEnabled ?? true);
        if (activeRoles.length > 0) setSystemRoleId(activeRoles[0]._id);
      })
      .catch((e) => setError(e.message));
  }, []);

  const scopedGates = useMemo(
    () => filterGatesByDivisions(gates, divisionIds),
    [gates, divisionIds]
  );

  const scopedDepartments = useMemo(
    () => filterDepartmentsByDivisions(departments, divisionIds),
    [departments, divisionIds]
  );

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

  async function handleSubmit(e) {
    e.preventDefault();
    if (!displayName.trim()) return setError('Display name is required');
    if (!selectedEmployee && !username.trim()) return setError('Username is required');
    if (!selectedEmployee && (!password || password.length < 6)) {
      return setError('Password must be at least 6 characters');
    }
    if (!systemRoleId) return setError('System role is required');

    setLoading(true);
    setError('');

    try {
      const user = await api.systemUsers.create({
        displayName: displayName.trim(),
        email: email.trim(),
        hrmsEmployeeId: selectedEmployee?._id,
        ...(selectedEmployee ? {} : { username: username.trim(), password }),
        systemRoleId,
        divisionIds,
        gateIds,
        gateAccessModes,
        departmentIds,
        departmentAccessModes,
      });
      onComplete(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (typeof window === 'undefined') return null;

  return createPortal(
    <div
      className="pass-modal-overlay reg-details-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="New System User"
    >
      <div
        className="reg-details-modal su-modal su-modal--create"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="reg-details-modal__header no-print">
          <div className="reg-details-modal__title-wrap">
            <span className="reg-details-modal__icon">
              <PlusIcon />
            </span>
            <div>
              <h3 className="reg-details-modal__title">New System User</h3>
              <p className="reg-details-modal__sub">Create a user, assign a role, and set division / department gate access</p>
            </div>
          </div>
          <button type="button" className="reg-details-modal__close" onClick={onClose} title="Close" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="reg-details-modal__body">
            <div className="su-account-panel">
              <p className="su-create-col__title">Account</p>
              {hrmsEmployeeCreationEnabled && <HrmsEmployeePicker
                selectedEmployee={selectedEmployee}
                onSelect={(employee) => {
                  setSelectedEmployee(employee);
                  setDisplayName(employee.displayName);
                  setEmail(employee.email || '');
                  setUsername(employee.employeeId || '');
                }}
                onClear={() => {
                  setSelectedEmployee(null);
                  setDisplayName('');
                  setEmail('');
                  setUsername('');
                  setPassword('');
                }}
              />}
              <div className="su-account-grid">
                <div className="form-group">
                  <label htmlFor="user-displayname">Display Name <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input id="user-displayname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. John Smith" autoFocus readOnly={Boolean(selectedEmployee)} />
                </div>
                <div className="form-group">
                  <label htmlFor="user-email">Email</label>
                  <input id="user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional email" readOnly={Boolean(selectedEmployee)} />
                </div>
                <div className="form-group">
                  <label htmlFor="user-username">Username <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input id="user-username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Login username" autoComplete="off" readOnly={Boolean(selectedEmployee)} />
                </div>
                {selectedEmployee ? (
                  <p className="field-hint">The employee will sign in with their existing HRMS password. Password changes must be made in HRMS.</p>
                ) : (
                  <div className="form-group">
                    <label htmlFor="user-password">Password <span style={{ color: 'var(--danger)' }}>*</span></label>
                    <input id="user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" />
                  </div>
                )}
                <div className="form-group">
                  <label htmlFor="user-role">System Role <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <select id="user-role" value={systemRoleId} onChange={(e) => setSystemRoleId(e.target.value)}>
                    <option value="">Select role...</option>
                    {roles.map((role) => <option key={role._id} value={role._id}>{role.name}</option>)}
                  </select>
                  {roles.length === 0 && (
                    <p className="field-hint">
                      No active roles. <Link href="/system/roles/manage" onClick={onClose}>Create a system role first.</Link>
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="su-create-grid">
              <div className="su-create-col">
                <p className="su-create-col__title">Divisions</p>
                <p className="su-hint">Leave empty for no division restriction.</p>
                {divisions.length === 0 ? (
                  <p className="scope-empty">No divisions available.</p>
                ) : (
                  <div className="checkbox-group su-scroll-list su-scroll-list--dept">
                    {divisions.map((d) => (
                      <label key={d._id} className="checkbox-option">
                        <input type="checkbox" checked={divisionIds.includes(d._id)} onChange={() => toggleDivision(d._id)} />
                        <span>{d.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="su-create-col">
                <p className="su-create-col__title">Division Gates</p>
                <p className="su-hint">
                  Optional. Combined gates can be entry, exit, or both.
                  {divisionIds.length === 0 ? ' Showing all gates — select divisions to filter.' : ''}
                </p>
                <GateAccessPicker
                  gates={scopedGates}
                  selectedIds={gateIds}
                  modes={gateAccessModes}
                  showDivision={divisionIds.length === 0}
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

              <div className="su-create-col">
                <p className="su-create-col__title">Department Gates</p>
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

            {error && <p className="error-msg">{error}</p>}
          </div>

          <div className="reg-details-modal__footer">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading || roles.length === 0}>
              {loading ? 'Creating...' : 'Create System User'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export default function ManageSystemUsersPage() {
  const { can } = useAuth();
  const canWrite = can('system_users', 'write');
  const canEditRole = can('system_roles', 'write');
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);
  const [loadingUser, setLoadingUser] = useState(false);
  const [showNewUserModal, setShowNewUserModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRoleId, setFilterRoleId] = useState('');
  const [filterDivisionId, setFilterDivisionId] = useState('');
  const [filterDepartmentId, setFilterDepartmentId] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [divisions, setDivisions] = useState([]);
  const [departments, setDepartments] = useState([]);

  useEffect(() => {
    loadUsers();
    Promise.all([
      api.systemRoles.list(),
      api.divisions.list({ isActive: 'true' }),
      api.departments.list(),
    ])
      .then(([roleList, divisionList, departmentList]) => {
        setRoles(Array.isArray(roleList) ? roleList : []);
        setDivisions(Array.isArray(divisionList) ? divisionList : []);
        setDepartments(Array.isArray(departmentList) ? departmentList : []);
      })
      .catch(() => {});
  }, []);

  async function loadUsers() {
    setLoading(true);
    try {
      setUsers(await api.systemUsers.list());
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Delete system user "${name}"?`)) return;
    try {
      await api.systemUsers.delete(id);
      await loadUsers();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleToggleActive(user) {
    try {
      await api.systemUsers.update(user._id, { isActive: !user.isActive });
      await loadUsers();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleOpenUser(user) {
    setLoadingUser(true);
    setError('');
    try {
      const full = await api.systemUsers.get(user._id);
      setSelectedUser(full);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingUser(false);
    }
  }

  function handleUserSaved(updated) {
    setSelectedUser(updated);
    loadUsers();
  }

  function handleUserCreated() {
    setShowNewUserModal(false);
    loadUsers();
  }

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return users.filter((user) => {
      if (filterStatus === 'active' && !user.isActive) return false;
      if (filterStatus === 'inactive' && user.isActive) return false;

      if (filterRoleId === '__super__') {
        if (!user.isSuperAdmin) return false;
      } else if (filterRoleId) {
        const roleId = user.systemRoleId?._id || user.systemRoleId || '';
        if (String(roleId) !== filterRoleId) return false;
      }

      if (filterDivisionId === '__none__') {
        if (user.isSuperAdmin || (user.divisionIds || []).length > 0) return false;
      } else if (filterDivisionId) {
        if (user.isSuperAdmin) return false;
        const assigned = (user.divisionIds || []).some((div) => String(div?._id || div) === filterDivisionId);
        if (!assigned) return false;
      }

      if (filterDepartmentId === '__none__') {
        if (user.isSuperAdmin || (user.departmentIds || []).length > 0) return false;
      } else if (filterDepartmentId) {
        if (user.isSuperAdmin) return false;
        const assigned = (user.departmentIds || []).some((dept) => String(dept?._id || dept) === filterDepartmentId);
        if (!assigned) return false;
      }

      if (!q) return true;
      const haystack = [
        user.displayName,
        user.username,
        user.email,
        user.isSuperAdmin ? 'super admin unrestricted' : user.systemRoleId?.name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [users, searchQuery, filterRoleId, filterDivisionId, filterDepartmentId, filterStatus]);

  const hasActiveFilters = Boolean(
    searchQuery.trim() || filterRoleId || filterDivisionId || filterDepartmentId || filterStatus
  );

  const departmentFilterOptions = useMemo(() => {
    if (!filterDivisionId || filterDivisionId === '__none__') return departments;
    return departments.filter((dept) =>
      (dept.divisionIds || []).some((div) => String(div?._id || div) === filterDivisionId)
    );
  }, [departments, filterDivisionId]);

  if (loading && users.length === 0) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading system users...</p>;
  }

  return (
    <div>
      <div className="rc-filters-bar" style={{ marginBottom: '1rem' }}>
        <div className="rc-filters-bar__left">
          <div className="rc-search-wrap">
            <svg className="rc-search-wrap__icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              id="user-search"
              type="search"
              className="rc-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, username, email…"
              autoComplete="off"
              aria-label="Search users"
            />
          </div>
          <select
            id="user-filter-role"
            className="rc-select"
            value={filterRoleId}
            onChange={(e) => setFilterRoleId(e.target.value)}
            aria-label="Filter by Role"
          >
            <option value="">All roles</option>
            <option value="__super__">Super Admin</option>
            {roles.map((role) => (
              <option key={role._id} value={role._id}>{role.name}</option>
            ))}
          </select>
          <select
            id="user-filter-division"
            className="rc-select"
            value={filterDivisionId}
            onChange={(e) => {
              setFilterDivisionId(e.target.value);
              setFilterDepartmentId('');
            }}
            aria-label="Filter by Division"
          >
            <option value="">All divisions</option>
            <option value="__none__">Unassigned</option>
            {divisions.map((division) => (
              <option key={division._id} value={division._id}>{division.name}</option>
            ))}
          </select>
          <select
            id="user-filter-department"
            className="rc-select"
            value={filterDepartmentId}
            onChange={(e) => setFilterDepartmentId(e.target.value)}
            aria-label="Filter by Department"
          >
            <option value="">All departments</option>
            <option value="__none__">Unassigned</option>
            {departmentFilterOptions.map((department) => (
              <option key={department._id} value={department._id}>
                {department.isActive === false ? `${department.name} (Inactive)` : department.name}
              </option>
            ))}
          </select>
          <select
            id="user-filter-status"
            className="rc-select"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            aria-label="Filter by Status"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div className="rc-filters-bar__right">
          <span className="rc-filter-pill rc-filter-pill--muted">
            {hasActiveFilters ? `${filteredUsers.length} of ${users.length} users` : `${users.length} users`}
          </span>
          {canWrite && (
            <button
              type="button"
              className="btn-primary btn-sm"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
              onClick={() => setShowNewUserModal(true)}
              aria-label="New User"
            >
              <PlusIcon />
              New User
            </button>
          )}
        </div>
      </div>

      {error && <p className="error-msg">{error}</p>}

      {!canWrite && (
        <p className="read-only-banner">View only — system user changes require write access.</p>
      )}

      {users.length === 0 ? (
        <div className="empty-state card">
          <p>No system users yet.</p>
          {canWrite && (
            <button type="button" className="btn-primary" style={{ marginTop: '1rem' }} onClick={() => setShowNewUserModal(true)}>
              Create System User
            </button>
          )}
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="empty-state card">
          <p>No users match the current search or filters.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-scroll su-table-scroll">
            <table className="reg-table su-table">
              <thead>
                <tr>
                  <th style={{ width: '16%' }}>User</th>
                  <th style={{ width: '9%' }}>Username</th>
                  <th style={{ width: '9%' }}>Role</th>
                  <th style={{ width: '10%' }}>Divisions</th>
                  <th style={{ width: '10%' }}>Division Gates</th>
                  <th style={{ width: '10%' }}>Department Gates</th>
                  <th style={{ width: '8%' }}>Status</th>
                  <th style={{ width: '10%' }}>Last Login</th>
                  <th style={{ width: '18%', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user) => (
                  <tr key={user._id} className={!user.isActive ? 'row-inactive' : undefined}>
                    <td className="name-cell">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <span>{user.displayName}</span>
                        {user.isSuperAdmin && (
                          <span className="badge badge-info">Super Admin</span>
                        )}
                      </div>
                    </td>
                    <td><code style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{user.username}</code></td>
                    <td>{user.isSuperAdmin ? 'Unrestricted' : user.systemRoleId?.name || '—'}</td>

                    {/* Divisions */}
                    <td className="scope-col">
                      {user.isSuperAdmin ? (
                        <span className="badge badge-success">All</span>
                      ) : (
                        <ScopeOverflowCell
                          items={user.divisionIds || []}
                          badgeClass="badge-info"
                          title="Divisions"
                          subtitle={user.displayName}
                        />
                      )}
                    </td>

                    {/* Gates */}
                    <td className="scope-col">
                      {user.isSuperAdmin ? (
                        <span className="badge badge-success">All</span>
                      ) : (
                        <ScopeOverflowCell
                          items={user.gateIds || []}
                          badgeClass="badge-success"
                          title="Division Gates"
                          subtitle={user.displayName}
                          renderLabel={(gate) => `${gate.name} (${gateModeBadgeLabel(gate, user.gateAccessModes || {})})`}
                        />
                      )}
                    </td>

                    {/* Departments */}
                    <td className="scope-col">
                      {user.isSuperAdmin ? (
                        <span className="badge badge-success">All</span>
                      ) : (
                        <ScopeOverflowCell
                          items={user.departmentIds || []}
                          badgeClass="badge-warning"
                          title="Department Gates"
                          subtitle={user.displayName}
                          renderLabel={(dept) =>
                            departmentDisplayLabel(dept, user.departmentAccessModes || {})
                          }
                        />
                      )}
                    </td>
                    <td>
                      <span className={`badge ${user.isActive ? 'badge-success' : 'badge-danger'}`}>
                        {user.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {user.lastLoginAt ? formatDate(user.lastLoginAt) : '—'}
                    </td>
                    <td className="actions-cell" style={{ textAlign: 'right' }}>
                      {!user.isSuperAdmin && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => handleOpenUser(user)}
                          title="Edit user details"
                          disabled={loadingUser}
                        >
                          Edit
                        </button>
                      )}
                      {canWrite && !user.isSuperAdmin && (
                        <>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => handleToggleActive(user)}>
                            {user.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                          <button type="button" className="btn-danger btn-sm" onClick={() => handleDelete(user._id, user.displayName)}>
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedUser && (
        <SystemUserDetailsModal
          user={selectedUser}
          canWrite={canWrite}
          canEditRole={canEditRole}
          onClose={() => setSelectedUser(null)}
          onSaved={handleUserSaved}
        />
      )}

      {showNewUserModal && (
        <NewUserModal
          onClose={() => setShowNewUserModal(false)}
          onComplete={handleUserCreated}
        />
      )}
    </div>
  );
}
