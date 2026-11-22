// Build-time switches for the tropical page (design.md 7.7, 11f F1).
// VITE_TROPICAL_MODEL_LAYERS=off removes the numerical-model layers: no model section, no
// request under data/tropical/models/, no NOAA/ECMWF attribution lines. Anything else (or unset)
// keeps them; each model layer still starts switched off. To disable them on the live site
// without touching the publishing workflow, change the default below and commit.
export const MODEL_LAYERS_ENABLED = import.meta.env.VITE_TROPICAL_MODEL_LAYERS !== "off";

// VITE_TROPICAL_ENSEMBLE_LAYERS=off removes the Ensemble (spaghetti) layers the same way
// (design.md 11h H7): no Ensemble section and no request under data/tropical/ensemble/.
// Independent of the deterministic switch, so either can be withdrawn on its own.
export const ENSEMBLE_LAYERS_ENABLED = import.meta.env.VITE_TROPICAL_ENSEMBLE_LAYERS !== "off";
