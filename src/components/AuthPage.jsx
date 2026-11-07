import { Outlet } from "react-router-dom";
import Logo from "../assets/fortress-qms.png";
import BrandPanel from "./auth/BrandPanel";

/**
 * Sign-in family of pages (login, sign-up, password reset, set password, two-factor): the form on
 * the left with the Fortress QMS name, and the brand panel on the right on larger screens.
 */
const AuthPage = () => (
  // The window never scrolls: the form column scrolls on its own and the brand panel stays put.
  <div className="grid h-dvh w-full grid-rows-[minmax(0,1fr)] overflow-clip bg-primary-bg lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
    <section className="min-h-0 overflow-y-auto">
      <div className="flex min-h-full flex-col px-6 py-6 sm:px-12">
      <header className="flex items-center gap-3">
        <img src={Logo} alt="" className="h-10 w-10 rounded-xl" />
        <span className="text-xl font-semibold tracking-tight text-primary-text">
          Fortress <span className="text-[var(--fortress-accent)]">QMS</span>
        </span>
      </header>
      <main className="flex flex-1 items-center justify-center py-10">
        <div className="w-full max-w-md">
          <Outlet />
        </div>
      </main>
      <footer className="flex flex-wrap justify-between gap-2 text-xs text-secondary-text">
        <span>© {new Date().getFullYear()} Fortress QMS</span>
        <span>Quality management for manufacturing</span>
      </footer>
      </div>
    </section>
    <BrandPanel />
  </div>
);

export default AuthPage;
