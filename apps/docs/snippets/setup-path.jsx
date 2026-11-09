// The six-step strip at the top of every Get started page. Styles in
// /style.css (.dm-path). The pages and their order are docs.json's. Links
// are relative (./<page>): the docs live under demoman.io/docs, and a
// root-relative href in a snippet is not rewritten to that base path.
export const SetupPath = ({ step }) => {
  const steps = [
    { label: "Install", page: "install" },
    { label: "Connect", page: "connect" },
    { label: "First video", page: "first-video" },
    { label: "Sign in", page: "sign-in" },
    { label: "Add to repo", page: "add-to-repo" },
    { label: "CI", page: "ci" },
  ];
  return (
    <nav aria-label="Setup steps" className="dm-path not-prose">
      <ol>
        {steps.map((s, i) => {
          const n = i + 1;
          const state = n < step ? "done" : n === step ? "current" : "next";
          return (
            <li key={s.page} className={`dm-${state}`}>
              <a href={`./${s.page}`} aria-current={n === step ? "step" : undefined}>
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
