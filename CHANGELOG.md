# [0.9.0-beta.4](https://github.com/deepscrape/deepscrape/compare/v0.9.0-beta.3...v0.9.0-beta.4) (2026-09-14)


### Bug Fixes

* **deps:** stop the path-to-regexp override breaking container startup ([77b5103](https://github.com/deepscrape/deepscrape/commit/77b51030e65bf1f763ea17b05cbf6507a7d59f41))

# [0.9.0-beta.2](https://github.com/deepscrape/deepscrape/compare/v0.9.0-beta.1...v0.9.0-beta.2) (2026-09-10)


### Bug Fixes

* **test:** provide analytics mock for operation status ([1291bf5](https://github.com/deepscrape/deepscrape/commit/1291bf514a97f94ac7d8e0c45c958b9f94b1b2a7))

# [0.8.0-beta.9](https://github.com/deepscrape/deepscrape/compare/v0.8.0-beta.8...v0.8.0-beta.9) (2026-09-08)


### Bug Fixes

* **functions:** enforce App Check on contact submissions ([97c1784](https://github.com/deepscrape/deepscrape/commit/97c1784c977e6c0f5209b05c9fe81458adc2c82b))

# [0.8.0-beta.6](https://github.com/deepscrape/deepscrape/compare/v0.8.0-beta.5...v0.8.0-beta.6) (2026-09-08)


### Bug Fixes

* **ssr:** stop prerendering authenticated routes ([63e2087](https://github.com/deepscrape/deepscrape/commit/63e2087b56e2dc47cc66ee8b88e823d7a211b589))

# [0.8.0-beta.3](https://github.com/deepscrape/deepscrape/compare/v0.8.0-beta.2...v0.8.0-beta.3) (2026-09-08)


### Bug Fixes

* **functions:** 404 missing static assets instead of serving index.html ([ef9dbee](https://github.com/deepscrape/deepscrape/commit/ef9dbee356eb4afcba28276672a249166de1ad08))
* **functions:** document geo lookup parameters ([d9d5eab](https://github.com/deepscrape/deepscrape/commit/d9d5eab1ca461438a48a28f02dbee28d25dfbc15))
* **test:** complete TranslateService mock for the v17 TranslatePipe ([2899618](https://github.com/deepscrape/deepscrape/commit/2899618f8e05d13d2088359365de483834685c5b))


### Features

* **analytics:** include ASN and ISP breakdowns in range metrics ([5fe4aeb](https://github.com/deepscrape/deepscrape/commit/5fe4aeb2d92b10e202b6454242451a3c5c124c31))
* **geo:** coalesce concurrent IP lookups and add country-based deny-lists ([90aa3f8](https://github.com/deepscrape/deepscrape/commit/90aa3f8ab798f44531010e4bc848c4dea456bd65))
* **i18n:** add es, fr and de locales with header language picker ([3cd89b3](https://github.com/deepscrape/deepscrape/commit/3cd89b3a5076cf633093b832e61c4af0f1dab1a9))
* **i18n:** localize app templates and runtime strings with [@ngx-translate](https://github.com/ngx-translate) ([b6c4623](https://github.com/deepscrape/deepscrape/commit/b6c462320d7de1d3a93045ca1e7fca873e52b1e8))
* **i18n:** translate agent, playground, hero and nav copy (el, es, fr, de) ([1439764](https://github.com/deepscrape/deepscrape/commit/143976430e6c805135ed337b26cad21c8a268339))
* **legal:** align privacy, terms and 404 pages with landpage chrome ([d532683](https://github.com/deepscrape/deepscrape/commit/d532683f6c8d66283538c2a8cab7dd26bac25924))
* **marketing:** add AI research agent section and live playground rework ([67058d0](https://github.com/deepscrape/deepscrape/commit/67058d0b2af4a9ee54d0b6b0d8c5808bd6c5da98))
* **marketing:** add privacy/terms pages and scroll-reveal animations ([b663910](https://github.com/deepscrape/deepscrape/commit/b6639105a6c4f7069685e5aa9eb6a99e4957aeef))
* **marketing:** refresh landing with live demo, managed pricing and art ([8565cd8](https://github.com/deepscrape/deepscrape/commit/8565cd8c78d829f3adced6c09c465e737bb3c9de))
* **seo:** add per-route titles, robots, sitemap and OG image ([f40a0e0](https://github.com/deepscrape/deepscrape/commit/f40a0e00a6a7aa01ca1784614700050cd1f030e8))
* **theme:** add Light/Dark/System toggle defaulting to OS scheme ([0697752](https://github.com/deepscrape/deepscrape/commit/069775299affc5362fbc2bacb1add8a136053fc1))


### Performance Improvements

* **functions:** raise default runtime memory to 512MiB ([ae53e94](https://github.com/deepscrape/deepscrape/commit/ae53e94842455f6fc2f0e0171211cdac02c365f5))

## [0.7.2](https://github.com/deepscrape/deepscrape/compare/v0.7.1...v0.7.2) (2026-09-06)


### Bug Fixes

* **analytics:** read flat breakdown keys in range charts ([deaa20c](https://github.com/deepscrape/deepscrape/commit/deaa20c376dcad2fb896490cc35484da74906078))

## [0.7.1](https://github.com/deepscrape/deepscrape/compare/v0.7.0...v0.7.1) (2026-09-06)


### Bug Fixes

* **geo:** stop no-match re-enrich loop spend ([0c3bda8](https://github.com/deepscrape/deepscrape/commit/0c3bda8bcada97e0aa4f12c66cb47da7a93c37c8))

# [0.7.0](https://github.com/deepscrape/deepscrape/compare/v0.6.4...v0.7.0) (2026-09-06)


### Bug Fixes

* **admin-migration:** adjust checkbox width for better layout consistency ([a788ab8](https://github.com/deepscrape/deepscrape/commit/a788ab85a2bdcaaadb15becacc1b58c52cf9c754))
* **auth-flow:** stabilize returnUrl and MFA sign-in routing ([f7e3da1](https://github.com/deepscrape/deepscrape/commit/f7e3da14298f93c366cc8e1e201811f685ec86f5))
* **auth:** handle revoked sessions end to end ([fa12e61](https://github.com/deepscrape/deepscrape/commit/fa12e61ae1134145c74566f989b5381dc51e7d93))
* **auth:** harden admin fallback and phone verification flows ([a59b11b](https://github.com/deepscrape/deepscrape/commit/a59b11b4e006a3c03d8e7e856164a773c0d7e70d))
* **auth:** harden MFA enrollment, active sessions, phone link and route guards ([4102844](https://github.com/deepscrape/deepscrape/commit/41028444f5034646687b66da805d988d37fddb9e))
* **auth:** improve fallback fingerprint generation safety ([71799e6](https://github.com/deepscrape/deepscrape/commit/71799e6310d0775f6d434c83fd2a53097e82fada))
* **auth:** make device fingerprinting SSR-safe ([a564e1a](https://github.com/deepscrape/deepscrape/commit/a564e1a917e34bb23c7587ee6dfe180348ddd1b0))
* **auth:** persist signup phone before verification ([074ed40](https://github.com/deepscrape/deepscrape/commit/074ed40e4a76923013376341ff3c47b6866f709e))
* **auth:** resolve PR review security and SSR issues ([e83fa67](https://github.com/deepscrape/deepscrape/commit/e83fa672ff63100f5d2b70742e4bdc29083775ae))
* **auth:** update fallback error message translation logic ([5f55238](https://github.com/deepscrape/deepscrape/commit/5f55238995b2f0ce17fa5647a27ac427c12db412))
* **authz,security,test:** address PR [#70](https://github.com/deepscrape/deepscrape/issues/70) Copilot review findings ([d39190a](https://github.com/deepscrape/deepscrape/commit/d39190a13ce0a187f4c6a2c1032238e5afe99890))
* **authz:** prevent reload redirect races on guarded routes ([d177130](https://github.com/deepscrape/deepscrape/commit/d1771302d523ff33bdd9f280b8d3219af369596a))
* **billing:** allow eligible users to start trial from plans page ([73f20a1](https://github.com/deepscrape/deepscrape/commit/73f20a11ff821f702efd0d63d94eae5c6cc39586))
* **billing:** hide Stripe price IDs from non-admins; fix leaf icon rotation ([b0e0b1f](https://github.com/deepscrape/deepscrape/commit/b0e0b1f2d0ecd62d62de68ddf3295e864f9dc4c1))
* **billing:** relax app-check enforcement on callables ([6cf448c](https://github.com/deepscrape/deepscrape/commit/6cf448ccb0b8e9b20295c6676a3db62b44df9249))
* **billing:** tighten usage auth and env parsing defaults ([307a362](https://github.com/deepscrape/deepscrape/commit/307a36204dd5e2db6b0de6f17d34e8004b70d6e5))
* **ci:** recreate release asset branches without stale LFS refs ([62a7910](https://github.com/deepscrape/deepscrape/commit/62a7910082fd4f59377ec356f11edcf122792a6f))
* **ci:** sync root and functions package-lock.json ([e463049](https://github.com/deepscrape/deepscrape/commit/e463049834ae9bc71e43dd715caa3f1284159850))
* **ci:** use chromium binary for Angular headless tests ([8ad969f](https://github.com/deepscrape/deepscrape/commit/8ad969f147d8f297a842298a56ec069e30394947))
* **component:** initialize existingMachines array in AppDockerStepperComponent ([1bb9696](https://github.com/deepscrape/deepscrape/commit/1bb9696e884652da9195a08282a8c3537b578984))
* **csrf:** harden token refresh for emulator and web ([3673b30](https://github.com/deepscrape/deepscrape/commit/3673b304575f927e2b93099f9017decccaa1ea0a))
* **firebase:** avoid duplicate app initialization paths ([ae21c50](https://github.com/deepscrape/deepscrape/commit/ae21c50343b7a93b7e0f5a97ed8502277d687538))
* **firestore:** harden fallback rule, add audit_logs and trusted_devices coverage ([99761f1](https://github.com/deepscrape/deepscrape/commit/99761f117527819ac96e78f3ceae516a970b49fa))
* **functions:** isolate emulator secret storage path ([35b2d45](https://github.com/deepscrape/deepscrape/commit/35b2d451520abc86dec3762a5405174500fed1bd))
* **geo:** cache failed lookups to stop re-enrich storm ([ac15190](https://github.com/deepscrape/deepscrape/commit/ac15190d4765c11d22efa0563f5e6eee9ce43984))
* **gitignore:** remove serviceAccount.json from being tracked ([4833b60](https://github.com/deepscrape/deepscrape/commit/4833b60651503b300798af9f797badfb336fe742))
* **layout:** prevent playground horizontal overflow ([0142015](https://github.com/deepscrape/deepscrape/commit/0142015c139be73d5098581dd3d3815c1a5a93f4))
* **package:** root cause your repo’s root package.json includes ([0a20ebc](https://github.com/deepscrape/deepscrape/commit/0a20ebcf37a842e65a7994f36338445601ad39e2))
* **release:** correct GITHUB_TOKEN secret reference in release workflow ([48e2bad](https://github.com/deepscrape/deepscrape/commit/48e2badf37798bbc369a5902e91519982facde6a))
* **release:** update GH_TOKEN secret reference to GITHUB_TOKEN in release workflow ([79991a9](https://github.com/deepscrape/deepscrape/commit/79991a90e276eaff825af60ff97c251cc3b6ead9))
* **release:** update GITHUB_TOKEN secret reference to GH_TOKEN ([d9e233d](https://github.com/deepscrape/deepscrape/commit/d9e233d856701ddf3636b4f8c37e2c8830c6c334))
* **release:** update token references and add GitHub App token generation step ([2e683df](https://github.com/deepscrape/deepscrape/commit/2e683df0ae3343908da7029a59e41e7e7df1b10c))
* replace jest type with jasmine in tsconfig.json ([2399533](https://github.com/deepscrape/deepscrape/commit/23995336e50fdd79fa3b0959f89c7b601cf28e3a))
* **security:** harden provider linking and mfa flows ([ed67535](https://github.com/deepscrape/deepscrape/commit/ed6753506f354856ff848c3165c34c5a909aecca))
* **server:** update backend function configuration and add serviceAccount.json to .gitignore ([2569fdc](https://github.com/deepscrape/deepscrape/commit/2569fdc8b9a4610b2b8ff9017355e607178b1735))
* **tests:** add global test setup and suppress console.error messages ([4d97ea0](https://github.com/deepscrape/deepscrape/commit/4d97ea0a549ce52bdadca5be75b35533bb69389d))
* **tests:** add test Stripe publishable key to getTestProviders ([311944b](https://github.com/deepscrape/deepscrape/commit/311944b3ab7536ba0c11a9246b3a337191811e48))
* **tests:** address code review - add permissions to CI jobs and improve spec comments ([8e46995](https://github.com/deepscrape/deepscrape/commit/8e46995efd041671403d2016bc2c129fa5afb27e))
* **tests:** fix 26 failing Karma tests - Q2-Q4 implementation phase ([0bb2633](https://github.com/deepscrape/deepscrape/commit/0bb2633741f9cfc208007ba2df562f5a1e9876c2))
* **tests:** fix 3 remaining failing specs + add test CI workflow ([a23a1b1](https://github.com/deepscrape/deepscrape/commit/a23a1b10749becf9f1f82cc1483a28d073200d87))
* **tests:** fix CI build failure and upgrade failing Karma specs ([676731e](https://github.com/deepscrape/deepscrape/commit/676731ebd7b5081325eb94969a6abce9999638d0))
* **tests:** update CI test configuration and improve logging ([23a7fca](https://github.com/deepscrape/deepscrape/commit/23a7fcabf94f829792981929841c3976baa0be7b))
* **test:** use no-sandbox launcher for CI headless Chrome ([a624a8e](https://github.com/deepscrape/deepscrape/commit/a624a8e905d0d97090f9107a2d04533609643351))
* **verification:** clarify phone state and dedupe session metrics ([86bbd15](https://github.com/deepscrape/deepscrape/commit/86bbd15bafc60dc8686db4d5a0811daddd282564))
* **workflow:** update trigger to include push events for 'main' branch ([c99d202](https://github.com/deepscrape/deepscrape/commit/c99d202b8fd24432c3d7a493a70193784fb7f679))


### Features

* **admin/billing-observability:** billing health dashboard and checkout idempotency ([b3055b8](https://github.com/deepscrape/deepscrape/commit/b3055b8b7c690586cbab650f5559084913a1bcf2))
* **admin:** add project configuration workspace section ([b50b452](https://github.com/deepscrape/deepscrape/commit/b50b4520cb4e10dba730d51400da81052ddb9709))
* **analytics:** add realtime active-user presence metrics ([1502af9](https://github.com/deepscrape/deepscrape/commit/1502af9ded2151af29341dcede60c66c0b378530))
* **analytics:** add scheduled aggregation and summary-first reads ([d7927ae](https://github.com/deepscrape/deepscrape/commit/d7927aea01d66fad66974cc417ee31b217da9280))
* **auth:** bootstrap admin and cursor pagination ([f93e26d](https://github.com/deepscrape/deepscrape/commit/f93e26d8384505653441f512642691d58a139cf1))
* **auth:** harden session lifecycle and onboarding access ([8c6ca30](https://github.com/deepscrape/deepscrape/commit/8c6ca30fa27ffccbed6495d3e3b7e935c59da6d2))
* **authz:** add client authz guard and directive ([1ee0f8c](https://github.com/deepscrape/deepscrape/commit/1ee0f8ca16d09eb208719493fb1220f7fcf1ce52))
* **authz:** add invitation acceptance and member endpoints ([8ee42f0](https://github.com/deepscrape/deepscrape/commit/8ee42f03e675f2be8efab05f1bd1c0eb7c426993))
* **authz:** add org bootstrap in user layout ([b02e825](https://github.com/deepscrape/deepscrape/commit/b02e825809ed9ae5db60ad073819e6ab7d5ef5ff))
* **authz:** add organization api and client org service ([0a80946](https://github.com/deepscrape/deepscrape/commit/0a809463d858121a9ba7c8bc9e21620b121c8010))
* **authz:** add server-side rebac+abac enforcement slice ([56c798d](https://github.com/deepscrape/deepscrape/commit/56c798d4b85184eb393769d5ddc6851f127ac3e1))
* **authz:** add workspace settings management tab ([07519b4](https://github.com/deepscrape/deepscrape/commit/07519b47c2c2096df93852c3098e7973b84ec7f9))
* **authz:** implement production ReBAC+ABAC authorization architecture ([ad93612](https://github.com/deepscrape/deepscrape/commit/ad9361294da0a168030e83950e6424e1a93aa01d))
* **authz:** integrate angular rebac context handling ([2511304](https://github.com/deepscrape/deepscrape/commit/2511304d1c14847d039fa76133b280c6d3eb0ac1))
* **billing-ui:** add skeleton loading for usage report ([53c5e25](https://github.com/deepscrape/deepscrape/commit/53c5e251ae0fbfdb21febcc85206cca50740cdb2))
* **codebase:** add enterprise session management and device verification ([364df96](https://github.com/deepscrape/deepscrape/commit/364df96f50877347f2d6d7a0ed9fc86a9a5682ee))
* **functions/sessions:** server-side geo, admin callables, AppCheck ([778667c](https://github.com/deepscrape/deepscrape/commit/778667c20640e7f2b2d53858a06e11631bf69c71))
* **functions/stripe:** enforce appcheck, ssrf url validation, billing observability ([3618091](https://github.com/deepscrape/deepscrape/commit/3618091df9bc17cb27adf759d94445f19722aee1))
* **onboarding:** align plan picker with billing catalog ([f91cd2b](https://github.com/deepscrape/deepscrape/commit/f91cd2b739ac4c1a8ab697b52e03ddcfc944dc57))
* **org:** improve invitations and workspace management ([5ab06eb](https://github.com/deepscrape/deepscrape/commit/5ab06eb447dc4c5fb024ab61670c90f93c221557))
* **platform:** pr70 release - authz, enterprise sessions, billing, analytics, landing ([6699e12](https://github.com/deepscrape/deepscrape/commit/6699e121eb3cf328e86c0fe1cb54d40041e10756))
* **security:** harden api key deletion and reveal controls ([cea39cf](https://github.com/deepscrape/deepscrape/commit/cea39cf4b3c38df371195fe9fbd7b79db968882c)), closes [#codebase](https://github.com/deepscrape/deepscrape/issues/codebase)
* **ui/animations:** add listStaggerAnimation, polish PopupAnimation ([9626daa](https://github.com/deepscrape/deepscrape/commit/9626daa139a9f079dee270d76d65a2a6b741d314))
* **ui/skeleton:** structured skeleton loaders with shimmer sweep across components ([13b3836](https://github.com/deepscrape/deepscrape/commit/13b3836ac4ebadaf9bc1b29af8ea3d1c286d4812))

# [0.7.0-beta.7](https://github.com/deepscrape/deepscrape/compare/v0.7.0-beta.6...v0.7.0-beta.7) (2026-04-16)


### Bug Fixes

* **ci:** recreate release asset branches without stale LFS refs ([3e38477](https://github.com/deepscrape/deepscrape/commit/3e38477d018ec24b2dfe462c0bcb1d65c5b4c087))

## [0.6.2-beta.5](https://github.com/AntoniadisCorp/deepscrape/compare/v0.6.2-beta.4...v0.6.2-beta.5) (2026-03-19)


### Bug Fixes

* **tests:** fix CI build failure and upgrade failing Karma specs ([676731e](https://github.com/AntoniadisCorp/deepscrape/commit/676731ebd7b5081325eb94969a6abce9999638d0))
* **workflow:** update trigger to include push events for 'main' branch ([c99d202](https://github.com/AntoniadisCorp/deepscrape/commit/c99d202b8fd24432c3d7a493a70193784fb7f679))

## [0.6.2-beta.4](https://github.com/AntoniadisCorp/deepscrape/compare/v0.6.2-beta.3...v0.6.2-beta.4) (2026-03-19)


### Bug Fixes

* replace jest type with jasmine in tsconfig.json ([2399533](https://github.com/AntoniadisCorp/deepscrape/commit/23995336e50fdd79fa3b0959f89c7b601cf28e3a))
* **tests:** address code review - add permissions to CI jobs and improve spec comments ([8e46995](https://github.com/AntoniadisCorp/deepscrape/commit/8e46995efd041671403d2016bc2c129fa5afb27e))
* **tests:** fix 26 failing Karma tests - Q2-Q4 implementation phase ([0bb2633](https://github.com/AntoniadisCorp/deepscrape/commit/0bb2633741f9cfc208007ba2df562f5a1e9876c2))
* **tests:** fix 3 remaining failing specs + add test CI workflow ([a23a1b1](https://github.com/AntoniadisCorp/deepscrape/commit/a23a1b10749becf9f1f82cc1483a28d073200d87))

## [0.6.2-beta.3](https://github.com/AntoniadisCorp/deepscrape/compare/v0.6.2-beta.2...v0.6.2-beta.3) (2026-03-19)


### Bug Fixes

* **ci:** recreate release asset branches without stale LFS refs ([62a7910](https://github.com/AntoniadisCorp/deepscrape/commit/62a7910082fd4f59377ec356f11edcf122792a6f))

## [0.6.2-beta.1](https://github.com/AntoniadisCorp/deepscrape/compare/v0.6.1...v0.6.2-beta.1) (2026-03-18)


### Bug Fixes

* **build:** sync package-lock for npm ci ([0674ea3](https://github.com/AntoniadisCorp/deepscrape/commit/0674ea3b22bbde00415e7cd98ef5ff1041644280))
* **ci:** ensure hosting build runs for hosting-triggered deploys ([7d2a269](https://github.com/AntoniadisCorp/deepscrape/commit/7d2a2699585d4712c35ec3a6c6d663b5a5477337))
* **deps:** patch Angular packages and refresh lockfiles ([05c4318](https://github.com/AntoniadisCorp/deepscrape/commit/05c4318b18e879e4e2ada05c8d1bf6241cbd969f))

## [0.6.1-beta.2](https://github.com/AntoniadisCorp/deepscrape/compare/v0.6.1-beta.1...v0.6.1-beta.2) (2026-03-18)


### Bug Fixes

* **build:** sync package-lock for npm ci ([0674ea3](https://github.com/AntoniadisCorp/deepscrape/commit/0674ea3b22bbde00415e7cd98ef5ff1041644280))
* **ci:** ensure hosting build runs for hosting-triggered deploys ([7d2a269](https://github.com/AntoniadisCorp/deepscrape/commit/7d2a2699585d4712c35ec3a6c6d663b5a5477337))
* **deps:** patch Angular packages and refresh lockfiles ([05c4318](https://github.com/AntoniadisCorp/deepscrape/commit/05c4318b18e879e4e2ada05c8d1bf6241cbd969f))

## [0.6.1-beta.1](https://github.com/AntoniadisCorp/deepscrape/compare/v0.6.0...v0.6.1-beta.1) (2026-03-18)


### Bug Fixes

* **ci:** deploy functions on merge only for functions changes ([7ebcfe6](https://github.com/AntoniadisCorp/deepscrape/commit/7ebcfe6c1c69366c7e04e1e4a61b2d971a666b94))
* **ci:** prevent functions deploy ENOENT in PR workflow ([cbb1da5](https://github.com/AntoniadisCorp/deepscrape/commit/cbb1da534bc4b0090a9a931820bf2c06691fa837))
* **functions:** guard missing SSR index in cp-angular ([8607abf](https://github.com/AntoniadisCorp/deepscrape/commit/8607abf8c4398cbcad3d8ad46dac0edb017bd07e))

# [0.6.0-beta.5](https://github.com/AntoniadisCorp/deepscrape/compare/v0.6.0-beta.4...v0.6.0-beta.5) (2026-03-18)


### Bug Fixes

* **ci:** deploy functions on merge only for functions changes ([7ebcfe6](https://github.com/AntoniadisCorp/deepscrape/commit/7ebcfe6c1c69366c7e04e1e4a61b2d971a666b94))

# [0.6.0-beta.2](https://github.com/AntoniadisCorp/deepscrape/compare/v0.6.0-beta.1...v0.6.0-beta.2) (2026-03-17)


### Bug Fixes

* **ci:** use gcloud storage cp for IP2Location upload ([c762a73](https://github.com/AntoniadisCorp/deepscrape/commit/c762a73072bc359518bdde89128880d20eed1845))

## [0.5.2-beta.1](https://github.com/AntoniadisCorp/deepscrape/compare/v0.5.1...v0.5.2-beta.1) (2026-03-17)


### Bug Fixes

* **ci:** harden functions deploy analysis ([ed0757a](https://github.com/AntoniadisCorp/deepscrape/commit/ed0757ad597ef5544079b7005683a6879edc7061))
* **ci:** stabilize functions deploy env bootstrap ([4494da1](https://github.com/AntoniadisCorp/deepscrape/commit/4494da1dccb0b814aa75158676f59094a947b237))
* **config:** enable release links and simplify auth provider ([f3b0527](https://github.com/AntoniadisCorp/deepscrape/commit/f3b05276ac296e60f56ebdafc3edfe55a28a4bff))

## [0.5.1-beta.4](https://github.com/AntoniadisCorp/deepscrape/compare/v0.5.1-beta.3...v0.5.1-beta.4) (2026-03-15)


### Bug Fixes

* **ci:** stabilize functions deploy env bootstrap ([4494da1](https://github.com/AntoniadisCorp/deepscrape/commit/4494da1dccb0b814aa75158676f59094a947b237))

# [0.5.1-beta.1](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.13...v0.5.1-beta.1) (2026-03-15)

### Bug Fixes

* correct stray quotes and missing newlines in .env.example files ([a39e271](https://github.com/AntoniadisCorp/deepscrape/commit/a39e271))

# [0.4.0-beta.13](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.12...v0.4.0-beta.13) (2026-03-14)

### Features

* **codebase:** harden functions env and admin credential loading ([327d4ab](https://github.com/AntoniadisCorp/deepscrape/commit/327d4ab))

# [0.4.0-beta.12](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.11...v0.4.0-beta.12) (2026-03-13)

### Features

* add typed env config, analytics docs, and rate limiting (#codebase) ([8d6f428](https://github.com/AntoniadisCorp/deepscrape/commit/8d6f428))
* **analytics:** add real-time online tracking and enhance dashboard metrics ([db55189](https://github.com/AntoniadisCorp/deepscrape/commit/db55189)), closes [#34](https://github.com/AntoniadisCorp/deepscrape/issues/34)
* **auth:** add phone verification flows and csrf protection (#codebase) ([5957cd3](https://github.com/AntoniadisCorp/deepscrape/commit/5957cd3))
* **billing:** introduce full billing system with Stripe checkout, credit packs, and usage reporting ([3329734](https://github.com/AntoniadisCorp/deepscrape/commit/3329734))
* **codebase:** add admin analytics migration workspace and metric upgrades ([36ba6c7](https://github.com/AntoniadisCorp/deepscrape/commit/36ba6c7))
* **codebase:** harden migration workflows, analytics, and security plumbing ([585ca36](https://github.com/AntoniadisCorp/deepscrape/commit/585ca36))
* **codebase:** update workflows, versioning, and JSON parsing ([f23941f](https://github.com/AntoniadisCorp/deepscrape/commit/f23941f))
* **prompts:** add role plan agent prompt for ReBAC implementation ([4d2f12c](https://github.com/AntoniadisCorp/deepscrape/commit/4d2f12c))

### Bug Fixes

* update Node.js runtime to 22 and clean up environment variable files ([dd43bb3](https://github.com/AntoniadisCorp/deepscrape/commit/dd43bb3))
* update phoneNumber type to allow null values in Users interface ([efb8820](https://github.com/AntoniadisCorp/deepscrape/commit/efb8820))
* **firestore:** add index for migration_runs collection with status and startedAt fields ([f44738d](https://github.com/AntoniadisCorp/deepscrape/commit/f44738d))
* **security:** add Pixabay CDN to content security policy ([75243b9](https://github.com/AntoniadisCorp/deepscrape/commit/75243b9))

# [0.4.0-beta.11](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.10...v0.4.0-beta.11) (2025-11-29)

### Features

* **auth:** add robust user and admin management features ([f5fc987](https://github.com/AntoniadisCorp/deepscrape/commit/f5fc987))
* **auth:** implement internationalization and refactor user features ([ef959ed](https://github.com/AntoniadisCorp/deepscrape/commit/ef959ed))
* **firestore:** update csp and add firestore indexes ([8d5cc42](https://github.com/AntoniadisCorp/deepscrape/commit/8d5cc42))

# [0.4.0-beta.10](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.9...v0.4.0-beta.10) (2025-11-27)

### Bug Fixes

* **security:** add csrf protection, update dependencies, and correct csp domain ([166e251](https://github.com/AntoniadisCorp/deepscrape/commit/166e251))

# [0.4.0-beta.9](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.8...v0.4.0-beta.9) (2025-11-26)

### Features

* **auth:** add device fingerprint hash to login metrics ([620421b](https://github.com/AntoniadisCorp/deepscrape/commit/620421b))

# [0.4.0-beta.8](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.7...v0.4.0-beta.8) (2025-11-26)

### Features

* **analytics:** hash guest fingerprints for privacy ([0fdd119](https://github.com/AntoniadisCorp/deepscrape/commit/0fdd119))
* **platform:** update security, analytics, and UI components ([be3878e](https://github.com/AntoniadisCorp/deepscrape/commit/be3878e))

# [0.4.0-beta.7](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.6...v0.4.0-beta.7) (2025-11-23)

### Features

* **i18n:** implement i18n, custom image loader, logger service ([29c4e94](https://github.com/AntoniadisCorp/deepscrape/commit/29c4e94))
* **signup:** redesign signup component with enhanced UI and animations ([5579151](https://github.com/AntoniadisCorp/deepscrape/commit/5579151))

# [0.4.0-beta.6](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.5...v0.4.0-beta.6) (2025-11-19)


### Features

* **footer:** implement dynamic theme colors and enhance icon styling ([5486533](https://github.com/AntoniadisCorp/deepscrape/commit/54865333251ed497c0be7d156c7881e0f3c89f0f))

# [0.4.0-beta.5](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.4...v0.4.0-beta.5) (2025-11-19)


### Bug Fixes

* update background color in browser component and bump version to 0.4.0-beta.4 ([cde6646](https://github.com/AntoniadisCorp/deepscrape/commit/cde664652aa8bc206c7501d1a47a8ea5f810bba4))

# [0.4.0-beta.4](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.3...v0.4.0-beta.4) (2025-11-19)


### Features

* refactor API, landing page, and rate limiting ([3cb5e48](https://github.com/AntoniadisCorp/deepscrape/commit/3cb5e48713916ec13ebf65aaa441287be2bfaa1f))

# [0.4.0-beta.3](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.2...v0.4.0-beta.3) (2025-11-17)

### Bug Fixes
* **tooltip:** pass mouse event to onMouseEnter handler ([e29fe35](https://github.com/AntoniadisCorp/deepscrape/commit/e29fe3519e9b8d7e8be582f21d233c960b94cd88))

# [0.4.0-beta.2](https://github.com/AntoniadisCorp/deepscrape/compare/v0.4.0-beta.1...v0.4.0-beta.2) (2025-11-17)

### Bug Fixes

* **pr:** implement domain seeding, error logging, and client hydration ([f172ff9](https://github.com/AntoniadisCorp/deepscrape/commit/f172ff95aca27c073edd6e958e56479f0cc029e6))


# [0.3.0-beta.3](https://github.com/AntoniadisCorp/deepscrape/compare/v0.3.0-beta.2...v0.3.0-beta.3) (2025-11-17)

### Features

* **login:** make trackLoginAttempt method asynchronous for improved browser detection ([0be516d](https://github.com/AntoniadisCorp/deepscrape/commit/0be516dcdabb542a36686eb403486c2bb8179dcf))

# [0.3.0-beta.2](https://github.com/AntoniadisCorp/deepscrape/compare/v0.3.0-beta.1...v0.3.0-beta.2) (2025-11-17)

### Bug Fixes

* **angular:** add bootstrapcontext parameter to bootstrap function, to fix bootstrapcontext error ([ba12dfb](https://github.com/AntoniadisCorp/deepscrape/commit/ba12dfbf088750b8283ac740950c504f64a989c4))
* **api:** update endpoint paths for task management in crawl api service and seeding service ([6822d46](https://github.com/AntoniadisCorp/deepscrape/commit/6822d46b22815b89ad5b82218bd49b69cf04b8cd))
* **components:** fix dropdown functionality and improve snackbar visibility ([c57b0fc](https://github.com/AntoniadisCorp/deepscrape/commit/c57b0fc6c93381f9a970b3c485a4b84196262197))
* **config:** enable postcss-import plugin and comment out v4 tailwindcss import ([42c597c](https://github.com/AntoniadisCorp/deepscrape/commit/42c597cc3e9d54a25403ef3e71ad406ef739dcee))
* refactor Firebase configuration to use environment variables and improve secret management ([f60979c](https://github.com/AntoniadisCorp/deepscrape/commit/f60979c772181a5d3aa6b5a2da749134167492a5))
* update Angular SSR version and add loading bar dependencies ([c1d891a](https://github.com/AntoniadisCorp/deepscrape/commit/c1d891ae5d45a356b3815aa5ee42057825e406be))
* **deps:** update semantic-release and related packages to latest versions ([c45642b](https://github.com/AntoniadisCorp/deepscrape/commit/c45642b47caeaced9d3ead154be72fbd04c107f6))
* **machines:** enhance machineId validation and error handling ([1ce1bfd](https://github.com/AntoniadisCorp/deepscrape/commit/1ce1bfd2ca0a8874c098bfde41fd47639bfd5695))
* **package-lock:** fix version from v0.2.0-beta.2 to 0.2.0 ([3f351e9](https://github.com/AntoniadisCorp/deepscrape/commit/3f351e954152c7c2a808e676815a4d52f2085a8f))
* refactor Firebase configuration to use environment variables and improve secret management ([f60979c](https://github.com/AntoniadisCorp/deepscrape/commit/f60979c772181a5d3aa6b5a2da749134167492a5))
* **ui:** improve snackbar, buttons, scrollbar, and mixins ([4f563a1](https://github.com/AntoniadisCorp/deepscrape/commit/4f563a1b0d48ac8e0149d2fdd7140f5c1425e82f))
* update Angular SSR version and add loading bar dependencies ([c1d891a](https://github.com/AntoniadisCorp/deepscrape/commit/c1d891ae5d45a356b3815aa5ee42057825e406be))
* **workflow:** add npm cache directory setup and caching step ([77c066f](https://github.com/AntoniadisCorp/deepscrape/commit/77c066f7b997a9997a636855f5eb32315df2a88a))
* **workflow:** update dependency installation step to include npm install ([d8dc578](https://github.com/AntoniadisCorp/deepscrape/commit/d8dc5781e0042b683a1eeaa9ed82ba9b4e8cfb23))


### Features

* **components:** integrate websocket for task status updates and enhance operations management ([f1dda1f](https://github.com/AntoniadisCorp/deepscrape/commit/f1dda1ff6847cf613c745d636ffca9943c27a9dc))
* **crawlpack:** improve service pack and ui components for improved profile and config management ([ad3b126](https://github.com/AntoniadisCorp/deepscrape/commit/ad3b1265267a3d1fc4d2727388495c1a5285bb6e))
* **neko:** integrate Neko browser and WebRTC communication ([67105b9](https://github.com/AntoniadisCorp/deepscrape/commit/67105b957f78c5dab61ccebf1528ebe1903dcfc9))
* **seeder:** add seeder results component with new animations and loggerservice ([4300e76](https://github.com/AntoniadisCorp/deepscrape/commit/4300e768c3062d0a7c39fbf66a15c85556fb665c))
* **ui:** enhance tooltip component with animations and improved styling ([a85fa4f](https://github.com/AntoniadisCorp/deepscrape/commit/a85fa4fdee7c12feb6ef42af5a9f10cc1cee8e43))
* **account:** enhance security settings, user experience, user analytics, and icons ([f3709d0](https://github.com/AntoniadisCorp/deepscrape/commit/f3709d0af52c6bee97eb2af52527fb1faa635acc))
* **account:** implement user settings page with multiple tabs ([84c1731](https://github.com/AntoniadisCorp/deepscrape/commit/84c173181f7d9a559de93582d36ae9ca0b9b0c44))
* **account:** improve login session deduplication and device tracking ([9fe62c3](https://github.com/AntoniadisCorp/deepscrape/commit/9fe62c31f45d1299d45dbc856ba0ef9d47420b76))
* **api:** implement AuthAPIProxy and SyncAI API Proxy ([7143ee8](https://github.com/AntoniadisCorp/deepscrape/commit/7143ee8319b1d538d15adb78b99bee26d783d657))

# [0.3.0-beta.1](https://github.com/AntoniadisCorp/deepscrape/compare/v0.2.0...v0.3.0-beta.1) (2025-09-11)


### Bug Fixes

* **deps:** update semantic-release and related packages to latest versions ([c45642b](https://github.com/AntoniadisCorp/deepscrape/commit/c45642b47caeaced9d3ead154be72fbd04c107f6))
* **machines:** enhance machineId validation and error handling ([1ce1bfd](https://github.com/AntoniadisCorp/deepscrape/commit/1ce1bfd2ca0a8874c098bfde41fd47639bfd5695))
* **package-lock:** fix version from v0.2.0-beta.2 to 0.2.0 ([3f351e9](https://github.com/AntoniadisCorp/deepscrape/commit/3f351e954152c7c2a808e676815a4d52f2085a8f))
* **ui:** improve snackbar, buttons, scrollbar, and mixins ([4f563a1](https://github.com/AntoniadisCorp/deepscrape/commit/4f563a1b0d48ac8e0149d2fdd7140f5c1425e82f))
* **workflow:** add npm cache directory setup and caching step ([77c066f](https://github.com/AntoniadisCorp/deepscrape/commit/77c066f7b997a9997a636855f5eb32315df2a88a))
* **workflow:** update dependency installation step to include npm install ([d8dc578](https://github.com/AntoniadisCorp/deepscrape/commit/d8dc5781e0042b683a1eeaa9ed82ba9b4e8cfb23))


### Features

* **account:** enhance security settings, user experience, user analytics, and icons ([f3709d0](https://github.com/AntoniadisCorp/deepscrape/commit/f3709d0af52c6bee97eb2af52527fb1faa635acc))
* **account:** implement user settings page with multiple tabs ([84c1731](https://github.com/AntoniadisCorp/deepscrape/commit/84c173181f7d9a559de93582d36ae9ca0b9b0c44))
* **account:** improve login session deduplication and device tracking ([9fe62c3](https://github.com/AntoniadisCorp/deepscrape/commit/9fe62c31f45d1299d45dbc856ba0ef9d47420b76))
* **api:** implement AuthAPIProxy and SyncAI API Proxy ([7143ee8](https://github.com/AntoniadisCorp/deepscrape/commit/7143ee8319b1d538d15adb78b99bee26d783d657))


# [0.2.0-beta.1](https://github.com/AntoniadisCorp/deepscrape/compare/v0.1.2...v0.2.0-beta.1) (2025-08-18)


### Bug Fixes

* **changelog:** merge commit '00b15661f49433f12c93205bfeb661fb43b2f21c' ([7970f6c](https://github.com/AntoniadisCorp/deepscrape/commit/7970f6c6b7820f1fe73db912945c9c8411f459f6))
* **changelog:** remove version 1.0.1 details and reset for new release cycle ([eac8979](https://github.com/AntoniadisCorp/deepscrape/commit/eac897916383f880b825a186a95c488206c428f3))
* **changelog:** reset CHANGELOG.md for new release cycle ([b5414dd](https://github.com/AntoniadisCorp/deepscrape/commit/b5414ddb5dc9cb23d8a040fc647e4b04f8345317))
* **landpage:** update CORS settings, adjust image sizes, and refine layout positioning ([ca7d737](https://github.com/AntoniadisCorp/deepscrape/commit/ca7d737d51990b5fcc87ee4ce07a42f17595d681))
* **release:** add 'next' branch to push triggers and ensure fetch-tags is enabled ([671fb30](https://github.com/AntoniadisCorp/deepscrape/commit/671fb30d2fe118a5751ae9939edcf094a187836c))
* **release:** remove package-lock.json from assets and ensure GitHub release settings are configured ([bf1e4a7](https://github.com/AntoniadisCorp/deepscrape/commit/bf1e4a7eab06a19d0e09e163722009dee0681562))
* **server:** add rate limiting middleware to all routes ([e8f892d](https://github.com/AntoniadisCorp/deepscrape/commit/e8f892d5b57c35524b74e604cbb822914af75539))


### Features

* **authentication:** implement user signup and verification process with email and phone number ([3df1563](https://github.com/AntoniadisCorp/deepscrape/commit/3df1563e9f7de5211c6615cd896ea3fa6a3d100c))
* **payments:** enhance stripe customer and subscription management ([cb7ea6b](https://github.com/AntoniadisCorp/deepscrape/commit/cb7ea6b19441cdc7fdc87bbe06c6cb8046620250))




# [0.2.0](https://github.com/AntoniadisCorp/deepscrape/compare/v0.1.2...v0.2.0) (2025-08-18)


### Bug Fixes

* **changelog:** merge commit '00b15661f49433f12c93205bfeb661fb43b2f21c' ([7970f6c](https://github.com/AntoniadisCorp/deepscrape/commit/7970f6c6b7820f1fe73db912945c9c8411f459f6))
* **changelog:** remove version 1.0.1 details and reset for new release cycle ([eac8979](https://github.com/AntoniadisCorp/deepscrape/commit/eac897916383f880b825a186a95c488206c428f3))
* **changelog:** reset CHANGELOG.md for new release cycle ([b5414dd](https://github.com/AntoniadisCorp/deepscrape/commit/b5414ddb5dc9cb23d8a040fc647e4b04f8345317))
* **landpage:** update CORS settings, adjust image sizes, and refine layout positioning ([ca7d737](https://github.com/AntoniadisCorp/deepscrape/commit/ca7d737d51990b5fcc87ee4ce07a42f17595d681))
* **release:** add 'next' branch to push triggers and ensure fetch-tags is enabled ([671fb30](https://github.com/AntoniadisCorp/deepscrape/commit/671fb30d2fe118a5751ae9939edcf094a187836c))
* **release:** remove package-lock.json from assets and ensure GitHub release settings are configured ([bf1e4a7](https://github.com/AntoniadisCorp/deepscrape/commit/bf1e4a7eab06a19d0e09e163722009dee0681562))
* **server:** add rate limiting middleware to all routes ([e8f892d](https://github.com/AntoniadisCorp/deepscrape/commit/e8f892d5b57c35524b74e604cbb822914af75539))


### Features

* **authentication:** implement user signup and verification process with email and phone number ([3df1563](https://github.com/AntoniadisCorp/deepscrape/commit/3df1563e9f7de5211c6615cd896ea3fa6a3d100c))
* **payments:** enhance stripe customer and subscription management ([cb7ea6b](https://github.com/AntoniadisCorp/deepscrape/commit/cb7ea6b19441cdc7fdc87bbe06c6cb8046620250))

### 0.1.2 (2025-08-07)


### Features

* **actions:** add environment variables to firebase hosting pull request workflow and prod environment ([e860bfc](https://github.com/antoniadisCorp/deepscrape/commit/e860bfcb09a42e3d533e0aef72e174c9af4e8a28))
* **actions:** enhance environment configuration and deployment process ([186f0e8](https://github.com/antoniadisCorp/deepscrape/commit/186f0e8b8f313bb45615711684cca2568e294c3e))
* **actions:** improve firebase hosting pull request workflow ([e1da19a](https://github.com/antoniadisCorp/deepscrape/commit/e1da19aff46725c59c1989dece66fc6f8086e57a))
* **integration:** add firestore login and signup add jina api and llms extraction groq openai anthropic included 12 models ([9c05b09](https://github.com/antoniadisCorp/deepscrape/commit/9c05b0933114c19d3a0295b983d347b8afe65ced))
* **deployment:** add markdown styles, deployment variables, and new services; update modal and component styles ([dbb8c56](https://github.com/antoniadisCorp/deepscrape/commit/dbb8c566743a03075d5473014a0bdd21789e753a))
* **angularconfig:** increase maximum error size limit and add staging build configuration ([6b5ff9a](https://github.com/antoniadisCorp/deepscrape/commit/6b5ff9afcc077a775332dc8c7e7682cd885a8167))
* **api:** integrate AI service APIs and enhance server functionality ([509c8bf](https://github.com/antoniadisCorp/deepscrape/commit/509c8bf81c211ac07ac1c10e168af8b1ea854f8c))
* **assets:** remove unused logo SVGs, add page logo ([09b805f](https://github.com/antoniadisCorp/deepscrape/commit/09b805f6f6eb5682772b4bec38645519fac5d188))
* **ci-cd:** improve firebase deployment and code ownership ([d6fdb2a](https://github.com/antoniadisCorp/deepscrape/commit/d6fdb2ad01c73cff53a5c926601e3f9555a85342))
* **ci-cd:** Integrate Google Generative AI and update dependencies ([4de4644](https://github.com/antoniadisCorp/deepscrape/commit/4de4644102b0a654c0240a444e63c81a88342936))
* **ci:** add API keys as environment variables to Firebase PR workflow ([8d5d7aa](https://github.com/antoniadisCorp/deepscrape/commit/8d5d7aa17332f779e81afeeda1185fc9f4fde9ab))
* **ci:** add Node.js 20 setup to Firebase hosting workflow ([e0cb2e8](https://github.com/antoniadisCorp/deepscrape/commit/e0cb2e8e0c04ee40a0d6ead3d29b47fb50672075))
* **ci:** add Node.js 20 setup to Firebase hosting workflow ([c062401](https://github.com/antoniadisCorp/deepscrape/commit/c06240158757a9eda772ed60eb45f252556a60d3))
* **ci:** configure Firebase PR workflow with additional environment variables ([8afc9ed](https://github.com/antoniadisCorp/deepscrape/commit/8afc9edde3c0f7aa1d1f799a485aead903f921ed))
* **ci:** enhance Firebase Hosting PR workflow with debugging and base href ([8851f38](https://github.com/antoniadisCorp/deepscrape/commit/8851f38a4e17f04dabcce70b22bcfeeb5ac44e78))
* **ci:** install Angular CLI globally and update build command in Firebase workflow ([7b621e2](https://github.com/antoniadisCorp/deepscrape/commit/7b621e2fc487a5c5b375afbc902a6daa8b4a8fa3))
* **crawlpack:** enhance cart management, authentication, and configuration ([305888b](https://github.com/antoniadisCorp/deepscrape/commit/305888b1a3da9f0ce087c936e184387003991ac9))
* **crawlpack:** Enhance Crawl Configuration and Results Management ([a42ae48](https://github.com/antoniadisCorp/deepscrape/commit/a42ae4832b974f5cbd544fd7e0fca68e3c048b9f))
* **crawlpack:** enhance crawl pack functionality and UI ([58f0e75](https://github.com/antoniadisCorp/deepscrape/commit/58f0e7544f2c8df49b37b071ff6ff7bb0d1aa8bc))
* **crawlpack:** refine UI, enhance machine creation, and improve data handling ([eb0b8ae](https://github.com/antoniadisCorp/deepscrape/commit/eb0b8ae010b9d82a023b33fa8199735fdf1efcd7))
* **billing:** create billing plans, stripe integration, create payment intents customer on user creation startSubscription, usage, create api key secrets, retrieve api key paging, create visibility interaction for user to view the secret api key, add asidebar menu for small mobile tablet devices, create compoments: checkbox, slideinmodal, clipboard, update consent modal, api key component, tooltip, radiotoggle button, snackbar is now global, promtarea component, playground passes, route and more ([e89578e](https://github.com/antoniadisCorp/deepscrape/commit/e89578ec5214121af6be690fb796e14f48ca7ddb))
* **deps:** add ts-node as a dev dependency ([64d444a](https://github.com/antoniadisCorp/deepscrape/commit/64d444a81fc065713c1be6187d82b79fe5d91155))
* **docker:** enhance Docker image validation and UI/UX ([65b9b34](https://github.com/antoniadisCorp/deepscrape/commit/65b9b34b1c3e6786fb56371eb42db73cd872d900))
* **environment:** generate environment.ts from .env file ([f62fbab](https://github.com/antoniadisCorp/deepscrape/commit/f62fbabb1123db98fc374e42a5074f1982a41c39))
* **environment:** introduce staging environment and refactor production environment configuration ([8a1cd5b](https://github.com/antoniadisCorp/deepscrape/commit/8a1cd5b2781d68c80038c0377684e93e6f50c3dc))
* **environment:** use environment variable for Stripe public key in production ([59dff37](https://github.com/antoniadisCorp/deepscrape/commit/59dff37a38225700409ca67e72a2c1361294134f))
* **env:** simplify environment variable loading and update dependencies ([f38978e](https://github.com/antoniadisCorp/deepscrape/commit/f38978e5be8ca57a4ef590293cec579e5c5fee3d))
* **crawlpack:** Implement Crawl Pack and related components ([16fc627](https://github.com/antoniadisCorp/deepscrape/commit/16fc6275d44cdd9884b488f802976d6c52c1e99e))
* **landpage:** enhance UI with hero section, features, and dialog components ([1868331](https://github.com/antoniadisCorp/deepscrape/commit/1868331029969cddf33da44062986836aef3ecae))
* **machines:** enhance Docker image deployment and validation ([f98faf6](https://github.com/antoniadisCorp/deepscrape/commit/f98faf618a8032f136fa05be0f7c391951d1cc5a))
* **machines:** enhance machine management UI and functionality ([5ec93df](https://github.com/antoniadisCorp/deepscrape/commit/5ec93df69fedf21dd82cf11fa23abf6ee2e4d3c0))
* **playground:** Implement real-time crawl task status and cancellation ([6d9843a](https://github.com/antoniadisCorp/deepscrape/commit/6d9843a71d219c4513b60f69f5d6bff2699219f7))
* **rate-limiting:** implement Redis-backed rate limiting for API and server ([346da11](https://github.com/antoniadisCorp/deepscrape/commit/346da11185ed5b7df65ae89d5aa5207f77033059))
* **ssr:** enable server-side rendering and update environment configuration ([64b8dab](https://github.com/antoniadisCorp/deepscrape/commit/64b8daba6aa5e49c0c00f9077e5466c0cd1e18b5))
* **ssr:** enhance server-side rendering with Elysia and Angular SSR ([dc83381](https://github.com/antoniadisCorp/deepscrape/commit/dc833815e4cea7a2172d7e3942c5e45b1569b9c5))
* **ssr:** integrate Elysia.js for server-side rendering and improve caching ([a0cfbca](https://github.com/antoniadisCorp/deepscrape/commit/a0cfbca1599fc32ac5d311984a5128db8a2a6f6f))
* **ssr:** remove fileReplacements for prod environment ([b80725a](https://github.com/antoniadisCorp/deepscrape/commit/b80725a6152fd713d69e77d7f9a152ee5ca9618b))
* **ssr:** remove SSR-related configurations and update environment import ([1c3bde4](https://github.com/antoniadisCorp/deepscrape/commit/1c3bde45bc5927eec0f8c9babe5e680cf623f201))
* **ui:** enhance theme toggle, API key management, and app loading ([af8923a](https://github.com/antoniadisCorp/deepscrape/commit/af8923a39865e85e196894d0355227ced94d99b8))
* **ui:** Implement machine creation and Docker deployment UI ([a5c84d0](https://github.com/antoniadisCorp/deepscrape/commit/a5c84d0a147a98b9d82f814d45c39261a62c88a3))


### Bug Fixes

* **angular:** disable prod environment replacement and service worker ([b0a1493](https://github.com/antoniadisCorp/deepscrape/commit/b0a1493caa978f22e55b3488b1a981eb46ce6b73))
* backoff and revert important changes from stash on 18 march 2:00 AM - stash id: #b0c29f1 ([88c99cb](https://github.com/antoniadisCorp/deepscrape/commit/88c99cb946d34b15ee77f31bdf36c14369990215)), closes [#b0c29f1](https://github.com/antoniadisCorp/deepscrape/issues/b0c29f1)
* **build:** optimize staging build and enable SSR ([2124ac7](https://github.com/antoniadisCorp/deepscrape/commit/2124ac79f6f9e905648df96aec6f45f4ad75f9d5))
* **ci-cd:** ensure build runs prbuild before build in firebase-hosting-merge.yml ([c43a1ac](https://github.com/antoniadisCorp/deepscrape/commit/c43a1ac248f2333334fdd0c4609bffe36fa446ce))
* **ci,build:** streamline staging build process for PR deployments ([b844a8d](https://github.com/antoniadisCorp/deepscrape/commit/b844a8d9d503061464327f27a969ee036cdf5e34))
* **ci:** comment out angular build step in firebase workflow ([c0cd8bf](https://github.com/antoniadisCorp/deepscrape/commit/c0cd8bf7dd40eaa17bbe63ede2a9c11d183e0242))
* **ci:** correct environment for Firebase deploy and prod build ([091922e](https://github.com/antoniadisCorp/deepscrape/commit/091922efb72b2887a28881df60d92f92a6a18a69))
* **ci:** ensure production build before Firebase Hosting deploy ([8fb5850](https://github.com/antoniadisCorp/deepscrape/commit/8fb585090d44b24f346ddadc6df45f99df7d297a))
* **ci:** re-enable angular build and firebase deploy with functions entrypoint ([3e6829c](https://github.com/antoniadisCorp/deepscrape/commit/3e6829c85aeddfec8cec11983b49d65bee63f632))
* **ci:** re-enable angular build step in firebase workflow ([e51c13d](https://github.com/antoniadisCorp/deepscrape/commit/e51c13df8cf0a08b4b26bae4ce2002aa43e4cdf4))
* **ci:** remove base href for firebase hosting build ([99cd1a6](https://github.com/antoniadisCorp/deepscrape/commit/99cd1a64b89a46942755505817965bb560735bb2))
* **env:** correct typo in recaptcha key name in prod.ts ([f690d6d](https://github.com/antoniadisCorp/deepscrape/commit/f690d6d519a5019980b3df8336567385372317d4))
* **environment:** hardcode recaptcha key for production ([dbf39cd](https://github.com/antoniadisCorp/deepscrape/commit/dbf39cde1101dc499fada91ad7f6a66562cc601c))
* **environment:** set Crawl4AI API key from environment variable in production ([8ce3dc0](https://github.com/antoniadisCorp/deepscrape/commit/8ce3dc05a4229298e26c402c2dd1ce45e769994c))
* **environment:** use environment variables for API keys in production ([2fb8682](https://github.com/antoniadisCorp/deepscrape/commit/2fb8682dab6480b6402aca050bd917ad792a81d5))
* **functions:** handle undefined environment variables for Redis configuration ([e68f29e](https://github.com/antoniadisCorp/deepscrape/commit/e68f29e68f8c2d5c27e955ed82a6851b0cdc2ae8))
* **git:** correct tab swipe logic, update firebase deploy branch, add prod env ([c2e3a3e](https://github.com/antoniadisCorp/deepscrape/commit/c2e3a3edcf21fdd39ec21b9ff0a4c80242905253))
* **github-actions:** correct entry point for firebase deploy ([15ca53d](https://github.com/antoniadisCorp/deepscrape/commit/15ca53da90c2e4eebb36a6074045146a156a7e59))
* **package-lock:** implement extension update functionality ([0293084](https://github.com/antoniadisCorp/deepscrape/commit/029308441802a16e84a7e6445d706f95e1b9dc1c))
* **package-lock:** update package-lock.json to reflect version and dependency changes ([d906913](https://github.com/antoniadisCorp/deepscrape/commit/d906913a42554520ada6bfd43229499a53eaab96))
* README ([fbe4fbc](https://github.com/antoniadisCorp/deepscrape/commit/fbe4fbc499420fdd3684da5171352b60a2e2331b))
* **scripts:** use npm instead of bun for build in serve and deploy scripts ([5354096](https://github.com/antoniadisCorp/deepscrape/commit/5354096b945f52dfad897bb34bd6eef379e725e3))
* **scss:** modernize SCSS imports and adjust theme colors ([4ad2ea7](https://github.com/antoniadisCorp/deepscrape/commit/4ad2ea789123b6ff2e2c5b98ba73f5db95e211a8))
* **service-worker:** configure service worker for better caching and navigation ([0d0c882](https://github.com/antoniadisCorp/deepscrape/commit/0d0c882389ea864e7f01cea294963d85d59059e8))
* **ssr:** enable prerendering ([6595ada](https://github.com/antoniadisCorp/deepscrape/commit/6595ada0d220846fca175201c8c7a116d6b2ad91))
* **ssr:** enable server output mode for prerendering ([5eadf0a](https://github.com/antoniadisCorp/deepscrape/commit/5eadf0a2d40240738de6abccf6abfae065654185))
* **ssr:** enhance server-side rendering and API security ([72d3048](https://github.com/antoniadisCorp/deepscrape/commit/72d304806defa460ea857c34fbd9705187ea9840))
* **ssr:** integrate Arachnefly for machine deployment for production mode ([23b0f60](https://github.com/antoniadisCorp/deepscrape/commit/23b0f608fb14609f65e825cf1a332848532385cf))
* **ssr:** revert fileReplacements for prod environment ([a16dd02](https://github.com/antoniadisCorp/deepscrape/commit/a16dd021aff4f6faec17a2392de1c96a3fb5a0ae))
* **swipe-tabs:** correct tab swipe logic in tabs.component.ts ([c81ac73](https://github.com/antoniadisCorp/deepscrape/commit/c81ac731065267945ca6263edbffe9d93a02f03e))
* **tests:** Refactor and enhance core components and services ([9006f7e](https://github.com/antoniadisCorp/deepscrape/commit/9006f7e1dc1eefa6f5bac9cc0c2b746e4fe21f40))
* **tsconfig:** enable node types and update package version ([2e7fb5e](https://github.com/antoniadisCorp/deepscrape/commit/2e7fb5e366e71b6ab75e574688a2e66ba2889a29))
* **ui:** fix playground UI, improve code highlighting, and refine authentication guards ([e31e685](https://github.com/antoniadisCorp/deepscrape/commit/e31e6859beb67e7cee9c5cb79643545121cccefc))
* Update API_CRAWL4AI URL to crawlagent.fly.dev ([4492714](https://github.com/antoniadisCorp/deepscrape/commit/4492714a0761cf5ada0735c0fcf2b52c97f3c8ef))

## 0.1.1 (2025-08-07)

### Features

*   **angular:** re-enable prod environment replacement and service worker, add elysia ([5cda873](https://github.com/antoniadisCorp/deepscrape/commit/5cda873))
*   **api:** implement server-side API endpoints with Firebase JWT authentication ([7a11ec2](https://github.com/antoniadisCorp/deepscrape/commit/7a11ec2))
*   **firestore:** enhance Firestore service and functions for data management ([8ac1480](https://github.com/antoniadisCorp/deepscrape/commit/8ac1480))
*   **playground:** crawl results display and add crawl pack selection ([f27ba0b](https://github.com/antoniadisCorp/deepscrape/commit/f27ba0b))
*   **styles:** enhance UI theming and component styling ([bc9f372](https://github.com/antoniadisCorp/deepscrape/commit/bc9f372))


### Fix

*   Update API_CRAWL4AI URL to crawlagent.fly.dev ([4492714](https://github.com/antoniadisCorp/deepscrape/commit/4492714))
*   **readme:** README ([fbe4fbc](https://github.com/antoniadisCorp/deepscrape/commit/fbe4fbc))
*   backoff and revert important changes from stash on 18 march 2:00 AM - stash id: #b0c29f1 ([88c99cb](https://github.com/antoniadisCorp/deepscrape/commit/88c99cb)), closes [#b0c29f1](https://github.com/antoniadisCorp/deepscrape/issues/b0c29f1)
*   **angular:** disable prod environment replacement and service worker ([b0a1493](https://github.com/antoniadisCorp/deepscrape/commit/b0a1493))
*   **build:** optimize staging build and enable SSR ([2124ac7](https://github.com/antoniadisCorp/deepscrape/commit/2124ac7))
*   **ci-cd:** ensure build runs prbuild before build in firebase-hosting-merge.yml ([c43a1ac](https://github.com/antoniadisCorp/deepscrape/commit/c43a1ac))
*   **ci:** comment out angular build step in firebase workflow ([c0cd8bf](https://github.com/antoniadisCorp/deepscrape/commit/c0cd8bf))
*   **ci:** correct environment for Firebase deploy and prod build ([091922e](https://github.com/antoniadisCorp/deepscrape/commit/091922e))
*   **ci:** ensure production build before Firebase Hosting deploy ([8fb5850](https://github.com/antoniadisCorp/deepscrape/commit/8fb5850))
*   **ci:** re-enable angular build and firebase deploy with functions entrypoint ([3e6829c](https://github.com/antoniadisCorp/deepscrape/commit/3e6829c))
*   **ci:** re-enable angular build step in firebase workflow ([e51c13d](https://github.com/antoniadisCorp/deepscrape/commit/e51c13d))
*   **ci:** remove base href for firebase hosting build ([99cd1a6](https://github.com/antoniadisCorp/deepscrape/commit/99cd1a6))
*   **ci,build:** streamline staging build process for PR deployments ([b844a8d](https://github.com/antoniadisCorp/deepscrape/commit/b844a8d))
*   **env:** correct typo in recaptcha key name in prod.ts ([f690d6d](https://github.com/antoniadisCorp/deepscrape/commit/f690d6d))
*   **environment:** hardcode recaptcha key for production ([dbf39cd](https://github.com/antoniadisCorp/deepscrape/commit/dbf39cd))
*   **environment:** set Crawl4AI API key from environment variable in production ([8ce3dc0](https://github.com/antoniadisCorp/deepscrape/commit/8ce3dc0))
*   **environment:** use environment variables for API keys in production ([2fb8682](https://github.com/antoniadisCorp/deepscrape/commit/2fb8682))
*   **functions:** handle undefined environment variables for Redis configuration ([e68f29e](https://github.com/antoniadisCorp/deepscrape/commit/e68f29e))
*   **git:** correct tab swipe logic, update firebase deploy branch, add prod env ([c2e3a3e](https://github.com/antoniadisCorp/deepscrape/commit/c2e3a3e))
*   **github-actions:** correct entry point for firebase deploy ([15ca53d](https://github.com/antoniadisCorp/deepscrape/commit/15ca53d))
*   **package-lock:** implement extension update functionality ([0293084](https://github.com/antoniadisCorp/deepscrape/commit/0293084))
*   **package-lock:** update package-lock.json to reflect version and dependency changes ([d906913](https://github.com/antoniadisCorp/deepscrape/commit/d906913))
*   **scripts:** use npm instead of bun for build in serve and deploy scripts ([5354096](https://github.com/antoniadisCorp/deepscrape/commit/5354096))
*   **scss:** modernize SCSS imports and adjust theme colors ([4ad2ea7](https://github.com/antoniadisCorp/deepscrape/commit/4ad2ea7))
*   **service-worker:** configure service worker for better caching and navigation ([0d0c882](https://github.com/antoniadisCorp/deepscrape/commit/0d0c882))
*   **ssr:** enable prerendering ([6595ada](https://github.com/antoniadisCorp/deepscrape/commit/6595ada))
*   **ssr:** enable server output mode for prerendering ([5eadf0a](https://github.com/antoniadisCorp/deepscrape/commit/5eadf0a))
*   **ssr:** enhance server-side rendering and API security ([72d3048](https://github.com/antoniadisCorp/deepscrape/commit/72d3048))
*   **ssr:** integrate Arachnefly for machine deployment for production mode ([23b0f60](https://github.com/antoniadisCorp/deepscrape/commit/23b0f60))
*   **ssr:** revert fileReplacements for prod environment ([a16dd02](https://github.com/antoniadisCorp/deepscrape/commit/a16dd02))
*   **swipe-tabs:** correct tab swipe logic in tabs.component.ts ([c81ac73](https://github.com/antoniadisCorp/deepscrape/commit/c81ac73))
*   **tests:** Refactor and enhance core components and services ([9006f7e](https://github.com/antoniadisCorp/deepscrape/commit/9006f7e))
*   **tsconfig:** enable node types and update package version ([2e7fb5e](https://github.com/antoniadisCorp/deepscrape/commit/2e7fb5e))
*   **ui:** fix playground UI, improve code highlighting, and refine authentication guards ([e31e685](https://github.com/antoniadisCorp/deepscrape/commit/e31e685))
