import { TFunction } from 'i18next';

export const formatTimeAgo = (dateString: string, currentTime: Date, t: TFunction) => {
  const date = new Date(dateString);
  const now = currentTime;

  // Check if date is valid
  if (isNaN(date.getTime())) {
    return t ? t('status.unknown') : 'Unknown';
  }

  const diffInMs = now.getTime() - date.getTime();
  const diffInSeconds = Math.floor(diffInMs / 1000);
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInSeconds < 60) return t ? t('time.justNow') : 'Just now';
  if (diffInMinutes === 1) return t ? t('time.oneMinuteAgo') : '1 min ago';
  if (diffInMinutes < 60) return t ? t('time.minutesAgo', { count: diffInMinutes }) : `${diffInMinutes} mins ago`;
  if (diffInHours === 1) return t ? t('time.oneHourAgo') : '1 hour ago';
  if (diffInHours < 24) return t ? t('time.hoursAgo', { count: diffInHours }) : `${diffInHours} hours ago`;
  if (diffInDays === 1) return t ? t('time.oneDayAgo') : '1 day ago';
  if (diffInDays < 7) return t ? t('time.daysAgo', { count: diffInDays }) : `${diffInDays} days ago`;
  return date.toLocaleDateString();
};

/**
 * WhatsApp-style chat timestamp: recent messages show how long ago ("Just now",
 * "5 mins ago", "2 hours ago"); older ones anchor to the calendar ("Yesterday
 * 14:32", "Mon 09:10" within the last week, "12.08.2026 09:10" beyond). Keys
 * come from the `common` namespace's `time` block; weekday/date rendering is
 * locale-aware via toLocale*String.
 */
export const formatMessageTimestamp = (
  timestamp: string | number | Date | undefined,
  currentTime: Date,
  t?: TFunction,
): string => {
  if (timestamp === undefined || timestamp === null || timestamp === '') return '';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '';

  const shortTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const diffInMs = currentTime.getTime() - date.getTime();
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(currentTime) - startOfDay(date)) / (1000 * 60 * 60 * 24));

  // Clock-skew / same-minute sends land here too.
  if (diffInMs < 60 * 1000) return t ? t('time.justNow') : 'Just now';
  if (dayDiff <= 0) {
    if (diffInMinutes < 60) return t ? t('time.minutesAgo', { count: diffInMinutes }) : `${diffInMinutes} mins ago`;
    return t ? t('time.hoursAgo', { count: diffInHours }) : `${diffInHours} hours ago`;
  }
  if (dayDiff === 1) return `${t ? t('time.yesterday') : 'Yesterday'} ${shortTime}`;
  if (dayDiff < 7) return `${date.toLocaleDateString([], { weekday: 'short' })} ${shortTime}`;
  return `${date.toLocaleDateString()} ${shortTime}`;
};