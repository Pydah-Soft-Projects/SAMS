'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api/client';
import useRequireWrite from '@/hooks/useRequireWrite';
import GateAccessPicker from '@/components/GateAccessPicker';
import DepartmentPicker from '@/components/DepartmentPicker';
import HrmsEmployeePicker from '@/components/HrmsEmployeePicker';
import {
  filterDepartmentsByDivisions,
  filterGatesByDivisions,
  pruneScopeForDivisions,
} from '@/lib/accessScopeUi';

export default function CreateSystemUserPage() {
  const router = useRouter();
  const { allowed, loading: permLoading } = useRequireWrite('system_users', '/system/users/manage');
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
  const [success, setSuccess] = useState('');
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
    setSuccess('');

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
      setSuccess(`User "${user.displayName}" created successfully.`);
      setDisplayName('');
      setEmail('');
      setUsername('');
      setPassword('');
      setDivisionIds([]);
      setGateIds([]);
      setGateAccessModes({});
      setDepartmentIds([]);
      setDepartmentAccessModes({});
      setTimeout(() => router.push('/system/users/manage'), 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (permLoading || !allowed) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading...</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="su-create-page">
      <div className="card">
        <h3 className="section-title">New System User</h3>
        <p className="section-desc">
          Create a system user, assign a role, then limit access by divisions, division gates, and department gates.
        </p>

        <div className="su-create-grid" style={{ marginTop: '1rem' }}>
          <section className="su-panel">
            <h4 className="su-panel__title">Account</h4>
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
            <div className="form-group">
              <label htmlFor="create-displayname">Display Name <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                id="create-displayname"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. John Smith"
                readOnly={Boolean(selectedEmployee)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="create-email">Email</label>
              <input
                id="create-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Optional email"
                readOnly={Boolean(selectedEmployee)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="create-username">Username <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                id="create-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Login username"
                autoComplete="off"
                readOnly={Boolean(selectedEmployee)}
              />
            </div>
            {selectedEmployee ? (
              <p className="field-hint">The employee will sign in with their existing HRMS password. Password changes must be made in HRMS.</p>
            ) : (
              <div className="form-group">
                <label htmlFor="create-password">Password <span style={{ color: 'var(--danger)' }}>*</span></label>
                <input
                  id="create-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  autoComplete="new-password"
                />
              </div>
            )}
            <div className="form-group">
              <label htmlFor="create-role">System Role <span style={{ color: 'var(--danger)' }}>*</span></label>
              <select id="create-role" value={systemRoleId} onChange={(e) => setSystemRoleId(e.target.value)}>
                <option value="">Select role...</option>
                {roles.map((role) => (
                  <option key={role._id} value={role._id}>{role.name}</option>
                ))}
              </select>
              {roles.length === 0 && (
                <p className="field-hint">Create a system role first, then assign privileges.</p>
              )}
            </div>
          </section>

          <section className="su-panel">
            <h4 className="su-panel__title">Divisions</h4>
            <div className="form-group">
              <label>Divisions</label>
              <p className="su-hint">Optional. Leave empty for no division restriction.</p>
              {divisions.length === 0 ? (
                <p className="scope-empty">No divisions available.</p>
              ) : (
                <div className="checkbox-group su-scroll-list">
                  {divisions.map((division) => (
                    <label key={division._id} className="checkbox-option">
                      <input
                        type="checkbox"
                        checked={divisionIds.includes(division._id)}
                        onChange={() => toggleDivision(division._id)}
                      />
                      <span>{division.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="su-panel">
            <h4 className="su-panel__title">Gate Access</h4>
            <p className="su-hint" style={{ marginTop: 0 }}>
              Assign division gates and/or department gates. Department-only operators do not need division gates.
            </p>

            <div className="form-group">
              <label>Division Gates</label>
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

            <div className="form-group">
              <label>Department Gates</label>
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
          </section>
        </div>

        {error && <p className="error-msg">{error}</p>}
        {success && <p className="success-msg">{success}</p>}

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.25rem' }}>
          <button type="submit" className="btn-primary" disabled={loading || roles.length === 0}>
            {loading ? 'Creating...' : 'Create System User'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => router.push('/system/users/manage')}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}
