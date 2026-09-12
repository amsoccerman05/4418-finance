# IMPULSE shell convention

SuiteHeader.tsx/.css and AuthSurface.tsx/.css are identical across the four repositories; change them together. AuthSurface contains only neutral identity/loading or the Hub authentication form. Confirmed signed-out external sessions replace location with https://team.frc4418.org/ without return context. Session uncertainty never renders protected content. Existing broker clients own sessions and logout.

SuiteHeader is authenticated-only, uses the caller's display name and existing sign-out callback, and owns the logo, switcher, context and account controls. App-specific controls belong below it. Desktop height is 76px; phone height is 68px. Sidebars begin below it. No new shared package or auth persistence is introduced.

Hub password reset uses the existing broker resetPasswordForEmail/updateUser methods with its canonical callback. Legacy Inventory recovery callbacks remain neutral and supported. Local development demos are test/development-only and never exposed in production.
