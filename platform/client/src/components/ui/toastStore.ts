import { create } from 'zustand';

export interface IToast {
  id: string;
  title: string;
  description?: string;
  variant?: 'default' | 'success' | 'warning' | 'error';
  duration?: number | null;
  /** Optional inline action rendered as a text button under the message. */
  action?: { label: string; onClick: () => void };
}

interface IToastStore {
  toasts: IToast[];
  addToast: (toast: Omit<IToast, 'id'>) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<IToastStore>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = Math.random().toString(36).slice(2, 9);
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
  },
  removeToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  },
}));

export function toast(opts: Omit<IToast, 'id'>): void {
  useToastStore.getState().addToast(opts);
}
