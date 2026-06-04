import { Lock, LogOut, Mail, RefreshCw, ShieldCheck, Smartphone, User } from 'lucide-react';
import type { FormEvent } from 'react';
import type { AuthStatus } from '../types';

type AuthMode = 'login' | 'register';

type AuthScreenProps = {
  mode: AuthMode;
  name: string;
  email: string;
  password: string;
  rememberMe: boolean;
  loading: boolean;
  error: string;
  onModeChange: (mode: AuthMode) => void;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onRememberMeChange: (value: boolean) => void;
  onSubmit: () => void;
};

type PendingDeviceScreenProps = {
  authStatus: AuthStatus;
  loading: boolean;
  onRefresh: () => void;
  onLogout: () => void;
};

export function AuthScreen({
  mode,
  name,
  email,
  password,
  rememberMe,
  loading,
  error,
  onModeChange,
  onNameChange,
  onEmailChange,
  onPasswordChange,
  onRememberMeChange,
  onSubmit,
}: AuthScreenProps) {
  const isRegister = mode === 'register';

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-label={isRegister ? 'Register' : 'Login'}>
        <div className="auth-brand">
          <span className="auth-brand__logo">JJE</span>
          <div>
            <p>Jay Jalaram Enterprise</p>
            <h1>{isRegister ? 'Create access' : 'Sign in'}</h1>
          </div>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isRegister && (
            <label className="auth-field">
              <span>Name</span>
              <div>
                <User size={18} />
                <input
                  value={name}
                  onChange={(event) => onNameChange(event.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>
            </label>
          )}

          <label className="auth-field">
            <span>Email</span>
            <div>
              <Mail size={18} />
              <input
                value={email}
                onChange={(event) => onEmailChange(event.target.value)}
                placeholder="you@example.com"
                type="email"
                autoComplete="email"
              />
            </div>
          </label>

          <label className="auth-field">
            <span>Password</span>
            <div>
              <Lock size={18} />
              <input
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                placeholder="Password"
                type="password"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
              />
            </div>
          </label>

          <label className="auth-remember">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => onRememberMeChange(event.target.checked)}
            />
            <span>Remember me on this device</span>
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? 'Checking...' : isRegister ? 'Register' : 'Login'}
          </button>
        </form>

        <button
          className="auth-switch"
          type="button"
          onClick={() => onModeChange(isRegister ? 'login' : 'register')}
        >
          {isRegister ? 'Already have access? Login' : 'Need access? Register this device'}
        </button>
      </section>
    </main>
  );
}

export function PendingDeviceScreen({ authStatus, loading, onRefresh, onLogout }: PendingDeviceScreenProps) {
  const device = authStatus.device;
  const isBlocked = device?.status === 'blocked';

  return (
    <main className="auth-shell">
      <section className="auth-card auth-card--device">
        <div className="auth-device-icon">
          {isBlocked ? <Lock size={32} /> : <Smartphone size={34} />}
        </div>

        <h1>{isBlocked ? 'Device blocked' : 'Waiting for admin approval'}</h1>
        <p>
          {isBlocked
            ? 'This device is blocked. Ask an admin to approve or unblock it from the device list.'
            : 'This browser is registered, but it is not approved yet. Share the device code below with the admin.'}
        </p>

        <div className="auth-device-code">
          <span>Device ID</span>
          <strong>{device?.deviceCode || 'JJE-PENDING'}</strong>
        </div>

        <div className="auth-device-meta">
          <span>{authStatus.user?.name || authStatus.user?.email}</span>
          <span>{device?.deviceName || 'Browser device'}</span>
          <span>Status: {device?.status || 'pending'}</span>
        </div>

        <div className="auth-device-actions">
          <button type="button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={18} />
            <span>{loading ? 'Refreshing...' : 'Refresh'}</span>
          </button>
          <button type="button" onClick={onLogout}>
            <LogOut size={18} />
            <span>Logout</span>
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
        <h1>Checking access</h1>
        <p>Loading your login and approved device status.</p>
        <div className="auth-loading-lines">
          <span />
          <span />
          <span />
        </div>
      </section>
    </main>
  );
}
