// The env labels of email subjects (D419), in a module without Worker types so the scripts' tests can import it.

/** The labels `ENV_LABEL` may hold; the same list as `@hana-id/env` `ENV_ALERT_LABELS` (a scripts test keeps them equal). */
export const MAIL_LABELS = ['[SANDBOX]', '[STAGING]', '[LOCAL]', '[TESTNET]'] as const;
