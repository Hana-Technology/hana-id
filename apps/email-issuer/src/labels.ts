// The env labels of user mail's HTML banner (D419, D670), in a module without Worker types so the scripts' tests can
// import it.

/** The labels `ENV_LABEL` may hold; the same list as `@hana-id/env` `ENV_ALERT_LABELS` (a scripts test keeps them equal). */
export const MAIL_LABELS = ['[SANDBOX]', '[STAGING]', '[LOCAL]', '[TESTNET]'] as const;
