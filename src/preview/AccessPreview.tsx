import { AccessPage } from '../components/access/AccessPage';
import type { AuditTable, MeUser, ProfileSummary, UserSummary } from '../types/access';

const ME: MeUser = {
  id: 'u-thiago',
  email: 'tm.jacometti@tmjsistemas.com.br',
  display_name: 'Thiago Jacometti',
  active: true,
  profiles: ['admin'],
  permissions: ['admin'],
};

const USERS: UserSummary[] = [
  {
    id: 'u-thiago', email: 'tm.jacometti@tmjsistemas.com.br', display_name: 'Thiago Jacometti',
    active: true, last_login_at: '2026-09-04 17:56:02:709', profiles: ['admin'],
  },
  {
    id: 'u-maria', email: 'maria.souza@tmjsistemas.com.br', display_name: 'Maria Souza',
    active: true, last_login_at: '2026-09-04 14:12:40:120', profiles: ['developer'],
  },
  {
    id: 'u-novo', email: 'novo.colega@tmjsistemas.com.br', display_name: 'Novo Colega',
    active: true, last_login_at: '2026-09-04 09:03:11:004', profiles: ['guest'],
  },
  {
    id: 'u-saiu', email: 'ex.funcionario@tmjsistemas.com.br', display_name: null,
    active: false, last_login_at: '2026-07-11 08:44:00:000', profiles: ['developer'],
  },
];

const PROFILES: ProfileSummary[] = [
  {
    id: 'p-admin', name: 'admin',
    description: 'Full control, including user management',
    permissions: [],
  },
  {
    id: 'p-developer', name: 'developer',
    description: 'Cluster Overview, workloads, logs and rollout restart. Cannot scale, delete a deploy, or port-forward.',
    permissions: ['overview', 'view', 'view-logs', 'restart-workloads'],
  },
  {
    id: 'p-guest', name: 'guest',
    description: 'Cluster Overview only. Assigned automatically on first SSO login.',
    permissions: ['overview'],
  },
];

const AUDIT: AuditTable = {
  columns: ['at', 'user_email', 'action', 'target', 'namespace', 'detail', 'allowed'],
  rows: [
    ['2026-09-04 17:58:21:410', 'maria.souza@tmjsistemas.com.br', 'restart_workload', 'payments-api', 'payments', null, 'true'],
    ['2026-09-04 17:41:03:220', 'novo.colega@tmjsistemas.com.br', 'list_pods', 'checkout-api', 'payments', "denied: requires 'view'", 'false'],
    ['2026-09-04 17:56:02:797', 'tm.jacometti@tmjsistemas.com.br', 'bootstrap-admin-granted', null, null, 'email matches TMJLENS_BOOTSTRAP_ADMIN', 'true'],
    ['2026-09-04 09:03:11:004', 'novo.colega@tmjsistemas.com.br', 'first-login-registered', null, null, 'registered as guest', 'true'],
    ['2026-09-03 22:10:45:001', 'maria.souza@tmjsistemas.com.br', 'scale_workload', 'airflow-worker', 'airflow', "denied: requires 'scale-workloads'", 'false'],
  ],
};

export function AccessPreview() {
  return (
    <>
      <div className="breadcrumbs">Cluster / in-cluster / Access</div>
      <div className="title-row">
        <div>
          <h1>Access</h1>
          <p>Who can do what, and who did what</p>
        </div>
      </div>
      <AccessPage
        me={ME}
        users={USERS}
        profiles={PROFILES}
        audit={AUDIT}
        loading={false}
        error=""
        onRefresh={() => undefined}
        onGrant={async () => undefined}
        onRevoke={async () => undefined}
        onSetActive={async () => undefined}
        notify={() => undefined}
      />
    </>
  );
}
