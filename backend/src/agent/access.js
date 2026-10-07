import { env } from '../config/env.js';

// Shared-admin mode has no accounts. Audit/claims identify the browser device,
// not a person. The existing application/device access boundary still applies.
export function canReviewAgent(auth) {
  return env.features.agentSharedAdminAccess
    ? Boolean(auth?.device?.id)
    : Boolean(auth?.user?.roles?.some(role=>['admin','operator'].includes(role)));
}
export function canManageAgent(auth) {
  return env.features.agentSharedAdminAccess
    ? Boolean(auth?.device?.id)
    : Boolean(auth?.user?.roles?.includes('admin'));
}
export function requestActor(auth) {
  return env.features.agentSharedAdminAccess
    ? {key:`device:${auth.device.id}`,userId:null}
    : auth.user.id;
}
export function actorUserId(actor) { return typeof actor==='number'?actor:actor?.userId??null; }
export function actorKey(actor) {
  if(typeof actor==='number'&&Number.isSafeInteger(actor)&&actor>0)return `user:${actor}`;
  if(typeof actor?.key==='string'&&/^device:[1-9][0-9]*$/.test(actor.key))return actor.key;
  throw new Error('A valid review actor is required.');
}
