import { Lock, RefreshCw, RotateCcw, ShieldCheck, Smartphone } from 'lucide-react';
import type { AuthStatus } from '../types';

type PendingDeviceScreenProps = {
  authStatus: AuthStatus;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onResetDevice: () => void;
};

export function PendingDeviceScreen({ authStatus, loading, error = '', onRefresh, onResetDevice }: PendingDeviceScreenProps) {
  const device = authStatus.device;
  const isBlocked = device?.status === 'blocked';

  return (
    <main className="auth-shell">
      <section className="auth-card auth-card--device">
        <div className="auth-device-icon">
          {isBlocked ? <Lock size={32} /> : <Smartphone size={34} />}
        </div>

        <h1>{isBlocked ? 'Device blocked' : 'Waiting for device approval'}</h1>
        <p>
          {isBlocked
            ? 'This browser is blocked. Ask the admin to unblock or approve it from an already approved device.'
            : 'This browser is registered, but it is not approved yet. Share the device ID below with the admin.'}
        </p>

        <div className="auth-device-code">
          <span>Device ID</span>
          <strong>{device?.deviceCode || 'JJE-PENDING'}</strong>
        </div>

        <div className="auth-device-meta">
          <span>{device?.deviceName || 'Browser device'}</span>
          <span>{device?.ipAddress || 'IP not available'}</span>
          <span>Status: {device?.status || 'pending'}</span>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="auth-device-actions">
          <button type="button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={18} />
            <span>{loading ? 'Refreshing...' : 'Refresh'}</span>
          </button>
          <button type="button" onClick={onResetDevice}>
            <RotateCcw size={18} />
            <span>Reset device</span>
          </button>
        </div>
      </section>
    </main>
  );
}

export function AuthLoadingScreen() {
  return (
    <main className="auth-shell">
      <section className="auth-card auth-card--device">
        <div className="auth-device-icon">
          <ShieldCheck size={34} />
        </div>
        <h1>Checking device</h1>
        <p>Checking this browser device against the approved device list.</p>
        <div className="auth-loading-lines">
          <span />
          <span />
          <span />
        </div>
      </section>
    </main>
  );
}
