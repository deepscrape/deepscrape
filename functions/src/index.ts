/* eslint-disable linebreak-style */
/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/* eslint-disable indent */
/*
https://medium.com/@unravel-technologies/angular-loading-performance-deploying-ssr-ssg-to-firebase-2a48d4cc7fc5
*/
import * as auth from "./app/auth"
import * as stripe from "./app/stripe"
import * as analyticsRealtime from "./gfunctions/analytics-realtime"
import * as analyticsHealth from "./gfunctions/analytics-health"
import * as billingMetrics from "./gfunctions/billing-metrics"
import * as sessions from "./gfunctions/sessions"
import * as webauthn from "./gfunctions/webauthn"
import * as notifications from "./gfunctions/notifications"
import * as alertFanout from "./gfunctions/alert-fanout"
// import path, { join } from "node:path"
// import { fileURLToPath } from "node:url"


// Get the current file's directory fileURLToPath
// const __filename = fileURLToPath(import.meta.url)
// const __dirname = dirname(__filename)


/* Auth - Functions */
// User Management - Functions
export const linkGuestToUser = auth.linkGuestToUser
export const getMyLoginSessions = sessions.getMyLoginSessions
export const getUserLoginSessionsByAdmin = sessions.getUserLoginSessionsByAdmin
export const revokeMyLoginSession = sessions.revokeMyLoginSession
export const getMyLoginSessionStatus = sessions.getMyLoginSessionStatus
export const revokeUserLoginSessionByAdmin = sessions.revokeUserLoginSessionByAdmin
export const revokeAllUserSessionsByAdmin = sessions.revokeAllUserSessionsByAdmin
export const enableTotpMfa = auth.enableTotpMfa
export const ensureBootstrapAdminAccess = auth.ensureBootstrapAdminAccess
export const createBootstrapAdminPasswordAccount = auth.createBootstrapAdminPasswordAccount

// ADMIN USER MANAGEMENT - Function TRIGGERS
export const setDefaultAdminRole = auth.setDefaultAdminRole
export const setDefaultRole = auth.setDefaultRole
export const createDefaultOrganization = auth.createDefaultOrganization


// STRIPE Functions
export const newStripeCustomer = stripe.newStripeCustomer
export const createPaymentIntent = stripe.createPaymentIntent
export const createSetupIntent = stripe.createSetupIntent
export const startSubscription = stripe.startSubscription
export const updateUsage = stripe.updateUsage
export const getBillingCatalog = stripe.getBillingCatalog
export const getMyEntitlements = stripe.getMyEntitlements
export const startTrial = stripe.startTrial
export const submitEnterprisePlanRequest = stripe.submitEnterprisePlanRequest
export const validateStripeCatalog = stripe.validateStripeCatalog
export const createCheckoutSession = stripe.createCheckoutSession
export const createBillingPortalSession = stripe.createBillingPortalSession
export const resumeSubscriptionCancellation = stripe.resumeSubscriptionCancellation
export const verifyCheckoutSession = stripe.verifyCheckoutSession
export const getBillingUsage = stripe.getBillingUsage
export const stripeWebhook = stripe.stripeWebhook
export const stripeWebhookTest = stripe.stripeWebhookTest
export const grantPromotionalCredits = stripe.grantPromotionalCredits
export const getAdminBillingObservability = stripe.getAdminBillingObservability
export const acknowledgeBillingIncident = stripe.acknowledgeBillingIncident
export const requestStripeEventRetry = stripe.requestStripeEventRetry
export const expireTrialsToFree = stripe.expireTrialsToFree
export const expireStaleCredits = stripe.expireStaleCredits
export const downgradePastDueAccounts = stripe.downgradePastDueAccounts
export const checkStripeCatalogHealth = stripe.checkStripeCatalogHealth


// API SECRET KEYS - Functions
export const createMyApiKey = auth.createMyApiKey
export const retrieveMyApiKeysPaging = auth.retrieveMyApiKeysPaging
export const getApiKeyDoVisible = auth.getApiKeyDoVisible
export const deleteMyApiKey = auth.deleteMyApiKey


// CRAWL OPERATIONS - Function TRIGGERS
// export const enqueueCrawlOperation = auth.enqueueCrawlOperation
export const getOperationsPaging = auth.getOperationsPaging


// CRAWL PACK CONFIGURATIONS - Function TRIGGERS
export const getBrowserProfilesPaging = auth.getBrowserProfilesPaging
export const getCrawlConfigsPaging = auth.getCrawlConfigsPaging
export const getCrawlResultConfigsPaging = auth.getCrawlResultConfigsPaging


// MACHINE LOGGERS - Function TRIGGERS
// export const receiveLogs = auth.receiveLogs


// MACHINES - Function TRIGGERS
export const getMachinesPaging = auth.getMachinesPaging

// ANALYTICS - Function TRIGGERS & SCHEDULED (Optimized Real-time System)
export const onGuestCreated = analyticsRealtime.onGuestCreated
export const onUserCreated = analyticsRealtime.onUserRegistered
export const onUserLogin = analyticsRealtime.onLoginEvent
export const backfillDashboardSummary = analyticsRealtime.backfillDashboardSummary
export const computeDailyTrends = analyticsRealtime.computeDailyTrends
export const computeRangeMetrics = analyticsRealtime.computeRangeMetrics
export const cleanupOldMetrics = analyticsRealtime.cleanupOldAnalytics
export const computeActiveUsersNow = analyticsRealtime.computeActiveUsersNow

// BILLING METRICS - Scheduled (nightly MRR / plan mix / trials / past due)
export const computeBillingMetricsDaily = billingMetrics.computeBillingMetricsDaily

// ANALYTICS PIPELINE HEALTH - Scheduled (raises an incident when guest creation stalls)
export const checkAnalyticsPipelineHealth = analyticsHealth.checkAnalyticsPipelineHealth

// PUSH NOTIFICATIONS - Functions (Callable)
export const registerNotificationToken = notifications.registerNotificationToken
export const unregisterNotificationToken = notifications.unregisterNotificationToken
export const getMyNotificationTokens = notifications.getMyNotificationTokens
export const sendTestNotification = notifications.sendTestNotification

// SECURITY ALERTS - Firestore trigger (Resend email + web push fan-out)
// Must be exported from the entry point above, not just the gfunctions barrel:
// the CLI builds its manifest from THIS module, so an unexported trigger is
// silently "deleted" on the next deploy and every security alert stops being
// delivered. See domain/notifications/alert-presentation.ts.
export const onSecurityAlertCreated = alertFanout.onSecurityAlertCreated

/* Sessions — Presence */
export const recordGuestPresence = sessions.recordGuestPresence

// SESSION MANAGEMENT - Functions (Callable)
export const createLoginSession = sessions.createLoginSession
export const signOutLoginSession = sessions.signOutLoginSession
export const recordLogoutMetrics = sessions.recordLogoutMetrics
export const validateSessionCookie = sessions.validateSessionCookie
export const cleanupExpiredSessions = sessions.cleanupExpiredSessions
export const onLoginHistoryCreated = sessions.onLoginHistoryCreated
export const enrichLoginSessionGeo = sessions.enrichLoginSessionGeo
export const enrichGuestGeo = sessions.enrichGuestGeo

// PHASE 4.2: DEVICE VERIFICATION - Functions
export const sendDeviceVerificationCode = sessions.sendDeviceVerificationCode
export const verifyAndTrustDevice = sessions.verifyAndTrustDevice
export const isDeviceTrusted = sessions.isDeviceTrusted
export const getTrustedDevices = sessions.getTrustedDevices
export const removeTrustedDevice = sessions.removeTrustedDevice
export const adminResetUserMfa = sessions.adminResetUserMfa

/* WebAuthn / Passkey - Functions */
export const generateWebAuthnRegistrationOptions = webauthn.generateWebAuthnRegistrationOptions
export const verifyWebAuthnRegistration = webauthn.verifyWebAuthnRegistration
export const generateWebAuthnAuthenticationOptions = webauthn.generateWebAuthnAuthenticationOptions
export const verifyWebAuthnAuthentication = webauthn.verifyWebAuthnAuthentication
export const getWebAuthnCredentials = webauthn.getWebAuthnCredentials
export const removeWebAuthnCredential = webauthn.removeWebAuthnCredential

export const getMfaSecurityPreferences = sessions.getMfaSecurityPreferences
export const updateMfaSecurityPreferences = sessions.updateMfaSecurityPreferences
export const notifyMfaRiskEvent = sessions.notifyMfaRiskEvent
