import notifier from 'node-notifier';

export type GestaltNotifyEvent =
  | 'tasks_completed'
  | 'evaluation_success'
  | 'evaluation_failed'
  | 'structural_failed'
  | 'human_escalation'
  | 'terminated'
  | 'interview_complete'
  | 'spec_generated';

interface NotifyOptions {
  event: GestaltNotifyEvent;
  message: string;
  title?: string;
}

export function gestaltNotify(options: NotifyOptions): void {
  try {
    notifier.notify({
      title: options.title ?? 'Gestalt',
      message: options.message,
      sound: true,
      wait: false,
    });
  } catch {
    // Notification failure must not affect the pipeline
  }
}
