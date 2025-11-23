import { writable } from 'svelte/store';

export type NotificationType = 'success' | 'error' | 'info' | 'warning';

export interface Notification {
  id: number;
  message: string;
  type: NotificationType;
  duration?: number;
}

function createNotificationStore() {
  const { subscribe, update } = writable<Notification[]>([]);
  let nextId = 1;

  return {
    subscribe,
    show(message: string, type: NotificationType = 'info', duration: number = 3000) {
      const id = nextId++;
      const notification: Notification = { id, message, type, duration };

      update(notifications => [...notifications, notification]);

      if (duration > 0) {
        setTimeout(() => {
          this.dismiss(id);
        }, duration);
      }

      return id;
    },
    dismiss(id: number) {
      update(notifications => notifications.filter(n => n.id !== id));
    },
    clear() {
      update(() => []);
    }
  };
}

export const notifications = createNotificationStore();
