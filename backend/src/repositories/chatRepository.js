import { listBusinessNumbers, toPublicBusinessNumber } from './businessRepository.js';
import { listCampaigns } from './campaignRepository.js';

export * from './businessRepository.js';
export * from './contactRepository.js';
export * from './conversationRepository.js';
export * from './messageRepository.js';
export * from './settingsRepository.js';
export * from './contactListRepository.js';
export * from './campaignRepository.js';
export * from './leadOpsRepository.js';

export async function getBootstrapData() {
  const [businessNumbers, campaigns] = await Promise.all([
    listBusinessNumbers(),
    listCampaigns(8),
  ]);
  return {
    businessNumbers: businessNumbers.map(toPublicBusinessNumber),
    campaigns,
    defaultPhoneNumberId: businessNumbers.find((number) => number.isDefault)?.id || businessNumbers[0]?.id || null,
  };
}
