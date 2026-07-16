import dotenv from "dotenv";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env from project root (two levels up from server/src/)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
// Also try project root relative to cwd (for production)
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

export const config = {
  port: parseInt(process.env.PORT || "3847", 10),
  authPassword: process.env.AUTH_PASSWORD || "da-boss-dev",
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-change-me",
  ntfyTopic: process.env.NTFY_TOPIC || "",
  anthropicAdminApiKey: process.env.ANTHROPIC_ADMIN_API_KEY || "",
  claudePath: process.env.CLAUDE_PATH || "claude",
  // "inprocess" = spawn claude as a child of the boss (host/dev).
  // "pod"       = dispatch each agent to its own k8s pod (in-cluster).
  agentExecution: (process.env.AGENT_EXECUTION || "inprocess") as "inprocess" | "pod",
  // Auto-run the test gate every time an agent completes a turn. OFF by default:
  // agents iterate freely, and a test cycle is queued ONLY on demand — the agent
  // (run_checks), a human (the 🧪 Run tests / review buttons), the supervisor
  // (when it judges the change ready), or the merge land-gate.
  autoTestOnComplete: (process.env.DABOSS_AUTO_TEST || "false") === "true",
  // Live per-agent sidecar (heartbeat + git telemetry + push command channel).
  // Added as a second container in each agent pod when on. Deterministic/advisory.
  agentSidecar: (process.env.AGENT_SIDECAR || "off") === "on",
  sidecarHeartbeatSeconds: parseInt(process.env.SIDECAR_HEARTBEAT_SECONDS || "15", 10),
  sidecarTelemetrySeconds: parseInt(process.env.SIDECAR_TELEMETRY_SECONDS || "30", 10),
  // Semantic freeze-lease cycle: recompute the blast radius of the agent's edits
  // and refresh its leases. Heavier (ctags+grep), so runs less often than heartbeat.
  sidecarLeaseSeconds: parseInt(process.env.SIDECAR_LEASE_SECONDS || "60", 10),
  // Edit-time lease hook: "enforce" blocks an edit to a function another agent
  // holds; "advisory" warns but allows; "off" disables the hook. Default advisory
  // — observe the overlap first (the supervisor escalates deep overlap) before
  // hard-blocking on a young heuristic.
  leaseMode: (process.env.LEASE_MODE || "advisory") as "enforce" | "advisory" | "off",
  // The supervisor raises a high-severity "whoa" when any agent pair contests at
  // least this many functions (deep overlap = high merge-conflict risk).
  leaseOverlapAlertThreshold: parseInt(process.env.LEASE_OVERLAP_ALERT || "3", 10),
  // The supervisor blocks (pauses) an agent that racks up this many advisory
  // violations (edited frozen code / forked frozen symbols despite warnings).
  advisoryBlockThreshold: parseInt(process.env.ADVISORY_BLOCK_THRESHOLD || "3", 10),
  // "local" = built-in login window + accounts; "oidc" = trust a configured IdP.
  authMode: (process.env.AUTH_MODE || "local") as "local" | "oidc",
  // Generic OIDC/JWT config — provider-neutral. Point it at ANY IdP (Okta,
  // Auth0, Cognito…) or at a shared static public key (e.g. the app passthrough).
  oidc: {
    issuer: process.env.OIDC_ISSUER || "", // optional; validated if set
    audience: process.env.OIDC_AUDIENCE || "", // optional; validated if set
    publicKey: process.env.OIDC_PUBLIC_KEY || "", // static PEM (SPKI) — passthrough / shared key
    jwksUri: process.env.OIDC_JWKS_URI || "", // or a JWKS endpoint — direct IdP
    tokenCookie: process.env.OIDC_TOKEN_COOKIE || "", // optional cookie name (else Authorization: Bearer)
    cookieFormat: process.env.OIDC_COOKIE_FORMAT || "jwt", // "jwt" | "plug_session"
    claims: {
      subject: process.env.OIDC_CLAIM_SUBJECT || "sub",
      email: process.env.OIDC_CLAIM_EMAIL || "email",
      name: process.env.OIDC_CLAIM_NAME || "name",
      role: process.env.OIDC_CLAIM_ROLE || "role",
      // Optional boolean claim the IdP stamps when the user is entitled to
      // da_boss (e.g. derived from full group membership on the IdP side, where
      // the group list lives). When set, it is authoritative over the role gate
      // — this is how a user in multiple groups is resolved correctly. Empty =
      // disabled, fall back to allowedRoles.
      access: process.env.OIDC_CLAIM_ACCESS || "",
    },
    // Access gate: only these IdP role-claim values may use da_boss (empty = allow
    // any valid token). For the app's JWT, "write_all" = SAs, "admin" = managers.
    allowedRoles: (process.env.OIDC_ALLOWED_ROLES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    // These emails become da_boss ADMINs regardless of the IdP role (everyone else
    // who's allowed in is a developer). da_boss admin != the IdP's admin.
    adminEmails: (process.env.OIDC_ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  },
  // Login-page copy for SSO mode — config-driven so the code names no IdP. The
  // deploy sets these (e.g. label "the app", url "/"); default is generic.
  ssoLabel: process.env.SSO_LABEL || "single sign-on",
  ssoLoginUrl: process.env.SSO_LOGIN_URL || "/",
  maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || "3", 10),
  supervisorIntervalMinutes: parseInt(process.env.SUPERVISOR_INTERVAL_MINUTES || "5", 10),
  // The headless supervisor runs Claude on a designated user's vault credential.
  // This env is an optional override; normally an admin picks the user in the UI
  // (app_settings 'supervisor_credential_user_id').
  supervisorCredentialUser: process.env.SUPERVISOR_CREDENTIAL_USER || "",
  permissionTimeoutMinutes: parseInt(process.env.PERMISSION_TIMEOUT_MINUTES || "30", 10),
  stuckThresholdMinutes: parseInt(process.env.STUCK_THRESHOLD_MINUTES || "15", 10),
  // Agent-capable image (da_boss runtime + deploy tooling like gcloud/kubectl) used
  // when a gate:human phase declares `agent: true` — approval dispatches a managed
  // deploy agent on this image instead of a plain pipeline pod. Empty → fall back
  // to running the phase as a normal (non-agent) pod.
  deployAgentImage: process.env.DABOSS_DEPLOY_AGENT_IMAGE || "",

  // Fleet
  nodeId: process.env.NODE_ID || os.hostname(),
  nodeRole: (process.env.NODE_ROLE || "boss") as "boss" | "worker",
  bossUrl: process.env.BOSS_URL || "",

  // Rate limiting
  loginRateLimitWindowMs: 60_000, // 1 minute
  loginRateLimitMax: 5,           // max 5 attempts per window
};
