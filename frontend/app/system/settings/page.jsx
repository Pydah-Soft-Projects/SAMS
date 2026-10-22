'use client';

import React, { useState, useEffect } from 'react';
import PageShell from '@/components/PageShell';
import { api } from '@/lib/api/client';
import AdminIcon from '@/components/admin/AdminIcons';

export default function SystemSettingsPage() {
  const [settings, setSettings] = useState({
    eyeBlinkVerificationEnabled: true,
    labourPayCategoryGateEntryOptional: false,
    hrmsEmployeeCreationEnabled: true,
    optionalGatePayCategories: ['contract', 'contractor', 'contractors', 'contracters', 'contracter'],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.gate.settings()
      .then(data => {
        if (data) {
          setSettings({
            eyeBlinkVerificationEnabled: data.eyeBlinkVerificationEnabled ?? true,
            labourPayCategoryGateEntryOptional: data.labourPayCategoryGateEntryOptional ?? false,
            hrmsEmployeeCreationEnabled: data.hrmsEmployeeCreationEnabled ?? true,
            optionalGatePayCategories: data.optionalGatePayCategories || ['contract', 'contractor', 'contractors', 'contracters', 'contracter'],
          });
        }
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setError(err.message || 'Failed to load system gate settings');
        setLoading(false);
      });
  }, []);

  const handleToggleEyeBlink = () => {
    setSettings(prev => ({
      ...prev,
      eyeBlinkVerificationEnabled: !prev.eyeBlinkVerificationEnabled,
    }));
  };

  const handleToggleLabourPayCategoryOptional = () => {
    setSettings(prev => ({
      ...prev,
      labourPayCategoryGateEntryOptional: !prev.labourPayCategoryGateEntryOptional,
    }));
  };

  const handleToggleHrmsEmployeeCreation = () => {
    setSettings(prev => ({
      ...prev,
      hrmsEmployeeCreationEnabled: !prev.hrmsEmployeeCreationEnabled,
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const updated = await api.gate.updateSettings(settings);
      setSettings({
        eyeBlinkVerificationEnabled: updated.eyeBlinkVerificationEnabled ?? true,
        labourPayCategoryGateEntryOptional: updated.labourPayCategoryGateEntryOptional ?? false,
        hrmsEmployeeCreationEnabled: updated.hrmsEmployeeCreationEnabled ?? true,
        optionalGatePayCategories: updated.optionalGatePayCategories || ['contract', 'contractor', 'contractors', 'contracters', 'contracter'],
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const toolbar = (
    <button 
      onClick={handleSave} 
      disabled={saving || loading}
      className="admin-btn admin-btn--primary"
      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', height: '36px' }}
    >
      {saving ? 'Saving...' : 'Save Settings'}
    </button>
  );

  return (
    <PageShell 
      title="Gate & System Settings" 
      description="Configure gate verification behaviors, liveness options, and access rules."
      toolbar={toolbar}
    >
      <div className="admin-page-content" style={{ marginTop: '1.5rem', maxWidth: '800px' }}>
        {error && (
          <div style={{ backgroundColor: '#fee2e2', color: '#991b1b', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AdminIcon name="alert" /> {error}
          </div>
        )}

        {success && (
          <div style={{ backgroundColor: '#dcfce7', color: '#166534', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
            Settings saved successfully!
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
            <div className="dash-loading__spinner"></div>
          </div>
        ) : (
          <div className="admin-panel glass-panel admin-fade-in" style={{ padding: '2rem' }}>
            <h3 style={{ margin: '0 0 1.5rem 0', fontSize: '1.25rem', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              Entry & Exit Access Settings
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              
              {/* TOGGLE 1: Eye Blink Verification */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '2rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1 }}>
                  <span style={{ fontWeight: '700', fontSize: '1rem', color: 'var(--text-primary)' }}>
                    Enable Eye Blink Verification (Liveness Detection)
                  </span>
                  <span className="text-muted" style={{ fontSize: '0.875rem' }}>
                    When enabled, the camera scanner on Entry & Exit pages automatically requires the person to blink their eyes to verify liveness before taking a face capture. When disabled, eye blink detection is optional and a manual Capture button is provided.
                  </span>
                </div>
                
                {/* Switch Toggle */}
                <button 
                  type="button"
                  onClick={handleToggleEyeBlink}
                  style={{
                    width: '54px',
                    height: '28px',
                    borderRadius: '9999px',
                    backgroundColor: settings.eyeBlinkVerificationEnabled ? 'var(--primary)' : 'var(--border-color)',
                    border: 'none',
                    position: 'relative',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s',
                    flexShrink: 0,
                    padding: 0
                  }}
                  aria-pressed={settings.eyeBlinkVerificationEnabled}
                >
                  <div style={{
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    backgroundColor: '#fff',
                    position: 'absolute',
                    top: '3px',
                    left: settings.eyeBlinkVerificationEnabled ? '29px' : '3px',
                    transition: 'left 0.2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                  }} />
                </button>
              </div>

              {/* TOGGLE 2: Labour Pay Category Gate Entry Optional */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '2rem', paddingTop: '1.75rem', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: '700', fontSize: '1rem', color: 'var(--text-primary)' }}>
                      Labour Pay Category Gate Entry Optional
                    </span>
                    <span className="badge badge-info" style={{ fontSize: '11px', textTransform: 'uppercase' }}>
                      Contractors Exemption
                    </span>
                  </div>
                  <span className="text-muted" style={{ fontSize: '0.875rem' }}>
                    When enabled, labourers whose Pay Category is marked as <strong>Contractors</strong> (or Contract) do not require prior division gate entry. They can directly enter and exit departments with respect to their division without being blocked by division gate entry rules.
                  </span>
                  {settings.labourPayCategoryGateEntryOptional && (
                    <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: '700', color: 'var(--text-muted)' }}>Exempt Categories:</span>
                      <span className="badge badge-warning" style={{ fontSize: '11px' }}>Contractors / Contracters</span>
                      <span className="badge badge-secondary" style={{ fontSize: '11px' }}>Contract</span>
                      <span style={{ fontSize: '0.75rem', color: '#16a34a', marginLeft: '6px', fontWeight: '600' }}>● Direct Department Entry & Exit Active</span>
                    </div>
                  )}
                </div>
                
                {/* Switch Toggle */}
                <button 
                  type="button"
                  onClick={handleToggleLabourPayCategoryOptional}
                  style={{
                    width: '54px',
                    height: '28px',
                    borderRadius: '9999px',
                    backgroundColor: settings.labourPayCategoryGateEntryOptional ? 'var(--primary)' : 'var(--border-color)',
                    border: 'none',
                    position: 'relative',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s',
                    flexShrink: 0,
                    padding: 0
                  }}
                  aria-pressed={settings.labourPayCategoryGateEntryOptional}
                >
                  <div style={{
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    backgroundColor: '#fff',
                    position: 'absolute',
                    top: '3px',
                    left: settings.labourPayCategoryGateEntryOptional ? '29px' : '3px',
                    transition: 'left 0.2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                  }} />
                </button>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '2rem', paddingTop: '1.75rem', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1 }}>
                  <span style={{ fontWeight: '700', fontSize: '1rem', color: 'var(--text-primary)' }}>
                    Add System Users from HRMS
                  </span>
                  <span className="text-muted" style={{ fontSize: '0.875rem' }}>
                    When enabled, system users can be created using active employees from HRMS. Disabling this hides the HRMS employee picker and blocks HRMS-based user creation.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleToggleHrmsEmployeeCreation}
                  style={{
                    width: '54px',
                    height: '28px',
                    borderRadius: '9999px',
                    backgroundColor: settings.hrmsEmployeeCreationEnabled ? 'var(--primary)' : 'var(--border-color)',
                    border: 'none',
                    position: 'relative',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s',
                    flexShrink: 0,
                    padding: 0
                  }}
                  aria-label="Add system users from HRMS"
                  aria-pressed={settings.hrmsEmployeeCreationEnabled}
                >
                  <div style={{
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    backgroundColor: '#fff',
                    position: 'absolute',
                    top: '3px',
                    left: settings.hrmsEmployeeCreationEnabled ? '29px' : '3px',
                    transition: 'left 0.2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                  }} />
                </button>
              </div>

            </div>

            {/* Note alert */}
            {!settings.eyeBlinkVerificationEnabled && (
              <div style={{ 
                marginTop: '2.5rem', 
                backgroundColor: '#fffbeb', 
                border: '1px solid #fef08a', 
                borderRadius: '8px', 
                padding: '1rem', 
                color: '#854d0e',
                fontSize: '0.875rem',
                lineHeight: '1.4',
                display: 'flex',
                gap: '8px'
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                <div>
                  <strong>Eye Blink Verification is currently disabled</strong>. Operators on Entry & Exit pages will see a manual &quot;Capture for face scan&quot; button to take face photos directly without waiting for an eye blink prompt.
                </div>
              </div>
            )}

          </div>
        )}
      </div>
    </PageShell>
  );
}
