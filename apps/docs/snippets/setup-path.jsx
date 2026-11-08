// The six-step strip at the top of every Get started page. Styles in
// /style.css (.dm-path). The pages and their order are docs.json's.
export const SetupPath = ({ step }) => {
  const steps = [
    { label: "Install", href: "/get-started/install" },
    { label: "Connect", href: "/get-started/connect" },
    { label: "First video", href: "/get-started/first-video" },
    { label: "Sign in", href: "/get-started/sign-in" },
    { label: "Add to repo", href: "/get-started/add-to-repo" },
    { label: "CI", href: "/get-started/ci" },
  ];
  return (
    <nav aria-label="Setup steps" className="dm-path not-prose">
      <ol>
        {steps.map((s, i) => {
          const n = i + 1;
          const state = n < step ? "done" : n === step ? "current" : "next";
          return (
            <li key={s.href} className={`dm-${state}`}>
              <a href={s.href} aria-current={n === step ? "step" : undefined}>
                <span className="dm-path-n">
                  {String(n).padStart(2, "0")}
                  {n < step ? " ✓" : ""}
                </span>
                {s.label}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
