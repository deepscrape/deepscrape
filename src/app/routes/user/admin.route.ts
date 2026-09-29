import { CanDeactivateFn, Routes } from '@angular/router';
import { adminGuard } from 'src/app/core/guards';

const migrationLeaveGuard: CanDeactivateFn<unknown> = (component) => {
  const migrationComponent = component as { requestNavigationLeave?: () => boolean | Promise<boolean> };
  if (typeof migrationComponent.requestNavigationLeave === 'function') {
    return migrationComponent.requestNavigationLeave();
  }

  return true;
};
export const AdminRoutes: Routes = [
  {
    path: '',
    // canActivate: [LoginGuard],
    redirectTo: 'analytics',
    pathMatch: 'full'
  },
  {
    path: 'config',
    loadComponent: () => import('../../pages/user/admin/admin-project-config.component').then(m => m.AdminProjectConfigComponent),
    data: { title: 'project config', animation: 'admin_config' },
  },
  {
    path: 'analytics',
    loadComponent: () => import('../../pages/admin-analytics/admin-analytics.component').then(m => m.AdminAnalyticsComponent),
    // chart.js is registered in `src/app/core/chart-registration.ts`, imported by the page
    // itself. Not here: this route file is imported eagerly by app.routes.ts, so importing
    // ng2-charts (or `provideCharts`) here pulled chart.js into the initial bundle.
    // v4 does NOT auto-register — skipping registration threw "linear is not a registered
    // scale" on every chart in the panel.
    data: { title: 'analytics', animation: 'admin_analytics' },
  },
  {
    path: 'billing-observability',
    loadComponent: () => import('../../pages/admin/admin-billing-observability.component').then(m => m.AdminBillingObservabilityComponent),
    data: { title: 'billing observability', animation: 'admin_billing_observability' },
  },
  {
    // Guarded as well as authorized: the callables re-check the caller's role on every
    // call, but there is no reason to render an account console to someone who cannot
    // use it. The server check remains the authoritative one.
    path: 'users',
    loadComponent: () => import('../../pages/admin/admin-users.component').then(m => m.AdminUsersComponent),
    canActivate: [adminGuard],
    data: { title: 'users', animation: 'admin_users' },
  },
  {
    path: 'migration/runs',
    loadComponent: () => import('../../pages/admin/admin-migration-runs.component').then(m => m.AdminMigrationRunsComponent),
    data: { title: 'migration runs', animation: 'admin_migration_runs' },
  },
  {
    path: 'migration/backups',
    loadComponent: () => import('../../pages/admin/admin-migration-backups.component').then(m => m.AdminMigrationBackupsComponent),
    data: { title: 'migration backups', animation: 'admin_migration_backups' },
  },
  {
    path: 'migration',
    loadComponent: () => import('../../pages/admin/admin-migration.component').then(m => m.AdminMigrationComponent),
    canDeactivate: [migrationLeaveGuard],
    data: { title: 'migration', animation: 'admin_migration' },
  },
];
