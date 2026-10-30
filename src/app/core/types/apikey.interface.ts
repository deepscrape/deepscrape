export interface ApiKey {
    id: string;
    name: string;
    default: boolean
    key: string;
    type: ApiKeyType
    showKey: string;
    created_At: any; // Changed to any to accommodate Firestore Timestamp
    created_By?: string
    lastUsed?: Date;
    permissions?: string[];
    /** `disabled` means the lookup index entry is gone, so it cannot authenticate. */
    status?: 'enabled' | 'disabled';
    menu_visible: boolean;
    visibility: boolean;
}


export type ApiKeyType = 'jina' | 'anthropic' | 'openai' | 'groq' | 'custom'

export type ApiKeyLoader = {
    modal: boolean
    visibility: { [key: string]: boolean }
}
export type ApiKeyPermission = 'read' | 'write' | 'delete' | 'update' | 'create'