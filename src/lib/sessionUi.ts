export type SessionCardState = {
  session_id: number;
  status: 'running' | 'paused' | 'ended';
  remaining_seconds: number;
  current_app_name?: string | null;
  current_app_package?: string;
  app_name?: string | null;
  app_package?: string;
  is_expired?: boolean;
};

export function formatRemainingTime(totalSeconds?: number | null) {
  const safeSeconds = Math.max(0, Number(totalSeconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function getSessionUiState(session?: SessionCardState | null) {
  if (!session || session.status === 'ended') {
    return {
      headline: null,
      subline: 'No active user session',
      canPause: false,
      canResume: false,
      canStop: false,
      canSwitch: false,
    };
  }

  if (session.status === 'paused') {
    return {
      headline: formatRemainingTime(session.remaining_seconds),
      subline: 'Paused',
      canPause: false,
      canResume: true,
      canStop: true,
      canSwitch: true,
    };
  }

  return {
    headline: formatRemainingTime(session.remaining_seconds),
    subline: session.is_expired ? 'Running User Session · Overtime' : 'Running User Session',
    canPause: true,
    canResume: false,
    canStop: true,
    canSwitch: true,
  };
}
