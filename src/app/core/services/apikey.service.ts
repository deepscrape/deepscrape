import { inject, Injectable } from '@angular/core';
import { BehaviorSubject, catchError, from, map, Observable, of, Subscription, tap, throwError } from 'rxjs';
import { ApiKey, ApiKeyType } from '../types/apikey.interface';
import { AnalyticsService } from './analytics.service';
import { SessionStorage } from './storage.service';
import { FirestoreService } from './firestore.service';
import { toDate } from '../functions';

type ApiKeySecurityErrorCode = 'RECENT_AUTH_REQUIRED' | 'MFA_REQUIRED' | 'MFA_ENROLL_REQUIRED'

type ApiKeySecurityError = {
    code: ApiKeySecurityErrorCode
    message: string
}
@Injectable({
    providedIn: 'root'
})
export class ApiKeyService {

    private retrieveKeysSub: Subscription;
    private apiKeysSubject = new BehaviorSubject<ApiKey[] | null>([]);
    private SessionStorage: Storage = inject(SessionStorage)
    private apiKeyPageCursors = new Map<number, string | null>([[1, null]])
    private readonly analytics = inject(AnalyticsService)

    apiKeys$ = this.apiKeysSubject.asObservable()

    constructor(
        private firestoreService: FirestoreService,) {
        // Load existing API keys from local storage or backend
        const storedKeys = this.SessionStorage.getItem('apiKeys');

        this.initializeApiKeys(storedKeys);
    }

    private initializeApiKeys(storedKeys: string | null) {
        if (storedKeys) {
            this.apiKeysSubject.next(JSON.parse(storedKeys));
        } else {
            this.apiKeysSubject.next(null);
            // Get Data from Firestore
            this.retrieveKeysSub = this.retrieveApiKeysPagination().pipe(
                catchError((error: any) => {
                    console.error('Error retrieving API keys:', error);
                    return of([]); // Return an empty array to prevent subscription errors
                })).subscribe({
                    next: (apiKeys: ApiKey[]) => {

                        // Update the API keys in the BehaviorSubject
                        this.apiKeysSubject.next(apiKeys);
                        this.saveApiKeys(apiKeys);
                    },
                    error: (error: any) => {
                        console.error('Error retrieving API keys:', error);
                    }
                })
        }

    }

    private retrieveApiKeysPagination(apiKeyPage: number = 1, apiKeyPageSize: number = 10): Observable<ApiKey[]> {
        const lastDocId = this.apiKeyPageCursors.get(apiKeyPage) ?? null

        return from(this.firestoreService.callFunction<{ pageSize: number; lastDocId: string | null }, any>(
            'retrieveMyApiKeysPaging',
            { pageSize: apiKeyPageSize, lastDocId }
        ))
            .pipe(
                map((data: any) => {
                    const { error, apiKeys, message, nextLastDocId } = data as any

                    if (error) {
                        console.error('Error creating API key:', error, apiKeys, message);
                        throw new Error(message, error);
                    }

                    this.apiKeyPageCursors.set(apiKeyPage + 1, nextLastDocId ?? null)


                    console.log(apiKeys)
                    const newKeys = apiKeys.map((key: ApiKey): ApiKey => {
                        const created_At = toDate(key.created_At)
                        const showKey = key.showKey
                        return { ...key, visibility: false, menu_visible: false, key: showKey, created_At }
                    })

                    return newKeys
                })
            )
    }

    private createApiKey(newkey: ApiKey): Observable<any> {

        return from(this.firestoreService.callFunction<{ apiKey: ApiKey }, any>(
            'createMyApiKey',
            { apiKey: newkey }
        ))
            .pipe(
                tap((data: any) => {
                    const { error, apiKeyId, message } = data as any

                    if (error) {
                        console.error('Error creating API key:', error, apiKeyId, message);
                        throw new Error(message, error);
                    }

                    newkey.id = apiKeyId

                    // Update the API keys in the BehaviorSubject
                    const currentKeys = this.apiKeysSubject.value || []
                    const updatedKeys = [...currentKeys, newkey];

                    // store key in cache
                    this.apiKeysSubject.next(updatedKeys);
                    this.saveApiKeys(updatedKeys);
                    // console.log(fun.data as any)
                }))
    }

    private getKeyDoVisible(key: ApiKey, index: number): Observable<ApiKey> {

        return from(this.firestoreService.callFunction<{ apiKey: ApiKey }, any>(
            'getApiKeyDoVisible',
            { apiKey: key }
        ))
            .pipe(
                map((data: any) => {
                    const { error, apiKey, message } = data as any

                    if (error) {
                        console.error('Error creating API key:', error, apiKey, message);
                        const securityError = new Error(error?.message || message || 'Failed to retrieve API key') as Error & { code?: string }
                        securityError.code = String(error?.code || '').toUpperCase()
                        throw securityError
                    }

                    // Update the API keys in the BehaviorSubject
                    const currentKeys = this.apiKeysSubject.value || []

                    // the key remains same as before
                    if (index !== -1) {
                        currentKeys[index] = { ...key, visibility: true, menu_visible: false, showKey: apiKey.key } as ApiKey
                        // store key in cache
                        this.apiKeysSubject.next(currentKeys)
                    }

                    return apiKey as ApiKey
                })
            )
    }

    generateApiKey(name: string = 'New API Key', key: string = 'dpsp-key-' + this.generateRandomKey(),
        showKey: string = 'dpsp-key-' + this.generateFakeKey(), type: ApiKeyType = "custom", def: boolean = false) {
        const newKey: ApiKey = {
            id: this.generateUniqueId(),
            name,
            default: def,
            type,
            key,
            showKey,
            created_At: new Date(),
            permissions: ['read', 'delete'],
            menu_visible: false,
            visibility: false,
        };

        // make fire function https call to save the key in secret manager 
        // and the metadata in firestore db for current user

        // return the new Key
        return this.createApiKey(newKey).pipe(
            tap(() => this.analytics.trackEvent('api_key_created', { type }).subscribe({ error: () => undefined })),
        )
    }

    deleteApiKey(keyToDelete: ApiKey) {
        return from(this.firestoreService.callFunction<{ apiKeyId: string }, any>(
            'deleteMyApiKey',
            { apiKeyId: keyToDelete.id }
        )).pipe(
            tap((data: any) => {
                const { error, message } = data as any

                if (error) {
                    throw new Error(message || 'Failed to delete API key')
                }

                const currentKeys = this.apiKeysSubject.value || []
                const updatedKeys = currentKeys.filter((key) => key.id !== keyToDelete.id)
                this.apiKeysSubject.next(updatedKeys)
                this.saveApiKeys(updatedKeys)
            })
        )
    }

    setKeyVisible(key: ApiKey) {

        // Update the API keys in the BehaviorSubject
        const currentKeys = this.apiKeysSubject.value || []
        const index = currentKeys.findIndex(k => k.id === key.id)
        if (key.visibility) {
            // the key remains same as before
            if (index !== -1) {
                currentKeys[index] = { ...key, visibility: false, menu_visible: false, showKey: key.key } as ApiKey
                // store key in cache
                this.apiKeysSubject.next(currentKeys)
                return of(currentKeys[index])
            }
            return of({} as ApiKey)
        } else {
            return this.getKeyDoVisible(key, index).pipe(
                catchError((error: any) => {
                    console.error('Error retrieving API keys:', error);

                    if (this.isRecentAuthRequiredError(error)) {
                        const securityError: ApiKeySecurityError = {
                            code: 'RECENT_AUTH_REQUIRED',
                            message: 'Recent authentication is required before revealing API keys.',
                        }
                        return throwError(() => securityError)
                    }

                    if (this.isMfaRequiredError(error)) {
                        const securityError: ApiKeySecurityError = {
                            code: 'MFA_REQUIRED',
                            message: 'Multi-factor authentication step-up is required before revealing API keys.',
                        }
                        return throwError(() => securityError)
                    }

                    if (this.isMfaEnrollmentRequiredError(error)) {
                        const securityError: ApiKeySecurityError = {
                            code: 'MFA_ENROLL_REQUIRED',
                            message: 'You must enroll MFA before revealing API keys.',
                        }
                        return throwError(() => securityError)
                    }

                    // the key remains same as before

                    if (index !== -1) {
                        currentKeys[index] = { ...key, key: key.showKey } as ApiKey
                        // store key in cache
                        this.apiKeysSubject.next(currentKeys)
                    }
                    return throwError(() => error); // Return an empty array to prevent subscription errors
                })
            )
        }


    }

    setMenuVisible(key: ApiKey) {
        const currentKeys = this.apiKeysSubject.value || []
        const updatedKeys = currentKeys?.map(k => {
            if (k.id === key.id) {
                return { ...k, menu_visible: !k.menu_visible };
            }
            return k;
        })
        this.apiKeysSubject.next(updatedKeys);
        this.saveApiKeys(updatedKeys);
    }

    setMenuInVisible(key: ApiKey) {
        // console.log('setMenuInVisible', key)
        const currentKeys = this.apiKeysSubject.value || []
        const updatedKeys = currentKeys?.map(k => {
            if (k.id === key.id) {
                return { ...k, menu_visible: false };
            }
            return k;
        })
        this.apiKeysSubject.next(updatedKeys);
        this.saveApiKeys(updatedKeys);
    }

    setMenuInvisibleExceptOne(id: string) {
        const currentKeys = this.apiKeysSubject.value || [];
        const updatedKeys = currentKeys?.map(k => {
            if (k.id === id) {
                return { ...k, menu_visible: true };
            }
            return { ...k, menu_visible: false };
        });
        this.apiKeysSubject.next(updatedKeys);
        this.saveApiKeys(updatedKeys);
    }

    setMenuInvisibleAll() {
        const currentKeys = this.apiKeysSubject.value || [];    
        const updatedKeys = currentKeys?.map(k => {
                return { ...k, menu_visible: false };
        });
        this.apiKeysSubject.next(updatedKeys);
        this.saveApiKeys(updatedKeys);
    }

    private generateUniqueId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    private generateRandomKey(length: number = 32): string {
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        return result;
    }

    generateFakeKey(size: number = 32, start: number = 0): string {
        let result = '';
        let i = start
        for (i = 0; i < size; i++) {
            result += '*';
        }
        return result;
    }
    private saveApiKeys(keys: ApiKey[]) {
        this.SessionStorage.setItem('apiKeys', JSON.stringify(keys));
    }

    private getSecurityErrorCode(error: any): ApiKeySecurityErrorCode | null {
        const rawCode = [
            error?.details?.code,
            error?.error?.code,
            error?.code,
        ].find((value) => typeof value === 'string' && value.trim().length > 0)

        const normalizedCode = String(rawCode || '').toUpperCase()
        switch (normalizedCode) {
            case 'RECENT_AUTH_REQUIRED':
            case 'MFA_REQUIRED':
            case 'MFA_ENROLL_REQUIRED':
                return normalizedCode as ApiKeySecurityErrorCode
            default:
                return null
        }
    }

    private hasSecurityError(error: any, code: ApiKeySecurityErrorCode, fallbackMessage: string): boolean {
        const explicitCode = this.getSecurityErrorCode(error)
        if (explicitCode) {
            return explicitCode === code
        }

        const message = String(error?.message || '').toLowerCase()
        return message.includes(fallbackMessage)
    }

    private isRecentAuthRequiredError(error: any): boolean {
        return this.hasSecurityError(error, 'RECENT_AUTH_REQUIRED', 'recent authentication required')
    }

    private isMfaRequiredError(error: any): boolean {
        return this.hasSecurityError(error, 'MFA_REQUIRED', 'mfa step-up required')
    }

    private isMfaEnrollmentRequiredError(error: any): boolean {
        return this.hasSecurityError(error, 'MFA_ENROLL_REQUIRED', 'mfa enrollment is required')
    }

    ngOnDestroy(): void {
        //Called once, before the instance is destroyed.
        //Add 'implements OnDestroy' to the class.
        this.retrieveKeysSub?.unsubscribe()
        this.apiKeysSubject?.unsubscribe()
    }
}
