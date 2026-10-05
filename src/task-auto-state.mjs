export function hasJobTotpKey(job) {
  return Boolean(job?.totpSecret || job?.hasTotpCredential);
}

export function isTotpRotationComplete(job) {
  return Boolean(
    job?.status === "completed"
      && job?.lastOperationType === "replace_2fa"
      && hasJobTotpKey(job)
      && !job?.totpRotationIncomplete,
  );
}

export function isReauthorizationComplete(job) {
  return Boolean(
    job?.status === "completed"
      && job?.lastOperationType === "relogin"
      && job?.resultSaved,
  );
}
