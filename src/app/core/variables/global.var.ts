import { GlobalTabs } from "../types"

export const DEFAULT_PROFILE_URL = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_1280.png'
export const ACCOUNT_DATA_TABS: GlobalTabs[] = [
    // inventory tabs
    { svg: '', icon: 'sparkles', color: "black", name: 'General', id: 'general' },
    { svg: '', icon: 'user-round', color: "gray", name: 'Profile', id: 'profile' },
    { svg: '', icon: 'settings', color: "sky", name: 'Workspace', id: 'workspace' },
    { svg: '', icon: 'fingerprint', color: "pink", name: 'Security', id: 'security' },
    // { svg: '', icon: 'piggy-bank', color: "sky", name: 'Payments', id: 'payment' },
    { svg: '', icon: 'key-round', color: "green", name: 'API Keys', id: 'keys' },
]