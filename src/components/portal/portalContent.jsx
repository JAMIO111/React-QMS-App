/** The centred column the portal's content pages (the dashboard, a shared record, a SCAR) sit in; registers fill the page instead. */
export default function Content({ children }) {
  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">{children}</div>;
}
