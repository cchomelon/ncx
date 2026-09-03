/**
 * The Save PNG form.
 *
 * Native `<dialog>`: it brings the modal backdrop, focus trap, Escape-to-close
 * and `aria-modal` with it, so none of that is written here.
 *
 * The export is a faithful scaled copy of the panel on screen -- the width and
 * resolution below decide the physical size of that copy, and nothing is
 * re-laid-out. The lettering fields override only the words, and accept the
 * LaTeX subset in `mathtext.ts`.
 */
import { useEffect, useRef, useState } from "react";

import {
  DPI_CHOICES,
  WIDTHS_MM,
  defaultExportOptions,
  exportPlotPng,
  type ExportOptions,
} from "./export";
import { mathToText } from "./mathtext";

export function SaveDialog({
  name,
  onClose,
  onError,
}: {
  name: string;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<ExportOptions>(defaultExportOptions);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setBusy(true);
    try {
      await exportPlotPng(name, options);
      onClose();
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog className="save-dialog" ref={dialog} onClose={onClose}>
      <form method="dialog" onSubmit={(event) => event.preventDefault()}>
        <h2>Save figure</h2>

        <fieldset>
          <legend>Width</legend>
          <div className="chip-row">
            {WIDTHS_MM.map((millimetres) => (
              <label key={millimetres} className="chip">
                <input
                  type="radio"
                  name="width"
                  checked={options.widthMm === millimetres}
                  onChange={() => set("widthMm", millimetres)}
                />
                {millimetres} mm
              </label>
            ))}
            <label className="chip custom">
              <input
                type="number"
                min={20}
                max={1000}
                step={1}
                value={options.widthMm}
                aria-label="Custom width in millimetres"
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0) set("widthMm", value);
                }}
              />
              mm
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Resolution</legend>
          <div className="chip-row">
            {DPI_CHOICES.map((dpi) => (
              <label key={dpi} className="chip">
                <input
                  type="radio"
                  name="dpi"
                  checked={options.dpi === dpi}
                  onChange={() => set("dpi", dpi)}
                />
                {dpi} dpi
              </label>
            ))}
          </div>
          <p className="hint">
            {Math.round((options.widthMm / 25.4) * options.dpi)} px wide
          </p>
        </fieldset>

        <label className="field">
          Title
          <input value={options.title} onChange={(event) => set("title", event.target.value)} />
        </label>
        <label className="field">
          Subtitle
          <input
            value={options.subtitle}
            onChange={(event) => set("subtitle", event.target.value)}
          />
        </label>
        <label className="field">
          X axis
          <input value={options.xTitle} onChange={(event) => set("xTitle", event.target.value)} />
        </label>
        <label className="field">
          Y axis
          <input value={options.yTitle} onChange={(event) => set("yTitle", event.target.value)} />
        </label>
        <p className="hint">
          {"Accepts ^{ } _{ } and \\alpha \\times \\degree — "}
          <span className="preview">{mathToText(options.yTitle) || "…"}</span>
        </p>

        <div className="dialog-actions">
          <button type="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
