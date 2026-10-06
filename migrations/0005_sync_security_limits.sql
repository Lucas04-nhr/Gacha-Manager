-- Short-lived hashed abuse counters only; no account, record or credential data.
CREATE TABLE sync_security_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX sync_security_limits_window ON sync_security_limits(window);
