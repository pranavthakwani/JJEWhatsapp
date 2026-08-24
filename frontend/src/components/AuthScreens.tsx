import { KeyRound, Lock, LogIn, Mail, RefreshCw, RotateCcw, ShieldCheck, Smartphone } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
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

type LoginScreenProps = {
  loading: boolean;
  error?: string;
  onLogin: (email: string, password: string, remember: boolean) => Promise<void>;
};

type AuthUnavailableScreenProps = {
  loading: boolean;
  error?: string;
  onRefresh: () => void;
};

export function AuthUnavailableScreen({ loading, error = '', onRefresh }: AuthUnavailableScreenProps) {
  return (
    <main className="auth-shell">
      <section className="auth-card auth-card--device">
        <div className="auth-device-icon"><RotateCcw size={32} /></div>
        <h1>Application service unavailable</h1>
        <p>
          Device approval is disabled. The backend could not reach the Kore_Demo SQL Server,
          so WhatsApp data cannot be loaded yet.
        </p>
        {error && <div className="form-error">{error}</div>}
        <div className="auth-device-actions">
          <button type="button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={18} />
            <span>{loading ? 'Checking...' : 'Try again'}</span>
          </button>
        </div>
      </section>
    </main>
  );
}

export function LoginScreen({ loading, error = '', onLogin }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onLogin(email, password, remember);
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand__logo"><ShieldCheck size={28} /></div>
          <div><p>Jay Jalaram Enterprise</p><h1>Sign in</h1></div>
        </div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label className="auth-field">
            <span>Email</span>
            <div><Mail size={18} /><input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
          </label>
          <label className="auth-field">
            <span>Password</span>
            <div><KeyRound size={18} /><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
          </label>
          <label className="auth-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /><span>Keep me signed in</span></label>
          {error && <p className="auth-error">{error}</p>}
          <button className="auth-submit" type="submit" disabled={loading || !email || !password}>
            <LogIn size={18} /> {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}
