/**
 * Console-only sidebar (`console.deepscrape.dev`): the admin pages plus one way back
 * to the app. The app origin shows a single "Console" entry instead — see
 * `navigation` below.
 *
 * ponytail: the admin items live here and nowhere else, so the dashboard sidebar can
 * no longer offer a link that leaves its own origin. `/dashboard` is relative on
 * purpose: the host guard forwards it to the app origin from the console.
 */
export const adminNavigation = [
    {
        name: 'Dashboard',
        url: '/dashboard',
        icon: {
            matIcon: 'speedometer'
        }
    },
    {
        divider: true
    },
    {
        title: true,
        name: 'Admin'
    },
    {
        name: 'Analytics',
        url: '/admin/analytics',
        icon: {
            matIcon: 'pie_chart'
        },
        badge: {
            variant: 'info',
            text: 'new'
        },
    },
    {
        name: 'Billing Observability',
        url: '/admin/billing-observability',
        icon: {
            matIcon: 'monitoring'
        }
    },
    {
        name: 'Migration',
        url: '/admin/migration',
        icon: {
            matIcon: 'sync_alt'
        }
    },
    {
        name: 'Migration Runs',
        url: '/admin/migration/runs',
        icon: {
            matIcon: 'history'
        }
    },
    {
        name: 'Migration Backups',
        url: '/admin/migration/backups',
        icon: {
            matIcon: 'backup'
        }
    },
    {
        name: 'Users',
        url: '/admin/users',
        icon: {
            matIcon: 'group'
        }
    },
];

export const navigation = [
    {
        name: 'Dashboard',
        url: '/dashboard',
        icon: {
            matIcon: 'speedometer'
        },
        identity: true,
    },
    // ponytail: the admin tree now lives in `adminNavigation` for the console. The app
    // origin gets one cross-link instead — a relative `/admin`, which the host guard
    // forwards to `console.`, so no absolute URL is hardcoded in a template.
    {
        name: 'Console',
        url: '/admin',
        icon: {
            matIcon: 'admin_panel_settings'
        }
    },
    /* Posts Management  */
    {
        name: 'Playground',
        url: '/playground',
        icon: {
            matIcon: 'sports_esports'
        },

        identity: true,
    },
    {
        name: 'Crawl Pack',
        url: '/crawlpack',
        icon: 'crawl_logo',

        identity: true,
    },

    {
        name: 'Operations',
        url: '/operations',
        icon: {
            matIcon: 'storage'
        },

        identity: true,
    },
    // ponytail: re-added now that /chatai is a real route. No badge — the previous one
    // carried a hardcoded Greek string instead of an i18n key.
    {
        name: 'AI Chat',
        url: '/chatai',
        icon: {
            matIcon: 'forum'
        },
        identity: true,
    },
    {
        divider: true,
    },
    {
        title: true,
        name: 'Billing'
    },

    /* Menu Management  */
    {
        name: 'Plans',
        url: '/billing/plans',
        identity: true,
        icon: {
            matIcon: 'workspace_premium'
        },
        badge: {
            variant: 'new',
            text: 'new'
        },
    },
    {
        name: 'Usage',
        url: '/billing/usage',
        identity: true,
        icon: {
            matIcon: 'query_stats'
        }
    },
    {
        name: 'Payments',
        url: '/billing/paymentmethods',
        identity: true,
        icon: {
            matIcon: 'credit_card'
        }
    },



    /*
    {
      divider: true
    },
    {
      title: true,
      name: 'Smart Car',
    },
    {
      name: 'Icons',
      url: '/icons',
      icon: 'icon-star',
      children: [
        {
          name: 'Font Awesome',
          url: '/icons/font-awesome',
          icon: 'icon-star',
          badge: {
            variant: 'secondary',
            text: '4.7'
          },
        },
        {
          name: 'Simple Line Icons',
          url: '/icons/simple-line-icons',
          icon: 'icon-star',
        }
      ]
    }, */
    {
        divider: true
    },
    {
        title: true,
        name: 'Settings',
    },

    /* API keys Management  */
    {
        name: 'Api Keys',
        url: '/settings/keys',
        identity: true,
        icon: {
            matIcon: 'keys'
        }
    },

    {
        name: 'Profile',
        identity: true,
        url: '/settings/profile',
        icon: {
            matIcon: 'person'
        }
    },

    /* {
      name: 'Εγγραφή Χρήστη',
      url: '/service/register',
      icon: 'signup'
    } */
    /*  {
       name: 'Download CoreUI',
       url: 'http://coreui.io/angular/',
       icon: 'icon-cloud-download',
       class: 'mt-auto',
       variant: 'success'
     },
     {
       name: 'Try CoreUI PRO',
       url: 'http://coreui.io/pro/angular/',
       icon: 'icon-layers',
       variant: 'danger'
     } */
];
