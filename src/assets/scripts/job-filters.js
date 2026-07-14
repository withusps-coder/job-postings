const form = document.querySelector("[data-job-filters]");
const count = document.querySelector("[data-result-count]");
const empty = document.querySelector("[data-empty-state]");

if (
  form instanceof HTMLFormElement &&
  count instanceof HTMLElement &&
  empty instanceof HTMLElement
) {
  const qControl = form.elements.namedItem("q");
  const categoryControl = form.elements.namedItem("category");
  const companyControl = form.elements.namedItem("company");
  const cards = [...document.querySelectorAll("[data-job-card]")].filter(
    (card) => card instanceof HTMLElement,
  );

  if (
    qControl instanceof HTMLInputElement &&
    categoryControl instanceof HTMLSelectElement &&
    companyControl instanceof HTMLSelectElement
  ) {
    const readState = () => {
      const query = new URLSearchParams(window.location.search);
      return {
        q: query.get("q")?.trim() ?? "",
        category: query.get("category") ?? "",
        company: query.get("company") ?? "",
      };
    };

    const stateFromControls = () => ({
      q: qControl.value.trim(),
      category: categoryControl.value,
      company: companyControl.value,
    });

    /** @param {{ q: string, category: string, company: string }} state */
    const pushUrl = (state) => {
      const query = new URLSearchParams();
      if (state.q) query.set("q", state.q);
      if (state.category) query.set("category", state.category);
      if (state.company) query.set("company", state.company);
      const url = query.size > 0 ? `/?${query.toString()}` : "/";
      window.history.pushState({ filters: state }, "", url);
    };

    /** @param {{ q: string, category: string, company: string }} state */
    const applyState = (state) => {
      qControl.value = state.q;
      categoryControl.value = state.category;
      companyControl.value = state.company;
      const keyword = state.q.toLocaleLowerCase("ko-KR");
      let visible = 0;
      for (const card of cards) {
        const matches =
          (!keyword || card.dataset["keywords"]?.includes(keyword)) &&
          (!state.category || card.dataset["category"] === state.category) &&
          (!state.company || card.dataset["company"] === state.company);
        card.hidden = !matches;
        if (matches) visible += 1;
      }
      count.textContent = String(visible);
      empty.hidden = visible !== 0;
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const state = stateFromControls();
      pushUrl(state);
      applyState(state);
    });

    document
      .querySelector("[data-reset-filters]")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        const state = { q: "", category: "", company: "" };
        pushUrl(state);
        applyState(state);
        qControl.focus();
      });

    window.addEventListener("popstate", () => applyState(readState()));
    applyState(readState());
  }
}
