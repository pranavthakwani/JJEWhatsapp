import { CheckCircle2, RefreshCw, ShieldAlert, Smartphone, X } from 'lucide-react';
import type { AuthDevice } from '../types';

type Props = {
  open: boolean;
  devices: AuthDevice[];
  loading: boolean;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
  onUpdateStatus: (deviceId: number, status: 'pending' | 'approved' | 'blocked') => void;
};

function formatDateTime(value: string | null) {
  if (!value) return 'not seen';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).toLowerCase();
}

function normalizedStatus(status: string) {
  return ['approved', 'blocked'].includes(status) ? status : 'pending';
}

function statusLabel(status: string) {
  if (status === 'approved') return 'Approved';
  if (status === 'blocked') return 'Blocked';
  return 'Pending';
}

export function DeviceManagerDialog({ open, devices, loading, error, onClose, onRefresh, onUpdateStatus }: Props) {
  if (!open) return null;

  return (
    <div className="modal-backdrop auth-modal-backdrop" role="presentation">
      <section className="device-manager" role="dialog" aria-modal="true" aria-label="Device access">
        <header className="device-manager__header">
          <div>
            <p>Device access</p>
            <h2>Approved devices</h2>
          </div>
          <div className="device-manager__header-actions">
            <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh devices">
              <RefreshCw size={18} />
            </button>
            <button type="button" onClick={onClose} aria-label="Close device manager">
              <X size={20} />
            </button>
          </div>
        </header>

        {error && <p className="device-manager__error">{error}</p>}

        <div className="device-manager__list">
          {loading && devices.length === 0 ? (
            <div className="device-manager__skeleton">
              <span />
              <span />
              <span />
            </div>
          ) : devices.length === 0 ? (
            <div className="device-manager__empty">No devices registered yet.</div>
          ) : (
            devices.map((device) => {
              const status = normalizedStatus(device.status);

              return (
                <article key={device.id} className={`device-row is-${status}`}>
                  <span className="device-row__icon">
                    <Smartphone size={20} />
                  </span>

                  <div className="device-row__copy">
                    <div className="device-row__title">
                      <strong>{device.deviceName || 'Browser device'}</strong>
                      {device.isCurrent && <em>Current login</em>}
                    </div>

                    <div className="device-row__meta">
                      <span className="device-row__code">ID: {device.deviceCode}</span>
                      <span className={`device-row__status is-${status}`}>{statusLabel(device.status)}</span>
                    </div>

                    <span>{device.ipAddress || 'No IP'} | last seen {formatDateTime(device.lastSeenAt)}</span>
                    <small>{statusLabel(device.status)}{device.approvedBy ? ` by ${device.approvedBy}` : ''}</small>
                  </div>

                  <div className="device-row__actions">
                    {device.status !== 'approved' && (
                      <button type="button" onClick={() => onUpdateStatus(device.id, 'approved')}>
                        <CheckCircle2 size={16} />
                        <span>Allow</span>
                      </button>
                    )}
                    {device.status !== 'blocked' && (
                      <button type="button" onClick={() => onUpdateStatus(device.id, 'blocked')}>
                        <ShieldAlert size={16} />
                        <span>Block</span>
                      </button>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
