// Checks the configuration Compose will really apply (legend-zoqc). Reads
// `docker compose config --format json` on stdin and compares each service's
// environment with the restricted URLs provision-roles.sh already validated
// (APP_DATABASE_URL and WORKER_DATABASE_URL in this process's environment,
// plus MAINTENANCE_DATABASE_URL when worker.env sets it and
// PAYOUT_GRANTOR_DATABASE_URL when api.env sets it).
//
// Compose's env_file parser reads more than the line starts the shell checks
// look at: text after a closing quote is a new KEY=value, quoted values may
// span lines, and a byte-order mark before a key is skipped. Only this check
// sees the result. The input holds secrets, so nothing from it is ever
// printed: messages name only services and keys. Exit 0 when the
// configuration matches, 1 otherwise.
//
// provision-roles.sh runs it with node from the migrator image, in a
// container with no network and this file mounted read-only:
//   compose config --format json | docker run --rm -i --network none ... node check-compose-env.mjs

const JOB_SERVICES = new Set(["migrate", "provision-roles"]);
const URL_KEYS = ["DATABASE_URL", "APP_DATABASE_URL", "WORKER_DATABASE_URL"];

function refuse(message) {
  process.stderr.write(`Effective Compose configuration refused: ${message}\n`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Returns the problems found; never includes a value. */
function checkComposeConfig(config, expected) {
  const problems = [];
  const services = config?.services;
  if (!services || typeof services !== "object")
    return ["the configuration has no services"];
  const env = (name) => {
    const environment = services[name]?.environment ?? {};
    return typeof environment === "object" ? environment : {};
  };
  const has = (environment, key) =>
    Object.prototype.hasOwnProperty.call(environment, key);
  for (const required of ["api", "web", "worker"])
    if (!services[required]) problems.push(`service ${required} is missing`);
  // The migration credentials belong to the job services only.
  for (const name of Object.keys(services).sort()) {
    if (JOB_SERVICES.has(name)) continue;
    for (const key of ["MIGRATION_DATABASE_URL", "MIGRATION_DATABASE_URL_FILE"])
      if (has(env(name), key)) problems.push(`${name} receives ${key}`);
  }
  const web = env("web");
  for (const key of URL_KEYS)
    if (has(web, key)) problems.push(`web receives ${key}`);
  const api = env("api");
  if (api.APP_DATABASE_URL !== expected.app)
    problems.push(
      "api receives an APP_DATABASE_URL other than the checked one in api.env",
    );
  if (has(api, "DATABASE_URL") && api.DATABASE_URL !== expected.app)
    problems.push("api receives a DATABASE_URL other than APP_DATABASE_URL");
  if (has(api, "WORKER_DATABASE_URL"))
    problems.push("api receives WORKER_DATABASE_URL");
  // The audit retention login (legend-usyi) belongs to the worker only.
  for (const name of Object.keys(services).sort())
    if (name !== "worker" && !JOB_SERVICES.has(name))
      if (has(env(name), "MAINTENANCE_DATABASE_URL"))
        problems.push(`${name} receives MAINTENANCE_DATABASE_URL`);
  // The payout grantor login (legend-911) belongs to the api only.
  for (const name of Object.keys(services).sort())
    if (name !== "api" && !JOB_SERVICES.has(name))
      if (has(env(name), "PAYOUT_GRANTOR_DATABASE_URL"))
        problems.push(`${name} receives PAYOUT_GRANTOR_DATABASE_URL`);
  // Required since legend-786te: the api refuses to start without it.
  if (!has(api, "PAYOUT_GRANTOR_DATABASE_URL"))
    problems.push("api receives no PAYOUT_GRANTOR_DATABASE_URL");
  else if (api.PAYOUT_GRANTOR_DATABASE_URL !== expected.grantor)
    problems.push(
      "api receives a PAYOUT_GRANTOR_DATABASE_URL other than the checked one in api.env",
    );
  const worker = env("worker");
  if (expected.maintenance) {
    if (worker.MAINTENANCE_DATABASE_URL !== expected.maintenance)
      problems.push(
        "worker receives a MAINTENANCE_DATABASE_URL other than the checked one in worker.env",
      );
  } else if (has(worker, "MAINTENANCE_DATABASE_URL"))
    problems.push("worker receives a MAINTENANCE_DATABASE_URL not checked");
  if (worker.WORKER_DATABASE_URL !== expected.worker)
    problems.push(
      "worker receives a WORKER_DATABASE_URL other than the checked one in worker.env",
    );
  if (!has(worker, "APP_DATABASE_URL") && !has(worker, "DATABASE_URL"))
    problems.push("worker receives no APP_DATABASE_URL or DATABASE_URL");
  for (const key of ["APP_DATABASE_URL", "DATABASE_URL"])
    if (has(worker, key) && worker[key] !== expected.app)
      problems.push(
        `worker receives a ${key} other than the checked application URL`,
      );
  return problems;
}

async function main() {
  const expected = {
    app: process.env.APP_DATABASE_URL,
    worker: process.env.WORKER_DATABASE_URL,
    maintenance: process.env.MAINTENANCE_DATABASE_URL || undefined,
    grantor: process.env.PAYOUT_GRANTOR_DATABASE_URL || undefined,
  };
  if (!expected.app || !expected.worker || !expected.grantor)
    refuse(
      "APP_DATABASE_URL, WORKER_DATABASE_URL and PAYOUT_GRANTOR_DATABASE_URL must be set for the check.",
    );
  let config;
  try {
    config = JSON.parse(await readStdin());
  } catch {
    // The parser's message can quote the input; never show it.
    refuse("docker compose config did not produce readable JSON.");
  }
  const problems = checkComposeConfig(config, expected);
  if (problems.length)
    refuse(
      `${problems.join("; ")}. Look for text after a closing quote, a quoted value spanning lines, or an invisible character before a key in the env files.`,
    );
}

main().catch(() => refuse("the check could not run."));
