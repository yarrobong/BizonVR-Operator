export function checkAdbRecoveryPermission() {
  return {
    allowed: false,
    status: 'permission_missing',
    message: 'WRITE_SECURE_SETTINGS recovery is not configured on this Local Hub yet.',
  };
}

export async function tryEnableWirelessAdb() {
  return {
    success: false,
    status: 'permission_missing',
    message: 'Wireless ADB recovery adapter is not configured.',
  };
}

export function reportAdbRecoveryStatus(permission = checkAdbRecoveryPermission(), attempt = null) {
  return {
    permission: permission.allowed ? 'granted' : 'missing',
    status: attempt?.status || permission.status || 'permission_missing',
    message: attempt?.message || permission.message || 'ADB recovery permission is missing.',
    updated_at: new Date().toISOString(),
  };
}
