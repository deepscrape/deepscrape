import { Routes } from "@angular/router";
import { paywallGuard } from "src/app/core/guards";

export const billingRoutes: Routes = [
    {
        path: '',
        // canActivate: [LoginGuard],
        redirectTo: 'plans',
        pathMatch: 'full'
    },
    {
        path: 'paymentmethods',
        loadComponent: () => import('../../pages/user/billing/paymentmethods/paymentmethods.component').then(m => m.PaymentMethodsComponent),
        data: { animation: 'billing-paymentmethods' },
    },
    {
        path: 'plans',
        loadComponent: () => import('../../pages/user/billing/plans/plans.component').then(m => m.PlansComponent),
        data: { animation: 'billing-plans' },
    },
    {
        path: 'plans/:planId',
        loadComponent: () => import('../../pages/user/billing/plan-details/plan-details.component').then(m => m.PlanDetailsComponent),
        data: { animation: 'billing-plan-details' },
    },
    {
        path: 'usage',
        loadComponent: () => import('../../pages/user/billing/usage/usage.component').then(m => m.UsageComponent),
        // chart.js is registered by `src/app/core/chart-registration.ts`, imported by the page;
        // importing ng2-charts here made it part of the initial bundle. v4 does NOT self-register.
        data: { animation: 'billing-usage' },
    },
    {
        // Invoice and payment HISTORY. Not a duplicate of `usage`, which renders
        // the usage breakdown: this is the only surface that renders
        // `hostedInvoiceUrl`, so deleting it as "unrouted" would have removed the
        // one place a customer can open their own invoice. It was built and wired
        // to a real service (`BillingService.getUsageReport`) and simply had no
        // route pointing at it.
        path: 'transactions',
        loadComponent: () => import('../../pages/user/billing/transactions/transactions.component').then(m => m.TransactionsComponent),
        data: { animation: 'billing-transactions' },
    },
    {
        // Generated from the pricing table rather than written by hand, so this page
        // cannot advertise a number the charging code does not honour.
        path: 'rates',
        loadComponent: () => import('../../pages/user/billing/rates/rates.component').then(m => m.RatesComponent),
        data: { animation: 'billing-rates' },
    },
    {
        path: 'success',
        loadComponent: () => import('../../pages/user/billing/success/billing-success.component').then(m => m.BillingSuccessComponent),
        data: { animation: 'billing-success' },
    },
    {
        path: 'cancel',
        loadComponent: () => import('../../pages/user/billing/cancel/billing-cancel.component').then(m => m.BillingCancelComponent),
        data: { animation: 'billing-cancel' },
    },
    {
        path: 'passes',
        loadComponent: () => import('../../pages/user/billing/passes/passes.component').then(m => m.PassesComponent),
        canActivate: [paywallGuard],
        data: { animation: 'billing-passes' },
    }
];