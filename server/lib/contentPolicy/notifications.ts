import type { Notification } from '@server/lib/notifications';
import notificationManager from '@server/lib/notifications';

export const sendContentPolicyNotification = (
  type:
    | Notification.CONTENT_POLICY_FAILURE
    | Notification.CONTENT_POLICY_BREAK_GLASS
    | Notification.CONTENT_POLICY_DIGEST,
  subject: string,
  message: string
): void => {
  notificationManager.sendNotification(type, {
    event: 'Seerr Content Policy',
    subject,
    message,
    notifyAdmin: true,
    notifySystem: true,
  });
};
