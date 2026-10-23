'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ensureBackendReady, warmBackend } from '@/lib/api/client';
import { useAuth } from '@/components/AuthProvider';
import GateScopePicker from '@/components/GateScopePicker';
import { getPostLoginRoute, hasAssignedEntryExitScope } from '@/lib/auth/routing';
import { getToken } from '@/lib/auth/session';
import { buildEntryExitUrl, eventActionLabel } from '@/lib/entryExit';
import { getGateSession, normalizeGateSession, setGateSession } from '@/lib/gateSession';
import BotLoader from '@/components/BotLoader';
import { useDeviceAgent } from '@/lib/device/agent';
import { CURRENT_RELEASE } from '@/lib/device/releaseManifest';

const REMEMBER_KEY = 'sams_login_remember_username';

/* ── Icons ──────────────────────────────────────────────────── */
function EyeIcon({ open }) {
  if (open) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" strokeLinecap="round" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" strokeLinecap="round" />
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

function UserIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/* ── Device Agent Icons ──────────────────────────────────────── */
function MonitorIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function AlertTriangleIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ShieldOffIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

/* ── Rocket illustration (unchanged) ────────────────────────── */
function RocketIllustration() {
  return (
    <svg className="login-hero__illustration" viewBox="0 0 260 360" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <ellipse cx="130" cy="180" rx="28" ry="65" fill="url(#rocketBody)" />
      <path d="M102 155 Q130 90 158 155Z" fill="#DBEAFE" />
      <circle cx="130" cy="170" r="12" fill="#fff" opacity="0.9" />
      <circle cx="130" cy="170" r="8" fill="#4D8FFF" />
      <circle cx="127" cy="167" r="3" fill="#fff" opacity="0.7" />
      <path d="M102 215 Q88 240 100 245 L102 230Z" fill="#1A56FF" />
      <path d="M158 215 Q172 240 160 245 L158 230Z" fill="#1A56FF" />
      <ellipse cx="130" cy="252" rx="18" ry="8" fill="rgba(251,191,36,0.5)" />
      <path d="M115 248 Q122 290 130 310 Q138 290 145 248Z" fill="url(#flame)" opacity="0.9" />
      <path d="M122 248 Q127 278 130 292 Q133 278 138 248Z" fill="url(#flameInner)" />
      <circle cx="210" cy="80" r="28" fill="rgba(77,143,255,0.3)" />
      <circle cx="210" cy="80" r="20" fill="rgba(77,143,255,0.2)" />
      <circle cx="48" cy="290" r="18" fill="rgba(26,86,255,0.25)" />
      <circle cx="60" cy="60" r="2" fill="white" opacity="0.7" />
      <circle cx="195" cy="150" r="1.5" fill="white" opacity="0.6" />
      <circle cx="80" cy="200" r="1.5" fill="white" opacity="0.5" />
      <circle cx="220" cy="220" r="2" fill="white" opacity="0.6" />
      <circle cx="40" cy="130" r="1" fill="white" opacity="0.5" />
      <circle cx="170" cy="50" r="1.5" fill="white" opacity="0.4" />
      <defs>
        <linearGradient id="rocketBody" x1="102" y1="115" x2="158" y2="245" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#EFF4FF" /><stop offset="100%" stopColor="#BFDBFE" />
        </linearGradient>
        <linearGradient id="flame" x1="130" y1="248" x2="130" y2="310" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FBBF24" /><stop offset="100%" stopColor="#F97316" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="flameInner" x1="130" y1="248" x2="130" y2="292" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FEF3C7" /><stop offset="100%" stopColor="#FBBF24" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function FeatureIcon({ children }) { return <span className="login-hero__feature-icon">{children}</span>; }
function ShieldIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
}
function ChartIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>;
}
function RocketIconSm() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></svg>;
}

/* ── Shared hero panel (reused on every gate screen) ─────────── */
function LoginHero() {
  return (
    <div className="login-hero" aria-hidden="true">
      <div className="login-hero__wave login-hero__wave--1" />
      <div className="login-hero__wave login-hero__wave--2" />
      <div className="login-hero__orb login-hero__orb--1" />
      <div className="login-hero__orb login-hero__orb--2" />
      <div className="login-hero__orb login-hero__orb--3" />
      <div className="login-hero__stars" />
      <div className="login-hero__content">
        <div className="login-hero__badge">
          <span className="login-hero__badge-dot" />
          Smart Management System
        </div>
        <h2 className="login-hero__title">Secure Access<br /><span>Made Simple.</span></h2>
        <p className="login-hero__subtitle">
          Manage registrations, gate access, and attendance — all in one unified platform built for modern organizations.
        </p>
        <div className="login-hero__features">
          <div className="login-hero__feature"><FeatureIcon><ShieldIcon /></FeatureIcon>Face-verified access control</div>
          <div className="login-hero__feature"><FeatureIcon><ChartIcon /></FeatureIcon>Real-time attendance reports</div>
          <div className="login-hero__feature"><FeatureIcon><RocketIconSm /></FeatureIcon>Multi-gate & department support</div>
        </div>
      </div>
      <div className="login-hero__rocket-glow" />
      <RocketIllustration />
    </div>
  );
}

/* ── Shared right-panel wrapper (reused on every gate screen) ── */
function GatePanel({ children }) {
  return (
    <div className="login-form-panel">
      <div className="login-form-panel__curve login-form-panel__curve--top" aria-hidden />
      <div className="login-form-panel__curve login-form-panel__curve--middle" aria-hidden />
      <div className="login-form-panel__curve login-form-panel__curve--bottom" aria-hidden />
      {children}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DEVICE GATE SCREENS
   These replace the login form until the device is approved.
   All share the same split-screen .login-shell layout.
════════════════════════════════════════════════════════════════ */

/* ── Checking / initializing ──────────────────────────────────── */
function DeviceCheckingScreen({ phase }) {
  const messages = {
    checking:        'Initializing Device Agent…',
    fetching_device: 'Reading device fingerprint…',
    validating:      'Verifying device with SAMS…',
  };
  const message = messages[phase] ?? 'Connecting…';

  return (
    <div className="login-shell">
      <LoginHero />
      <GatePanel>
        <div className="device-gate-card" role="status" aria-live="polite" aria-label={message}>
          <div className="device-gate-card__icon device-gate-card__icon--checking">
            <ClockIcon />
          </div>
          <h2 className="device-gate-card__title">Device Verification</h2>
          <p className="device-gate-card__subtitle">{message}</p>
          <div className="device-gate-card__spinner" aria-hidden="true">
            <span /><span /><span />
          </div>
          <p className="device-gate-card__hint">
            This happens automatically. Please wait a moment.
          </p>
        </div>
      </GatePanel>
    </div>
  );
}

/* ── Not installed ────────────────────────────────────────────── */
function DeviceNotInstalledScreen({ onRetry }) {
  const r = CURRENT_RELEASE;
  const hasDownload = Boolean(r.downloadUrl);
  const [hashCopied, setHashCopied] = useState(false);

  async function copyHash() {
    if (!r.sha256) return;
    try {
      await navigator.clipboard.writeText(r.sha256);
      setHashCopied(true);
      setTimeout(() => setHashCopied(false), 2000);
    } catch { /* ignore */ }
  }

  return (
    <div className="login-shell">
      <LoginHero />
      <GatePanel>
        {/* Use login-card--wide so the richer content fits */}
        <div className="device-gate-card device-gate-card--wide" role="alert">

          {/* ── Header ── */}
          <div className="device-gate-card__icon device-gate-card__icon--warning">
            <MonitorIcon />
          </div>
          <h2 className="device-gate-card__title">Device Agent Not Installed</h2>
          <p className="device-gate-card__subtitle">
            SAMS requires the Device Agent to be running on this computer.
            Download and install it to continue.
          </p>

          {/* ── Release metadata grid ── */}
          <div className="dni-meta-grid">
            <div className="dni-meta-item">
              <span className="dni-meta-label">Version</span>
              <span className="dni-meta-value">{r.version}</span>
            </div>
            <div className="dni-meta-item">
              <span className="dni-meta-label">Release Date</span>
              <span className="dni-meta-value">{r.releaseDate}</span>
            </div>
            <div className="dni-meta-item">
              <span className="dni-meta-label">File Size</span>
              <span className="dni-meta-value">{r.fileSize ?? '—'}</span>
            </div>
            <div className="dni-meta-item">
              <span className="dni-meta-label">Platform</span>
              <span className="dni-meta-value">Windows x64</span>
            </div>
          </div>

          {/* ── SHA-256 ── */}
          {r.sha256 && (
            <div className="dni-hash-row">
              <span className="dni-meta-label">SHA-256</span>
              <div className="dni-hash-inner">
                <code className="dni-hash-value" title={r.sha256}>
                  {r.sha256.slice(0, 24)}…
                </code>
                <button
                  type="button"
                  className="dni-hash-copy"
                  onClick={copyHash}
                  aria-label={hashCopied ? 'Copied' : 'Copy full SHA-256 hash'}
                  title="Copy full SHA-256 to clipboard"
                >
                  {hashCopied ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                  )}
                  {hashCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* ── Primary CTA: Download ── */}
          <div className="dni-actions">
            {hasDownload ? (
              <a
                href={r.downloadUrl}
                download
                className="btn-primary device-gate-card__retry dni-download-btn"
              >
                <DownloadIcon />
                Download Device Agent v{r.version}
              </a>
            ) : (
              <div className="dni-unavailable">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                Installer is currently unavailable. Please contact your administrator.
              </div>
            )}
          </div>

          {/* ── Installation steps ── */}
          <div className="device-gate-card__instructions">
            <p className="device-gate-card__instructions-title">Installation steps:</p>
            <ol className="device-gate-card__steps">
              <li>Download the installer above and <strong>run it as Administrator</strong>.</li>
              <li>Follow the wizard — the service starts automatically when complete.</li>
              <li>This page will detect the agent and continue <strong>without any browser refresh</strong>.</li>
            </ol>
          </div>

          {/* ── Polling status + Check Again ── */}
          <div className="dni-polling-row">
            <span className="dni-polling-dot" aria-hidden />
            <span className="dni-polling-label">Waiting for Device Agent…</span>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={onRetry}
            >
              <RefreshIcon />
              Check Again
            </button>
          </div>

          <p className="device-gate-card__contact">
            Need help?{' '}
            <a href="mailto:admin@example.com" className="login-footer__link">
              Contact your administrator
            </a>
          </p>
        </div>
      </GatePanel>
    </div>
  );
}

/* ── Agent error (hardware failure / WMI / timeout) ─────────── */
function DeviceAgentErrorScreen({ errorMessage, onRetry }) {
  return (
    <div className="login-shell">
      <LoginHero />
      <GatePanel>
        <div className="device-gate-card" role="alert">
          <div className="device-gate-card__icon device-gate-card__icon--danger">
            <AlertTriangleIcon />
          </div>
          <h2 className="device-gate-card__title">Device Agent Error</h2>
          <p className="device-gate-card__subtitle">
            The Device Agent encountered a problem and could not generate a hardware fingerprint.
          </p>

          {errorMessage && (
            <div className="device-gate-card__error-box">
              <p className="device-gate-card__error-message">{errorMessage}</p>
            </div>
          )}

          <div className="device-gate-card__actions">
            <button
              type="button"
              className="btn-primary device-gate-card__retry"
              onClick={onRetry}
            >
              <RefreshIcon />
              Retry
            </button>
          </div>

          <p className="device-gate-card__contact">
            If this persists, restart the <strong>SAMS Device Agent</strong> Windows Service
            or contact your administrator.{' '}
            <a href="mailto:admin@example.com" className="login-footer__link">Get help</a>
          </p>
        </div>
      </GatePanel>
    </div>
  );
}

/* ── Device pending approval ─────────────────────────────────── */
function DevicePendingScreen({ deviceMessage, onRetry }) {
  const defaultMsg = 'Your device has been registered and is awaiting administrator approval. You will be able to sign in once it is approved.';
  return (
    <div className="login-shell">
      <LoginHero />
      <GatePanel>
        <div className="device-gate-card" role="alert">
          <div className="device-gate-card__icon device-gate-card__icon--warning">
            <ClockIcon />
          </div>
          <span className="badge badge-warning device-gate-card__badge">Pending Approval</span>
          <h2 className="device-gate-card__title">Device Awaiting Approval</h2>
          <p className="device-gate-card__subtitle">
            {deviceMessage || defaultMsg}
          </p>
          <div className="device-gate-card__info-row">
            <span className="device-gate-card__info-label">What happens next?</span>
            <p className="device-gate-card__info-text">
              An administrator will review your device registration request. Once approved,
              you can return to this page and sign in normally.
            </p>
          </div>
          <div className="device-gate-card__actions">
            <button
              type="button"
              className="btn-secondary device-gate-card__retry"
              onClick={onRetry}
            >
              <RefreshIcon />
              Check Again
            </button>
          </div>
          <p className="device-gate-card__contact">
            Need it urgently?{' '}
            <a href="mailto:admin@example.com" className="login-footer__link">Contact your administrator</a>
          </p>
        </div>
      </GatePanel>
    </div>
  );
}

/* ── Device rejected ─────────────────────────────────────────── */
function DeviceRejectedScreen({ deviceMessage, onRetry }) {
  const defaultMsg = 'Your device registration request was rejected by an administrator.';
  return (
    <div className="login-shell">
      <LoginHero />
      <GatePanel>
        <div className="device-gate-card" role="alert">
          <div className="device-gate-card__icon device-gate-card__icon--danger">
            <ShieldOffIcon />
          </div>
          <span className="badge badge-danger device-gate-card__badge">Registration Rejected</span>
          <h2 className="device-gate-card__title">Device Not Authorized</h2>
          <p className="device-gate-card__subtitle">
            {deviceMessage || defaultMsg}
          </p>
          <div className="device-gate-card__actions">
            <button
              type="button"
              className="btn-secondary device-gate-card__retry"
              onClick={onRetry}
            >
              <RefreshIcon />
              Retry
            </button>
          </div>
          <p className="device-gate-card__contact">
            Contact your administrator to appeal this decision.{' '}
            <a href="mailto:admin@example.com" className="login-footer__link">Get help</a>
          </p>
        </div>
      </GatePanel>
    </div>
  );
}

/* ── Device blocked ──────────────────────────────────────────── */
function DeviceBlockedScreen({ deviceMessage, onRetry }) {
  const defaultMsg = 'This device has been blocked by an administrator and cannot be used to sign in.';
  return (
    <div className="login-shell">
      <LoginHero />
      <GatePanel>
        <div className="device-gate-card" role="alert">
          <div className="device-gate-card__icon device-gate-card__icon--danger">
            <ShieldOffIcon />
          </div>
          <span className="badge badge-danger device-gate-card__badge">Device Blocked</span>
          <h2 className="device-gate-card__title">Access Blocked</h2>
          <p className="device-gate-card__subtitle">
            {deviceMessage || defaultMsg}
          </p>
          <div className="device-gate-card__actions">
            <button
              type="button"
              className="btn-secondary device-gate-card__retry"
              onClick={onRetry}
            >
              <RefreshIcon />
              Retry
            </button>
          </div>
          <p className="device-gate-card__contact">
            Contact your administrator to have this device unblocked.{' '}
            <a href="mailto:admin@example.com" className="login-footer__link">Get help</a>
          </p>
        </div>
      </GatePanel>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   LOGIN FORM  (shown only when device is approved)
   Identical to the original — no changes.
════════════════════════════════════════════════════════════════ */

function LoginSteps({ step, flow, onStepClick }) {
  const steps =
    flow === 'gate'
      ? [
          { id: 'username', label: 'Username' },
          { id: 'password', label: 'Password' },
          { id: 'gate-select', label: 'Gate' },
        ]
      : [
          { id: 'username', label: 'Username' },
          { id: 'password', label: 'Password' },
        ];

  const currentIndex = steps.findIndex((s) => s.id === step);

  return (
    <div className="login-steps" role="tablist" aria-label="Login steps">
      {steps.map((item, index) => {
        const active = item.id === step;
        const done = currentIndex > index;
        const clickable = done && onStepClick;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={!clickable && !active}
            className={`login-steps__item${active ? ' login-steps__item--active' : ''}${done ? ' login-steps__item--done' : ''}`}
            onClick={() => clickable && onStepClick(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function LoginBrand() {
  return (
    <div className="login-brand">
      <span className="brand-icon">S</span>
      <div>
        <h1>SAMS</h1>
        <p>System Login</p>
      </div>
    </div>
  );
}

function LoginFooter() {
  return (
    <>
      <div className="login-divider"><span>or</span></div>
      <p className="login-footer">
        Need help?{' '}
        <a href="mailto:admin@example.com" className="login-footer__link">
          Contact your administrator
        </a>
      </p>
    </>
  );
}

function LoginField({ id, label, type = 'text', value, onChange, placeholder, autoComplete, autoFocus, required, icon, trailing }) {
  return (
    <div className="form-group login-field">
      <label htmlFor={id}>{label}</label>
      <div className="login-field__control">
        <input
          id={id}
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required={required}
        />
        {icon && <span className="login-field__icon" aria-hidden>{icon}</span>}
        {trailing}
      </div>
    </div>
  );
}

function gateSelectionLabel(session) {
  if (!session) return 'your access point';
  if (session.scanType === 'department') return eventActionLabel('department', session.eventType);
  return eventActionLabel('gate', session.eventType);
}

function SubmitButton({ submitting, step }) {
  const isUsername = step === 'username';
  return (
    <button type="submit" className={`btn-primary login-submit${submitting ? ' login-submit--loading' : ''}`} disabled={submitting}>
      {submitting ? (
        <span className="login-submit__inner">
          <span className="login-spinner" aria-hidden>
            <span /><span /><span /><span />
          </span>
          <span>{isUsername ? 'Connecting…' : 'Signing in…'}</span>
        </span>
      ) : (
        <span className="login-submit__inner">
          <span>{isUsername ? 'Continue' : 'Sign In'}</span>
          <span className="login-submit__arrow" aria-hidden>{isUsername ? '→' : '🔓'}</span>
        </span>
      )}
    </button>
  );
}

function LoginCard({ wide, submitting, loaderMessage, title, subtitle, step, flow, onStepClick, children, showFooter = true }) {
  return (
    <div className="login-form-panel">
      <div className="login-form-panel__curve login-form-panel__curve--top" aria-hidden />
      <div className="login-form-panel__curve login-form-panel__curve--middle" aria-hidden />
      <div className="login-form-panel__curve login-form-panel__curve--bottom" aria-hidden />
      <div className={`login-card${wide ? ' login-card--wide' : ''}${submitting ? ' login-card--loading' : ''}`}>
        {submitting && (
          <div className="login-card__loader" role="status" aria-live="polite">
            <BotLoader compact message={loaderMessage} />
          </div>
        )}
        <LoginBrand />
        <div className="login-heading">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <LoginSteps step={step} flow={flow} onStepClick={onStepClick} />
        {children}
        {showFooter && <LoginFooter />}
      </div>
    </div>
  );
}

function LoginForm({ deviceFingerprint = '', bootstrapMode = false, geoLocationEnabled = false, ssoError = '' }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, user, logout, loading: authLoading } = useAuth();
  const [step, setStep] = useState('username');
  const [flow, setFlow] = useState('standard');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [accessScope, setAccessScope] = useState(null);
  const [canGateWrite, setCanGateWrite] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState(() => {
    if (ssoError) return ssoError;
    const err = searchParams?.get('error');
    if (err === 'location_blocked') {
      return 'Your session was terminated because you left the authorized location area.';
    }
    if (err === 'after_hours') {
      return 'Your session ended after 9:00 PM. Please sign in again tomorrow.';
    }
    return '';
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (ssoError) setError(ssoError);
  }, [ssoError]);

  useEffect(() => {
    warmBackend();
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved) { setUsername(saved); setRememberMe(true); }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user && !getToken()) return;
    const gateSession = getGateSession();
    if (gateSession) { router.replace(buildEntryExitUrl(gateSession)); return; }
    router.replace(getPostLoginRoute(user));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  function resetToUsername() {
    setStep('username'); setFlow('standard'); setPassword('');
    setDisplayName(''); setAccessScope(null); setError('');
  }

  function handleStepClick(targetStep) {
    if (targetStep === 'username' || targetStep === 'password') {
      if (step === 'gate-select') {
        logout();
      }
      resetToUsername();
    }
  }

  async function handleUsernameContinue(e) {
    e.preventDefault(); setSubmitting(true); setError('');
    try {
      await ensureBackendReady();
      const trimmed = username.trim();
      const result = await api.auth.precheck(trimmed);
      setDisplayName(result.displayName || trimmed);
      try {
        if (rememberMe) localStorage.setItem(REMEMBER_KEY, trimmed);
        else localStorage.removeItem(REMEMBER_KEY);
      } catch { /* ignore */ }

      if (geoLocationEnabled && !result.isSuperAdmin) {
        setStep('geo-verify');
        let geoAllowed = false;
        try {
          const pos = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 10000,
              maximumAge: 0,
            });
          });
          const verifyRes = await api.auth.verifyLocation(
            trimmed,
            pos.coords.latitude,
            pos.coords.longitude,
            pos.coords.accuracy,
            pos.timestamp,
            null,
            deviceFingerprint || null
          );
          if (verifyRes?.ok) {
            geoAllowed = true;
          }
        } catch (err) {
          // If browser GPS fails, times out, or permission is denied (common on desktop workstations),
          // check if this workstation has been Granted Access by an admin
          try {
            const fallbackRes = await api.auth.verifyLocation(
              trimmed,
              null,
              null,
              null,
              null,
              err?.message || 'Geolocation permission denied by browser',
              deviceFingerprint || null
            );
            if (fallbackRes?.ok) {
              geoAllowed = true;
            }
          } catch (fallbackErr) {
            setError(fallbackErr?.message || err?.message || 'Access denied. You are outside the permitted organization location.');
            return;
          }
        }

        if (!geoAllowed) {
          setError('Access denied. You are outside the permitted organization location.');
          return;
        }
      }

      if (result.flow === 'gate') {
        setFlow('gate');
        if (result.accessScope) setAccessScope(result.accessScope);
        setCanGateWrite(result.canGateWrite !== false);
      } else {
        setFlow('standard');
      }
      setStep('password');
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  }

  function handleGateSelect(params) {
    const session = normalizeGateSession(params);
    setGateSession(session);
    router.replace(buildEntryExitUrl(session));
  }

  async function handlePasswordSubmit(e) {
    e.preventDefault(); setSubmitting(true); setError('');
    try {
      await ensureBackendReady();
      const loggedInUser = await login(username.trim(), password, {
        fingerprint: deviceFingerprint || null,
      });

      const isGateUser = flow === 'gate' || hasAssignedEntryExitScope(loggedInUser);
      if (isGateUser) {
        setFlow('gate');
        setPassword('');
        if (!accessScope) {
          try {
            const scope = await api.auth.accessScope();
            setAccessScope(scope);
          } catch { /* ignore */ }
        }
        setStep('gate-select');
        return;
      }

      router.replace(getPostLoginRoute(loggedInUser));
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  }

  if (step === 'gate-select') {
    return (
      <div className="login-shell">
        <LoginHero />
        <LoginCard
          wide submitting={false}
          title={`Hello, ${displayName || username}`}
          subtitle="Select your division and department (or gate) to begin."
          step={step} flow={flow} onStepClick={handleStepClick}
        >
          <div className="login-gate-picker">
            <GateScopePicker
              scope={accessScope} displayName={displayName}
              canGateWrite={canGateWrite} onSelect={handleGateSelect}
              showWelcome={false} compact
            />
          </div>
          <button
            type="button"
            className="login-back-link"
            onClick={() => {
              logout();
              resetToUsername();
            }}
          >
            ← Sign out / Switch user
          </button>
        </LoginCard>
      </div>
    );
  }

  const headingTitle = step === 'username' ? 'Welcome back' : `Hello, ${displayName || username}`;
  const headingSubtitle = step === 'username'
    ? 'Enter your credentials to access your account'
    : step === 'geo-verify' ? 'Verifying location...'
    : 'Enter your password to continue';

  return (
    <div className="login-shell">
      <LoginHero />
      <LoginCard
        submitting={submitting && step !== 'geo-verify'}
        loaderMessage={step === 'username' ? 'Connecting…' : 'Signing in…'}
        title={headingTitle} subtitle={headingSubtitle}
        step={step} flow={flow} onStepClick={handleStepClick}
      >
        <form className="login-form" onSubmit={step === 'username' ? handleUsernameContinue : handlePasswordSubmit}>
          {bootstrapMode && (
            <div className="login-bootstrap-banner" role="note" aria-label="Initial system setup">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <div className="login-bootstrap-banner__body">
                <strong>Initial System Setup</strong>
                <p>
                  No trusted administrator device exists. After successful Super Admin
                  authentication, this computer will become the first trusted device.
                </p>
              </div>
            </div>
          )}
          {step === 'username' && (
            <LoginField id="login-username" label="Username" value={username}
              onChange={(e) => setUsername(e.target.value)} placeholder="Enter your username"
              autoComplete="username" autoFocus required icon={<UserIcon />} />
          )}
          {step === 'geo-verify' && (
            <div className="login-bootstrap-banner" role="status" aria-live="polite">
              <div className="login-spinner" style={{ color: 'var(--primary)', marginRight: '1rem' }} aria-hidden>
                <span /><span /><span /><span />
              </div>
              <div className="login-bootstrap-banner__body">
                <strong>Verifying Location</strong>
                <p>Please wait while we confirm your location.</p>
              </div>
            </div>
          )}
          {step === 'password' && (
            <LoginField id="login-password" label="Password"
              type={showPassword ? 'text' : 'password'} value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password"
              autoComplete="current-password" autoFocus required icon={<LockIcon />}
              trailing={(
                <button type="button" className="login-field__toggle"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}>
                  <EyeIcon open={showPassword} />
                </button>
              )} />
          )}
          {step === 'username' && (
            <label className="login-remember">
              <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
              <span className="login-remember__switch" />
              <span>Remember me</span>
            </label>
          )}
          {step === 'password' && (
            <div className="login-form__actions">
              <label className="login-remember">
                <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
                <span className="login-remember__switch" />
                <span>Remember me</span>
              </label>
              <button type="button" className="login-forgot"
                onClick={() => setError('Please contact your administrator to reset your password.')}>
                Forgot password?
              </button>
            </div>
          )}
          {error && (
            <p className="login-error" role="alert">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {error}
            </p>
          )}
          {step !== 'geo-verify' && <SubmitButton submitting={submitting} step={step} />}
          {(step === 'password' || (step === 'geo-verify' && error)) && (
            <button type="button" className="login-back-link" onClick={() => {
              if (step === 'geo-verify') { resetToUsername(); }
              else if (flow === 'gate') { setPassword(''); setPendingGateSession(null); setStep('gate-select'); setError(''); }
              else { resetToUsername(); }
            }}>
              {step === 'geo-verify' ? '← Back' : flow === 'gate' ? '← Back to gate selection' : '← Change username'}
            </button>
          )}
        </form>
      </LoginCard>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ROOT — Device gate wraps the login form
════════════════════════════════════════════════════════════════ */

/**
 * DeviceGate
 *
 * Runs the device agent check state machine on mount.
 * Only renders <LoginForm> when phase === 'approved'.
 * All other phases show a full-page blocking screen.
 */
function DeviceGate({ geoLocationEnabled }) {
  const { phase, errorMessage, deviceMessage, fingerprint, bootstrapRequired, retry } = useDeviceAgent();

  if (phase === 'checking' || phase === 'fetching_device' || phase === 'validating') {
    return <DeviceCheckingScreen phase={phase} />;
  }

  if (phase === 'not_installed') {
    return <DeviceNotInstalledScreen onRetry={retry} />;
  }

  if (phase === 'agent_error') {
    return <DeviceAgentErrorScreen errorMessage={errorMessage} onRetry={retry} />;
  }

  if (phase === 'pending') {
    // Bootstrap path: no trusted admin device exists yet.
    // Show the login form immediately so the Super Admin can authenticate
    // and trigger the bootstrap approval. A banner explains the situation.
    if (bootstrapRequired) {
      return <LoginForm deviceFingerprint={fingerprint} bootstrapMode geoLocationEnabled={geoLocationEnabled} />;
    }
    return <DevicePendingScreen deviceMessage={deviceMessage} onRetry={retry} />;
  }

  if (phase === 'rejected') {
    return <DeviceRejectedScreen deviceMessage={deviceMessage} onRetry={retry} />;
  }

  if (phase === 'blocked') {
    return <DeviceBlockedScreen deviceMessage={deviceMessage} onRetry={retry} />;
  }

  // phase === 'approved' — render the normal login form
  return <LoginForm deviceFingerprint={fingerprint} geoLocationEnabled={geoLocationEnabled} />;
}

/**
 * LoginPageInner
 *
 * Fetches the deviceMaintenanceEnabled flag from the public settings endpoint.
 * - While loading: shows a spinner screen.
 * - When flag is FALSE: renders LoginForm directly (no Device Agent check).
 * - When flag is TRUE: renders DeviceGate.
 * - If fetch fails after retries: defaults to FALSE (maintenance OFF is the safe
 *   default — the system was designed to work without device validation).
 */
function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { ssoLogin } = useAuth();
  const [ssoVerifying, setSsoVerifying] = useState(false);
  const [ssoError, setSsoError] = useState('');
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(/** @type {boolean|null} */ (null));
  const [geoLocationEnabled, setGeoLocationEnabled] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // 1. Intercept incoming SSO Token from URL
  useEffect(() => {
    const ssoToken =
      searchParams?.get('token') ||
      (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('token') : null);

    if (!ssoToken) return;

    let active = true;

    async function processSSOLogin(token) {
      setSsoVerifying(true);
      setSsoError('');

      try {
        // Preload switcher script for CDN transition and web component compatibility
        if (typeof document !== 'undefined' && !document.getElementById('pydah-portal-switcher-cdn')) {
          const s = document.createElement('script');
          s.id = 'pydah-portal-switcher-cdn';
          s.src = 'https://crm.pydah.edu.in/portal-switcher.js';
          s.async = true;
          document.body.appendChild(s);
        }

        const loggedInUser = await ssoLogin(token);
        if (!active) return;

        // Clean token from address bar
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, document.title, window.location.pathname);
          window.PydahSwitcher?.hideTransition?.();
        }

        const dest = getPostLoginRoute(loggedInUser);
        router.replace(dest);
      } catch (err) {
        console.error('[SAMS-SSO] SSO login failed:', err);
        if (!active) return;
        setSsoError(err.message || 'SSO authentication failed. Please sign in with your credentials.');
        if (typeof window !== 'undefined') {
          window.PydahSwitcher?.hideTransition?.();
        }
      } finally {
        if (active) setSsoVerifying(false);
      }
    }

    processSSOLogin(ssoToken);

    return () => {
      active = false;
    };
  }, [searchParams, ssoLogin, router]);

  useEffect(() => {
    let cancelled = false;

    async function fetchWithRetry(attempts = 3, delayMs = 600) {
      for (let i = 0; i < attempts; i++) {
        try {
          const [devices, geo] = await Promise.all([
            api.devices.publicSettings().catch(() => ({ deviceMaintenanceEnabled: false })),
            api.geoLocations.publicSettings().catch(() => ({ geoLocationEnabled: false }))
          ]);
          if (!cancelled) {
            setMaintenanceEnabled(Boolean(devices?.deviceMaintenanceEnabled));
            setGeoLocationEnabled(Boolean(geo?.geoLocationEnabled));
            setSettingsLoaded(true);
          }
          return;
        } catch {
          if (i < attempts - 1) {
            await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
          }
        }
      }
      // All retries exhausted — default to OFF (no device gate)
      if (!cancelled) {
        setMaintenanceEnabled(false);
        setSettingsLoaded(true);
      }
    }

    fetchWithRetry();
    return () => { cancelled = true; };
  }, []);

  // Show seamless branded loader during SSO verification
  if (ssoVerifying) {
    return (
      <div className="login-shell" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <pydah-sso-loader portal="sams" title="Labour Management (SAMS)"></pydah-sso-loader>
        <div className="device-gate-card" role="status" aria-live="polite" style={{ textAlign: 'center', margin: 'auto' }}>
          <div className="device-gate-card__icon device-gate-card__icon--checking">
            <ClockIcon />
          </div>
          <h2 className="device-gate-card__title">Authenticating via Single Sign-On</h2>
          <p className="device-gate-card__subtitle">Verifying your session with Pydah CRM Gateway…</p>
          <div className="device-gate-card__spinner" aria-hidden="true">
            <span /><span /><span />
          </div>
        </div>
      </div>
    );
  }

  // Show a brief loading state while fetching settings
  if (!settingsLoaded) {
    return (
      <div className="login-shell">
        <LoginHero />
        <GatePanel>
          <div className="device-gate-card" role="status" aria-live="polite" aria-label="Loading…">
            <div className="device-gate-card__icon device-gate-card__icon--checking">
              <ClockIcon />
            </div>
            <h2 className="device-gate-card__title">Loading…</h2>
            <div className="device-gate-card__spinner" aria-hidden="true">
              <span /><span /><span />
            </div>
          </div>
        </GatePanel>
      </div>
    );
  }

  // Device Maintenance Mode is OFF — skip the Device Agent entirely
  if (!maintenanceEnabled) {
    return <LoginForm deviceFingerprint={null} geoLocationEnabled={geoLocationEnabled} ssoError={ssoError} />;
  }

  // Device Maintenance Mode is ON — run the full DeviceGate workflow
  return <DeviceGate geoLocationEnabled={geoLocationEnabled} />;
}

export default function LoginPage() {
  return (
    <Suspense fallback={<BotLoader message="Preparing login…" />}>
      <LoginPageInner />
    </Suspense>
  );
}
