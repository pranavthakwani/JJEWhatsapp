import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { env } from './env.js';

let adminClient;

export function getAdminClient() {
  if (!adminClient) {
    adminClient = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      realtime: {
        transport: ws,
      },
    });
  }

  return adminClient;
}
