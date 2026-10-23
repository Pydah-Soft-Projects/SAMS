'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { isSsoSession, getToken, getStoredUser } from '@/lib/auth/session';

const SCRIPT_ID = 'pydah-portal-switcher-cdn';
const PORTAL_ID = 'sams';
const CDN_URL = 'https://crm.pydah.edu.in/portal-switcher.js';
const CRM_BASE_URL =
  process.env.NEXT_PUBLIC_CRM_URL ||
  (typeof window !== 'undefined' && window.location?.hostname === 'localhost'
    ? 'http://localhost:8000'
    : 'https://crm.pydah.edu.in');

/**
 * Pydah Universal Portal Switcher Widget.
 *
 * Strict Requirement:
 * ONLY render the portal switcher if the user logged in via SSO.
 * If logged in via standard credentials (or logged out), all switcher
 * scripts and DOM elements are cleanly removed.
 */
export default function PortalSwitcher() {
  const pathname = usePathname();
  const { user, isSSO: authIsSSO } = useAuth();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || typeof window === 'undefined') return;

    // SSO status: verify both auth context and persistent session flags
    const ssoActive = Boolean(authIsSSO || isSsoSession() || user?.isSSO);

    // Public / unauthenticated routes
    const isPublicRoute =
      !pathname ||
      pathname === '/login' ||
      pathname.startsWith('/login/') ||
      pathname === '/register' ||
      pathname.startsWith('/register/') ||
      pathname.startsWith('/registrations/register') ||
      pathname.startsWith('/qr/') ||
      pathname.startsWith('/passes/verify/');

    const currentToken = getToken();
    const currentUser = user || getStoredUser();

    // STRICT CHECK: user must be authenticated AND session must be an SSO session
    const shouldShow = Boolean(ssoActive && currentUser && currentToken && !isPublicRoute);

    const cleanupSwitcher = () => {
      const switcher = window.PydahSwitcher || window.PydahPortalSwitcher;
      if (switcher?.close) {
        try {
          switcher.close();
        } catch (_) {}
      }

      // Hide and remove any custom web component elements created by the switcher
      const customElements = document.querySelectorAll(
        'pydah-portal-switcher, portal-switcher, [data-pydah-switcher], #pydah-portal-switcher, .pydah-switcher-host'
      );
      customElements.forEach((el) => {
        el.style.display = 'none';
        try {
          el.remove();
        } catch (_) {}
      });

      // Remove the script tag so it doesn't linger for non-SSO sessions
      const existingScript = document.getElementById(SCRIPT_ID);
      if (existingScript) {
        try {
          existingScript.remove();
        } catch (_) {}
      }
    };

    if (!shouldShow) {
      cleanupSwitcher();
      return;
    }

    // SSO user on an authenticated route -> mount & initialize widget
    const customElements = document.querySelectorAll(
      'pydah-portal-switcher, portal-switcher, [data-pydah-switcher], #pydah-portal-switcher, .pydah-switcher-host'
    );
    customElements.forEach((el) => {
      el.style.display = '';
    });

    let script = document.getElementById(SCRIPT_ID);
    if (!script) {
      script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = CDN_URL;
      script.async = true;
      script.setAttribute('data-current-portal', PORTAL_ID);
      script.setAttribute('data-api-base-url', CRM_BASE_URL);
      script.setAttribute('data-position', 'bottom-right');

      script.onload = () => {
        if (window.PydahSwitcher) {
          try {
            if (typeof window.PydahSwitcher.init === 'function') {
              window.PydahSwitcher.init({
                currentPortal: PORTAL_ID,
                token: currentToken,
                user: currentUser,
                position: 'bottom-right',
                apiBaseUrl: CRM_BASE_URL,
                landingUrl: CRM_BASE_URL,
              });
            }
          } catch (e) {
            console.warn('[PortalSwitcher] init error:', e);
          }
        }
      };

      document.body.appendChild(script);
    } else {
      // Script already present; refresh session or re-init
      if (window.PydahSwitcher) {
        try {
          if (typeof window.PydahSwitcher.setSession === 'function') {
            window.PydahSwitcher.setSession({
              token: currentToken,
              user: currentUser,
            });
          } else if (typeof window.PydahSwitcher.init === 'function') {
            window.PydahSwitcher.init({
              currentPortal: PORTAL_ID,
              token: currentToken,
              user: currentUser,
              position: 'bottom-right',
              apiBaseUrl: CRM_BASE_URL,
              landingUrl: CRM_BASE_URL,
            });
          }
        } catch (e) {
          console.warn('[PortalSwitcher] session update error:', e);
        }
      }
    }

    return () => {
      if (!shouldShow) {
        cleanupSwitcher();
      }
    };
  }, [mounted, pathname, user, authIsSSO]);

  return null;
}
