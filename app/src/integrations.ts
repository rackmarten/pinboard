// every integration is optional. Startup logs one line per
// integration saying whether it is on, so a missing value shows up as a
// plain "off" line instead of an error the first time something tries it.

export interface IntegrationConfig {
  smtp: { host: string; user: string; pass: string };
  ntfy: { url: string; token: string };
  rootGrants: { proxySecret: string; operatorIps: string[] };
}

export interface IntegrationStatus {
  name: string;
  enabled: boolean;
  line: string;
}

export function integrationStatus(cfg: IntegrationConfig): IntegrationStatus[] {
  const mail = Boolean(cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass);
  const push = Boolean(cfg.ntfy.url && cfg.ntfy.token);
  const grants = Boolean(cfg.rootGrants.proxySecret && cfg.rootGrants.operatorIps.length > 0);
  return [
    {
      name: "mail",
      enabled: mail,
      line: mail ? "mail: daily digest on" : "mail: off (set SMTP_HOST, SMTP_USER, SMTP_PASS to send the daily digest)",
    },
    {
      name: "push",
      enabled: push,
      line: push ? "push: ntfy on" : "push: off (set NTFY_URL and NTFY_TOKEN_PINBOARD for phone notifications)",
    },
    {
      name: "root-grants",
      enabled: grants,
      line: grants
        ? "root grants: on"
        : "root grants: off (set PINBOARD_PROXY_SECRET and OPERATOR_DEVICE_IPS behind a reverse proxy to enable)",
    },
  ];
}
