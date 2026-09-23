/**
 * chart.js v4 does not auto-register anything. Importing the package gives you the `Chart`
 * class with an *empty registry*, so the first render throws
 * `"linear" is not a registered scale` / `"pie" is not a registered controller` —
 * the four errors the admin analytics page produced.
 *
 * `chart.js/auto` would do this for us, but chart.js declares `sideEffects: false`, so a
 * bare `import 'chart.js/auto'` is a tree-shaking candidate. An explicit `register` call on
 * an imported binding cannot be dropped.
 *
 * This file is imported ONLY by the two lazily-loaded chart pages
 * (`admin-analytics`, billing `usage`), which keeps chart.js out of the initial bundle —
 * the reason the old route comment tried to skip registration altogether.
 */
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);
