import { closePool } from '../src/config/db.js';
import { input, query, sql } from '../src/repositories/sqlHelpers.js';
import { hashPassword } from '../src/services/authService.js';

const email = String(process.env.JJE_ADMIN_EMAIL || '').trim().toLowerCase();
const displayName = String(process.env.JJE_ADMIN_DISPLAY_NAME || 'JJE Administrator').trim();
const password = String(process.env.JJE_ADMIN_PASSWORD || '');

if (!email || !email.includes('@')) throw new Error('Set JJE_ADMIN_EMAIL to a valid email address.');
if (!displayName || displayName.length > 160) throw new Error('JJE_ADMIN_DISPLAY_NAME must be 1-160 characters.');
if (password.length < 12 || password.length > 256) throw new Error('JJE_ADMIN_PASSWORD must be 12-256 characters.');

try {
  const result = await query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @userId bigint, @roleId smallint;
    SELECT @roleId = role_id FROM jje.roles WHERE role_key = 'admin';
    IF @roleId IS NULL THROW 51030, 'Admin role is missing. Apply database migrations.', 1;
    SELECT @userId = user_id FROM jje.users WITH (UPDLOCK, HOLDLOCK) WHERE LOWER(email) = @email;
    IF @userId IS NULL
    BEGIN
      INSERT jje.users(display_name, email, password_hash) VALUES(@displayName, @email, @passwordHash);
      SET @userId = SCOPE_IDENTITY();
    END
    ELSE UPDATE jje.users SET display_name = @displayName, password_hash = @passwordHash,
      status = 'active', updated_at = SYSUTCDATETIME() WHERE user_id = @userId;
    IF NOT EXISTS (SELECT 1 FROM jje.user_roles WHERE user_id = @userId AND role_id = @roleId)
      INSERT jje.user_roles(user_id, role_id) VALUES(@userId, @roleId);
    DELETE jje.sessions WHERE user_id = @userId;
    COMMIT TRANSACTION;
    SELECT @userId AS user_id;`, [
    input('email', sql.NVarChar(320), email),
    input('displayName', sql.NVarChar(160), displayName),
    input('passwordHash', sql.NVarChar(500), hashPassword(password)),
  ]);
  console.log(JSON.stringify({ ok: true, userId: Number(result.recordset[0].user_id), email }));
} finally {
  await closePool();
}
