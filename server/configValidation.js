// Validation of querydog.yml. Returns every problem found so a broken config
// is reported in one go at startup, with the path of each bad key.

const TOP_KEYS = ['client', 'organisation_name', 'folders', 'scheduler', 'auth', 'environments'];
const AUTH_KEYS = ['users'];
const AUTH_USER_KEYS = ['username', 'password_hash'];
const FOLDER_KINDS = ['monitoring', 'alerts', 'performance', 'dataquality'];
const ENV_KEYS = [
  'name', 'organisation_name', 'organisation', 'environment', 'host', 'port', 'user', 'password', 'database', 'secure',
  'tls_reject_unauthorized', 'cluster', 'cluster_name', 'queries_folder', 'http_headers', 'deployment',
  'cloud_api', 'scheduler', 'default', '_embeddedId',
];
const CLOUD_API_KEYS = ['key_id', 'key_secret', 'organization_id', 'service_id'];
const CLOUD_API_REQUIRED = ['key_id', 'key_secret', 'organization_id'];
const SCHEDULER_KEYS = ['enabled', 'environments', 'jobs'];
const JOB_NAMES = ['monitoring', 'dataquality', 'performance', 'recommendations'];
const JOB_KEYS = ['every', 'enabled', 'include', 'exclude'];
const EVERY_RE = /^\d+\s*(s|m|h|d)$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim() !== '';
const isStringList = v => typeof v === 'string' || (Array.isArray(v) && v.every(x => typeof x === 'string'));

function unknownKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}" (expected one of: ${allowed.join(', ')})`);
  }
}

function checkJobs(jobs, where, errors) {
  if (!isObject(jobs)) {
    errors.push(`${where} must be a mapping of job name to settings`);
    return;
  }
  unknownKeys(jobs, JOB_NAMES, where, errors);
  for (const [name, job] of Object.entries(jobs)) {
    if (!JOB_NAMES.includes(name) || typeof job === 'boolean') continue;
    if (!isObject(job)) {
      errors.push(`${where}.${name} must be true, false or a mapping`);
      continue;
    }
    unknownKeys(job, JOB_KEYS, `${where}.${name}`, errors);
    if (job.every !== undefined && !EVERY_RE.test(String(job.every).trim())) errors.push(`${where}.${name}.every "${job.every}" must look like 30s, 5m, 1h or 1d`);
    if (job.enabled !== undefined && typeof job.enabled !== 'boolean') errors.push(`${where}.${name}.enabled must be true or false`);
    for (const list of ['include', 'exclude']) {
      if (job[list] !== undefined && !isStringList(job[list])) errors.push(`${where}.${name}.${list} must be a name pattern or a list of them`);
    }
  }
}

export function validateConfig(raw) {
  const errors = [];
  if (!isObject(raw)) return ['querydog.yml must be a mapping with an environments list'];
  unknownKeys(raw, TOP_KEYS, 'top level', errors);

  if (raw.client !== undefined && !isText(raw.client)) errors.push('client must be a folder name');
  if (raw.auth !== undefined && raw.auth !== null) {
    if (!isObject(raw.auth)) errors.push('auth must be a mapping with a users list');
    else {
      unknownKeys(raw.auth, AUTH_KEYS, 'auth', errors);
      if (raw.auth.users !== undefined && raw.auth.users !== null && !Array.isArray(raw.auth.users)) errors.push('auth.users must be a list');
      (Array.isArray(raw.auth.users) ? raw.auth.users : []).forEach((u, i) => {
        const where = `auth.users[${i}]`;
        if (!isObject(u)) { errors.push(`${where} must be a mapping with username and password_hash`); return; }
        unknownKeys(u, AUTH_USER_KEYS, where, errors);
        if (!isText(u.username)) errors.push(`${where}.username is required`);
        if (!isText(u.password_hash) || !/^scrypt\$\d+\$[^$]+\$[^$]+$/.test(u.password_hash)) {
          errors.push(`${where}.password_hash must be a scrypt hash: run npm run hash-password -- '<password>'`);
        }
      });
    }
  }
  if (raw.organisation_name !== undefined && !isText(raw.organisation_name)) errors.push('organisation_name must be text');
  if (raw.folders !== undefined) {
    if (!isObject(raw.folders)) errors.push('folders must be a mapping');
    else {
      unknownKeys(raw.folders, FOLDER_KINDS, 'folders', errors);
      for (const [k, v] of Object.entries(raw.folders)) if (!isText(v)) errors.push(`folders.${k} must be a path`);
    }
  }

  const envs = raw.environments;
  const names = [];
  if (!Array.isArray(envs) || envs.length === 0) {
    errors.push('environments must be a non-empty list');
  } else {
    envs.forEach((env, i) => {
      const where = `environments[${i}]${isObject(env) && isText(env.name) ? ` ("${env.name}")` : ''}`;
      if (!isObject(env)) {
        errors.push(`${where} must be a mapping`);
        return;
      }
      unknownKeys(env, ENV_KEYS, where, errors);
      if (!isText(env.name)) errors.push(`${where}: name is required`);
      else if (names.includes(env.name.trim())) errors.push(`${where}: name "${env.name}" is used by more than one environment`);
      else names.push(env.name.trim());
      if (!isText(env.host)) errors.push(`${where}: host is required`);
      if (env.port !== undefined && !(Number.isInteger(env.port) && env.port > 0 && env.port < 65536)) errors.push(`${where}: port must be a number between 1 and 65535`);
      for (const key of ['user', 'password', 'database', 'organisation_name', 'organisation', 'environment', 'queries_folder', 'cluster_name']) {
        if (env[key] !== undefined && env[key] !== null && typeof env[key] !== 'string') errors.push(`${where}: ${key} must be text (quote it in YAML)`);
      }
      for (const key of ['secure', 'tls_reject_unauthorized', 'default']) {
        if (env[key] !== undefined && typeof env[key] !== 'boolean') errors.push(`${where}: ${key} must be true or false`);
      }
      if (env.cluster === undefined) errors.push(`${where}: cluster is required: true for a multi-replica cluster (ClickHouse Cloud, or a cluster with cluster_name), false for a single server`);
      else if (typeof env.cluster !== 'boolean' && !isText(env.cluster)) errors.push(`${where}: cluster must be true or false`);
      if (env.cluster_name !== undefined && env.cluster === false) errors.push(`${where}: cluster_name is set but cluster is false`);
      if (env.deployment !== undefined && !['cloud', 'oss'].includes(env.deployment)) errors.push(`${where}: deployment must be cloud or oss`);
      if (env.http_headers !== undefined && !(isObject(env.http_headers) && Object.values(env.http_headers).every(v => typeof v === 'string'))) {
        errors.push(`${where}: http_headers must be a mapping of header name to text`);
      }
      if (env.cloud_api !== undefined && env.cloud_api !== null) {
        if (!isObject(env.cloud_api)) errors.push(`${where}: cloud_api must be a mapping`);
        else {
          unknownKeys(env.cloud_api, CLOUD_API_KEYS, `${where}.cloud_api`, errors);
          for (const key of CLOUD_API_REQUIRED) if (!isText(env.cloud_api[key])) errors.push(`${where}.cloud_api: ${key} is required`);
          if (env.cloud_api.service_id !== undefined && !isText(env.cloud_api.service_id)) errors.push(`${where}.cloud_api: service_id must be text`);
        }
      }
      if (env.scheduler !== undefined && typeof env.scheduler !== 'boolean') {
        if (!isObject(env.scheduler)) errors.push(`${where}: scheduler must be true, false or a mapping with jobs`);
        else {
          unknownKeys(env.scheduler, ['enabled', 'jobs'], `${where}.scheduler`, errors);
          if (env.scheduler.enabled !== undefined && typeof env.scheduler.enabled !== 'boolean') errors.push(`${where}.scheduler.enabled must be true or false`);
          if (env.scheduler.jobs !== undefined) checkJobs(env.scheduler.jobs, `${where}.scheduler.jobs`, errors);
        }
      }
    });
  }

  if (Array.isArray(envs)) {
    const defaults = envs.filter(e => isObject(e) && e.default === true).map(e => e.name);
    if (defaults.length > 1) errors.push(`only one environment can have default: true (found ${defaults.join(', ')})`);
  }

  const sched = raw.scheduler;
  if (sched !== undefined && sched !== null) {
    if (!isObject(sched)) errors.push('scheduler must be a mapping');
    else {
      unknownKeys(sched, SCHEDULER_KEYS, 'scheduler', errors);
      if (sched.enabled !== undefined && typeof sched.enabled !== 'boolean') errors.push('scheduler.enabled must be true or false');
      if (sched.environments !== undefined && sched.environments !== 'all') {
        if (!Array.isArray(sched.environments)) errors.push('scheduler.environments must be "all" or a list of environment names');
        else for (const n of sched.environments) if (!names.includes(String(n))) errors.push(`scheduler.environments: "${n}" is not the name of an environment`);
      }
      if (sched.jobs !== undefined) checkJobs(sched.jobs, 'scheduler.jobs', errors);
    }
  }
  return errors;
}
