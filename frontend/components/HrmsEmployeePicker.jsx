'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api/client';

export default function HrmsEmployeePicker({
  selectedEmployee,
  onSelect,
  onClear,
  label = 'HRMS Employee (Optional)',
}) {
  const [query, setQuery] = useState('');
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const search = query.trim();
    setEmployees([]);
    if (search.length < 2) {
      setError('');
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const results = await api.systemUsers.hrmsEmployees({ search });
        if (!cancelled) setEmployees(results);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function selectEmployee(employee) {
    onSelect(employee);
    setQuery('');
    setEmployees([]);
    setError('');
  }

  return (
    <div className="form-group">
      <label htmlFor="hrms-employee-search">{label}</label>
      {selectedEmployee ? (
        <div className="checkbox-option" style={{ justifyContent: 'space-between', gap: '1rem' }}>
          <span>
            {selectedEmployee.displayName}
            {selectedEmployee.employeeId ? ` · ${selectedEmployee.employeeId}` : ''}
            {selectedEmployee.email ? ` · ${selectedEmployee.email}` : ''}
          </span>
          <button type="button" className="btn-secondary" onClick={onClear}>
            Clear
          </button>
        </div>
      ) : (
        <>
          <input
            id="hrms-employee-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, employee ID, or email"
            autoComplete="off"
          />
          {query.trim().length < 2 && (
            <p className="field-hint">Type at least 2 characters to search active HRMS employees.</p>
          )}
          {loading && <p className="field-hint">Searching HRMS employees...</p>}
          {error && <p className="error-msg">{error}</p>}
          {!loading && !error && query.trim().length >= 2 && employees.length === 0 && (
            <p className="field-hint">No unlinked active employees found.</p>
          )}
          {employees.length > 0 && (
            <div className="checkbox-group su-scroll-list" role="listbox" aria-label="HRMS employees">
              {employees.map((employee) => (
                <button
                  key={employee._id}
                  type="button"
                  className="checkbox-option"
                  role="option"
                  aria-selected="false"
                  onClick={() => selectEmployee(employee)}
                  style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                >
                  <span>
                    {employee.displayName}
                    {employee.employeeId ? ` · ${employee.employeeId}` : ''}
                    {employee.email ? ` · ${employee.email}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
