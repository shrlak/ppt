// The app currently has one shared administrator account rather than user
// accounts. Keep the client-side soft gate and Worker write credential in one
// place so 관리자 설정 and cross-device library writes cannot drift apart.
export const ADMIN_PASSWORD = 'kccpmedia1980';
export const ADMIN_UNLOCK_KEY = 'kccp-admin-unlocked';
