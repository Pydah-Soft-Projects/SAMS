import { AuthProvider } from '@/components/AuthProvider';
import LayoutShell from '@/components/LayoutShell';
import PwaShell from '@/components/PwaShell';
import PortalSwitcher from '@/components/PortalSwitcher';
import './globals.css';
import '../styles/admin-dashboard.css';

export const metadata = {
  title: 'SAMS - Smart Access Management System',
  description: 'Dynamic role-based registration with face verification and gate access',
  manifest: '/manifest.webmanifest',
  applicationName: 'SAMS',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'SAMS',
  },
  icons: {
    icon: '/favicon.png',
    apple: '/icons/apple-touch-icon.png',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#1A56FF',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="mobile-web-app-capable" content="yes" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){if(typeof window==='undefined')return;window.__SMAS_DEFERRED_PWA_PROMPT__=null;window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__SMAS_DEFERRED_PWA_PROMPT__=e;window.dispatchEvent(new Event('sams-pwa-installable'));});window.addEventListener('appinstalled',function(){window.__SMAS_DEFERRED_PWA_PROMPT__=null;window.dispatchEvent(new Event('sams-pwa-installable'));});})();`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>
        <AuthProvider>
          <PortalSwitcher />
          <PwaShell />
          <LayoutShell>{children}</LayoutShell>
        </AuthProvider>
      </body>
    </html>
  );
}
