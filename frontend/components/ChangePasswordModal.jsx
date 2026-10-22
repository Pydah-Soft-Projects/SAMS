'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api/client';

function EyeIcon({ open }) {
  if (open) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" strokeLinecap="round" />
        <path d="M1 1l22 22" strokeLinecap="round" />
        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function ChangePasswordModal({ user, onClose }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirm(false);
    setError('');
    setSuccess('');
  }, [user?._id]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!password || password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSaving(true);
    try {
      await api.auth.changePassword(password, confirmPassword);
      setSuccess('Password updated successfully');
      setPassword('');
      setConfirmPassword('');
      setTimeout(() => onClose?.(), 900);
    } catch (err) {
      setError(err.message || 'Failed to update password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="shift-picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Change password"
      onClick={onClose}
    >
      <div className="shift-picker-modal change-password-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="shift-picker-modal__title">Change Password</h3>
        <p className="shift-picker-modal__desc">
          {user?.hrmsEmployeeId
            ? 'This account uses HRMS credentials. Change the password in HRMS to keep it synchronized.'
            : 'Update the login password for this account.'}
        </p>

        {user?.hrmsEmployeeId ? (
          <div className="shift-picker-modal__actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        ) : (
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="change-password-username">Username</label>
            <input
              id="change-password-username"
              type="text"
              value={user?.username || ''}
              readOnly
              autoComplete="username"
              className="change-password-modal__username"
            />
          </div>

          <div className="form-group">
            <label htmlFor="change-password-new">New Password</label>
            <div className="password-input-wrap">
              <input
                id="change-password-new"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                autoComplete="new-password"
                autoFocus
                required
                minLength={6}
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                <EyeIcon open={showPassword} />
              </button>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="change-password-confirm">Confirm Password</label>
            <div className="password-input-wrap">
              <input
                id="change-password-confirm"
                type={showConfirm ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
                autoComplete="new-password"
                required
                minLength={6}
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowConfirm((prev) => !prev)}
                aria-label={showConfirm ? 'Hide password' : 'Show password'}
              >
                <EyeIcon open={showConfirm} />
              </button>
            </div>
          </div>

          {error && <p className="error-msg">{error}</p>}
          {success && <p className="success-msg">{success}</p>}

          <div className="shift-picker-modal__actions">
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Updating...' : 'Update Password'}
            </button>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
